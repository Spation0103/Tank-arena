import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { AddressInfo } from "node:net";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";
import { z } from "zod";
import type { Logger as PinoLogger } from "pino";
import { SERVER_DT } from "../shared/physics.js";
import {
  decodeInputPacket,
  encodeSnapshotJson,
  encodeSnapshotPacket,
  parseClientMessage,
} from "../shared/protocol.js";
import type { ClientMessage } from "../shared/protocol.js";
import { asEntityId, asInputSequence } from "../shared/types.js";
import type {
  EntityId,
  InputSequence,
  PartialPlayerInput,
  SimulationSnapshot,
} from "../shared/types.js";
import { readConfig } from "./config.js";
import type { ServerConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { RoomLimitError, RoomManager } from "./rooms.js";
import type { RoomClient } from "./rooms.js";
import { withinRateLimit } from "./rate-limit.js";

const MIME_TYPES = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".wav", "audio/wav"],
]);
const CreateRoomSchema = z
  .object({
    name: z.string(),
    maxPlayers: z.number().int().optional(),
  })
  .strict();
const bootstrapLogger = createLogger("info", "development");

interface GameServerOptions {
  readonly logger?: Pick<PinoLogger, "error" | "warn" | "info">;
  readonly onStep?: (sample: {
    readonly roomId: string;
    readonly players: number;
    readonly durationMs: number;
  }) => void;
}

interface ServerClient extends RoomClient {
  readonly id: EntityId;
  readonly socket: WebSocket;
  roomId: string | null;
  protocol: "json" | "binary";
  input: PartialPlayerInput;
  lastInputSeq: InputSequence;
  messagesThisSecond: number;
  rateWindowStarted: number;
  readonly clientIp: string;
  sendState(snapshot: SimulationSnapshot): boolean;
  send(encoded: string | ArrayBuffer): boolean;
}

class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createGameServer(
  config: ServerConfig = readConfig(),
  {
    logger = createLogger(config.logLevel, config.buildSha),
    onStep,
  }: GameServerOptions = {},
) {
  const rooms = new RoomManager(config.logDirectory, undefined, {
    maxRooms: config.maxRooms,
    maxPlayersPerRoom: config.maxPlayersPerRoom,
    logger,
  });
  const sockets = new Set<ServerClient>();
  const connectionsByIp = new Map<string, number>();
  const joinTimers = new Map<ServerClient, NodeJS.Timeout>();
  const missedPongs = new Map<ServerClient, number>();
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
  const metrics = {
    messages: 0,
    bytesReceived: 0,
    bytesSent: 0,
    steps: 0,
    lastStepMs: 0,
    totalStepMs: 0,
  };
  let metricsWindowStartedAt = performance.now();
  let lastEventLoopUtilization = performance.eventLoopUtilization();
  const buildSha = config.buildSha;
  let stopping = false;
  let acceptingConnections = true;

  const server = createServer((request, response) => {
    void handleHttp(request, response).catch((error: unknown) => {
      logger.error(
        { err: error, method: request.method, url: request.url },
        "HTTP handler error",
      );
      if (!response.headersSent) {
        const status = error instanceof HttpStatusError ? error.status : 500;
        const message =
          error instanceof Error ? error.message : "Internal Server Error";
        sendJson(response, status, { error: message });
      } else {
        response.destroy(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  });
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxPayloadBytes,
    perMessageDeflate: false,
  });
  server.on("error", (error) =>
    logger.error({ err: error }, "HTTP server error"),
  );
  websocketServer.on("error", (error) =>
    logger.error({ err: error }, "WebSocket server error"),
  );

  server.on("upgrade", (request, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/ws" || stopping) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) {
      logger.warn(
        { origin, ip: clientIp(request, config.trustProxy) },
        "Rejected WebSocket origin",
      );
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const ip = clientIp(request, config.trustProxy);
    if ((connectionsByIp.get(ip) ?? 0) >= config.maxConnectionsPerIp) {
      logger.warn({ ip }, "WebSocket IP connection limit exceeded");
      socket.write(
        "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      connectionsByIp.set(ip, (connectionsByIp.get(ip) ?? 0) + 1);
      websocket.once("close", () => {
        const remaining = (connectionsByIp.get(ip) ?? 1) - 1;
        if (remaining > 0) connectionsByIp.set(ip, remaining);
        else connectionsByIp.delete(ip);
      });
      websocketServer.emit("connection", websocket, request);
    });
  });

  websocketServer.on("connection", (socket, request) => {
    const ip = clientIp(request, config.trustProxy);
    const client: ServerClient = {
      id: asEntityId(randomUUID()),
      clientIp: ip,
      socket,
      roomId: null,
      protocol: "json",
      input: {},
      lastInputSeq: asInputSequence(0),
      messagesThisSecond: 0,
      rateWindowStarted: Date.now(),
      send(encoded) {
        if (
          this.socket.readyState !== WebSocket.OPEN ||
          this.socket.bufferedAmount > config.maxBufferedBytes
        ) {
          return false;
        }
        metrics.bytesSent +=
          typeof encoded === "string"
            ? Buffer.byteLength(encoded)
            : encoded.byteLength;
        this.socket.send(encoded, (error?: Error) => {
          if (error)
            logger.warn(
              { err: error, playerId: this.id },
              "WebSocket send failed",
            );
        });
        return true;
      },
      sendState(snapshot) {
        return this.send(
          this.protocol === "binary"
            ? encodeSnapshotPacket(snapshot, this.id)
            : JSON.stringify(encodeSnapshotJson(snapshot, this.id)),
        );
      },
    };
    sockets.add(client);
    missedPongs.set(client, 0);
    joinTimers.set(
      client,
      setTimeout(() => {
        closeSocket(socket, 1008, "Join required within 5 seconds");
      }, config.joinTimeoutMs),
    );

    socket.on("pong", () => missedPongs.set(client, 0));
    socket.on("message", (raw, isBinary) => {
      metrics.messages += 1;
      metrics.bytesReceived += toBuffer(raw).byteLength;
      if (isBinary) {
        if (!client.roomId || client.protocol !== "binary") {
          closeSocket(socket, 1003, "Binary protocol was not negotiated");
          return;
        }
        if (!withinRateLimit(client, config.maxMessagesPerSecond)) {
          closeSocket(socket, 1013, "Message rate limit exceeded");
          return;
        }
        try {
          const packet = decodeInputPacket(toBuffer(raw));
          rooms
            .get(client.roomId)
            ?.setInput(client.id, packet.input, packet.sequence);
        } catch (error: unknown) {
          logger.warn(
            { err: error, playerId: client.id, roomId: client.roomId },
            "Invalid binary input",
          );
          closeSocket(socket, 1007, "Invalid input packet");
        }
        return;
      }
      if (!withinRateLimit(client, config.maxMessagesPerSecond)) {
        closeSocket(socket, 1013, "Message rate limit exceeded");
        return;
      }
      const parsed = parseClientMessage(toBuffer(raw).toString("utf8"));
      if (!parsed.success) {
        logger.warn(
          { playerId: client.id, roomId: client.roomId, reason: parsed.reason },
          "Rejected WebSocket message",
        );
        closeSocket(
          socket,
          parsed.reason === "invalid-json" ? 1007 : 1008,
          parsed.reason === "invalid-json"
            ? "Invalid JSON"
            : "Invalid client message",
        );
        return;
      }
      if (
        (client.roomId === null && parsed.data.type !== "join") ||
        (client.roomId !== null && parsed.data.type === "join")
      ) {
        logger.warn(
          {
            playerId: client.id,
            roomId: client.roomId,
            messageType: parsed.data.type,
          },
          "Unexpected WebSocket message",
        );
        closeSocket(socket, 1008, "Message not allowed in current room state");
        return;
      }
      handleMessage(client, parsed.data);
    });
    socket.on("close", (_code, reason) => {
      clearClient(client);
      rooms.leave(client.id, reason.toString() || "disconnect");
    });
    socket.on("error", (error) => {
      logger.warn(
        { err: error, playerId: client.id, roomId: client.roomId },
        "WebSocket client error",
      );
      clearClient(client);
      rooms.leave(client.id, "socket error");
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of sockets) {
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      const missed = missedPongs.get(client) ?? 0;
      if (missed >= 2) {
        closeSocket(client.socket, 1001, "Heartbeat timeout");
        client.socket.terminate();
        continue;
      }
      missedPongs.set(client, missed + 1);
      client.socket.ping();
    }
  }, config.pingIntervalMs);
  heartbeat.unref();

  let gameTimer: NodeJS.Timeout | null = null;
  let nextGameStep = performance.now() + SERVER_DT * 1000;
  function scheduleGameStep(): void {
    if (stopping) return;
    gameTimer = setTimeout(
      () => {
        for (const room of rooms.rooms.values()) {
          if (room.size === 0) continue;
          const stepStarted = performance.now();
          const snapshot = room.step();
          onStep?.({
            roomId: room.id,
            players: room.size,
            durationMs: performance.now() - stepStarted,
          });
          metrics.steps += 1;
          metrics.lastStepMs = performance.now() - stepStarted;
          metrics.totalStepMs += metrics.lastStepMs;
          for (const member of room.members.values()) {
            member.client.sendState(snapshot);
          }
        }
        const now = performance.now();
        nextGameStep += SERVER_DT * 1000;
        if (nextGameStep < now - SERVER_DT * 1000) nextGameStep = now;
        scheduleGameStep();
      },
      Math.max(0, nextGameStep - performance.now()),
    );
  }
  scheduleGameStep();

  function clearClient(client: ServerClient): void {
    const joinTimer = joinTimers.get(client);
    if (joinTimer) clearTimeout(joinTimer);
    joinTimers.delete(client);
    sockets.delete(client);
    missedPongs.delete(client);
  }

  function sendMetrics(response: ServerResponse): void {
    const now = performance.now();
    const elapsedSeconds = Math.max(
      0.001,
      (now - metricsWindowStartedAt) / 1000,
    );
    metricsWindowStartedAt = now;
    const eventLoopUtilization = performance.eventLoopUtilization(
      lastEventLoopUtilization,
    );
    lastEventLoopUtilization = performance.eventLoopUtilization();
    const memory = process.memoryUsage();
    const lines = [
      "# HELP tank_arena_players Current connected players.",
      "# TYPE tank_arena_players gauge",
      `tank_arena_players ${[...rooms.rooms.values()].reduce((total, room) => total + room.size, 0)}`,
      "# HELP tank_arena_rooms Current rooms.",
      "# TYPE tank_arena_rooms gauge",
      `tank_arena_rooms ${rooms.rooms.size}`,
      "# HELP tank_arena_messages_per_second Messages received since previous scrape per second.",
      "# TYPE tank_arena_messages_per_second gauge",
      `tank_arena_messages_per_second ${(metrics.messages / elapsedSeconds).toFixed(3)}`,
      "# HELP tank_arena_bytes_received_per_second Bytes received since previous scrape per second.",
      "# TYPE tank_arena_bytes_received_per_second gauge",
      `tank_arena_bytes_received_per_second ${(metrics.bytesReceived / elapsedSeconds).toFixed(3)}`,
      "# HELP tank_arena_bytes_sent_per_second Bytes sent since previous scrape per second.",
      "# TYPE tank_arena_bytes_sent_per_second gauge",
      `tank_arena_bytes_sent_per_second ${(metrics.bytesSent / elapsedSeconds).toFixed(3)}`,
      "# HELP tank_arena_step_duration_ms Most recent room simulation step duration.",
      "# TYPE tank_arena_step_duration_ms gauge",
      `tank_arena_step_duration_ms ${metrics.lastStepMs.toFixed(3)}`,
      "# HELP tank_arena_step_duration_avg_ms Average room simulation step duration.",
      "# TYPE tank_arena_step_duration_avg_ms gauge",
      `tank_arena_step_duration_avg_ms ${(metrics.steps ? metrics.totalStepMs / metrics.steps : 0).toFixed(3)}`,
      "# HELP tank_arena_event_loop_utilization Event loop utilization since the previous scrape.",
      "# TYPE tank_arena_event_loop_utilization gauge",
      `tank_arena_event_loop_utilization ${eventLoopUtilization.utilization.toFixed(6)}`,
      "# HELP tank_arena_event_loop_delay_p99_ms Event loop delay p99.",
      "# TYPE tank_arena_event_loop_delay_p99_ms gauge",
      `tank_arena_event_loop_delay_p99_ms ${(eventLoopDelay.percentile(99) / 1e6).toFixed(3)}`,
      "# HELP tank_arena_process_resident_memory_bytes Process resident memory.",
      "# TYPE tank_arena_process_resident_memory_bytes gauge",
      `tank_arena_process_resident_memory_bytes ${memory.rss}`,
      "# HELP tank_arena_process_heap_used_bytes Process heap used.",
      "# TYPE tank_arena_process_heap_used_bytes gauge",
      `tank_arena_process_heap_used_bytes ${memory.heapUsed}`,
    ];
    metrics.messages = 0;
    metrics.bytesReceived = 0;
    metrics.bytesSent = 0;
    response.writeHead(200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "content-length": Buffer.byteLength(`${lines.join("\n")}\n`),
      "cache-control": "no-store",
    });
    response.end(`${lines.join("\n")}\n`);
  }

  function handleMessage(client: ServerClient, message: ClientMessage): void {
    switch (message.type) {
      case "join": {
        if (!acceptingConnections) {
          closeSocket(client.socket, 1013, "Server is shutting down");
          return;
        }
        const room = rooms.get(message.roomId);
        if (!room || room.full) {
          closeSocket(client.socket, 1008, "Room unavailable");
          return;
        }
        const joinTimer = joinTimers.get(client);
        if (joinTimer) clearTimeout(joinTimer);
        joinTimers.delete(client);
        client.protocol = message.protocol ?? "binary";
        client.roomId = room.id;
        try {
          rooms.join(room.id, client, message.name.trim());
        } catch (error: unknown) {
          client.roomId = null;
          const reason =
            error instanceof Error ? error.message : "Room join failed";
          closeSocket(client.socket, 1008, reason);
          return;
        }
        client.send(
          JSON.stringify({
            type: "welcome",
            playerId: client.id,
            roomId: room.id,
            room: room.snapshot(),
            seed: room.simulation.seed,
            state: room.simulation.tanks.get(client.id),
            players: [...room.members.values()].map(({ id, name, index }) => ({
              id,
              name,
              index,
            })),
          }),
        );
        return;
      }
      case "input": {
        if (client.protocol !== "json") {
          closeSocket(client.socket, 1003, "JSON input protocol is disabled");
          return;
        }
        rooms
          .get(client.roomId)
          ?.setInput(client.id, message.input, message.seq);
        return;
      }
      case "leave": {
        const roomId = client.roomId;
        if (roomId) {
          rooms.leave(client.id, "leave");
          client.roomId = null;
          joinTimers.set(
            client,
            setTimeout(() => {
              closeSocket(
                client.socket,
                1008,
                "Join required within 5 seconds",
              );
            }, config.joinTimeoutMs),
          );
        }
        client.send(JSON.stringify({ type: "left", roomId }));
        return;
      }
      case "chat": {
        const room = rooms.get(client.roomId);
        if (!room) {
          closeSocket(client.socket, 1008, "Join a room before sending chat");
          return;
        }
        room.chat(client.id, message.text.trim());
        return;
      }
      default:
        assertNever(message);
    }
  }

  async function handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const rawPath = request.url?.split("?")[0] ?? "/";
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      sendJson(response, 400, { error: "Malformed URL path" });
      return;
    }
    if (decodedPath.split(/[\\/]+/).includes("..")) {
      sendJson(response, 400, { error: "Path traversal is not allowed" });
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        status: "ok",
        buildSha,
        rooms: rooms.rooms.size,
        clients: sockets.size,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/ready") {
      sendJson(response, acceptingConnections ? 200 : 503, {
        status: acceptingConnections ? "ready" : "draining",
        buildSha,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/metrics") {
      sendMetrics(response);
      return;
    }
    if (url.pathname === "/api/rooms" && request.method === "GET") {
      sendJson(response, 200, rooms.list());
      return;
    }
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      if (!acceptingConnections) {
        sendJson(response, 503, { error: "Server is shutting down." });
        return;
      }
      const payload = CreateRoomSchema.safeParse(
        await readJsonBody(request, 4096),
      );
      if (!payload.success) {
        sendJson(response, 400, { error: "Expected { name, maxPlayers? }." });
        return;
      }
      try {
        const room = rooms.create(payload.data);
        sendJson(response, 201, room.snapshot());
      } catch (error: unknown) {
        if (error instanceof RoomLimitError) {
          sendJson(response, 429, { error: error.message });
          return;
        }
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : "Invalid room data",
        });
      }
      return;
    }

    const replayMatch = /^\/api\/matches\/([a-zA-Z0-9-]+)\/replay$/.exec(
      decodedPath,
    );
    const matchId = replayMatch?.[1];
    if (request.method === "GET" && matchId) {
      await streamReplay(matchId, response);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    await serveClientFile(decodedPath, request.method, response);
  }

  async function readJsonBody(
    request: IncomingMessage,
    maxBytes: number,
  ): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += data.length;
      if (size > maxBytes) throw new HttpStatusError(413, "Body too large");
      chunks.push(data);
    }
    try {
      const payload: unknown = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      );
      return payload;
    } catch {
      throw new HttpStatusError(400, "Invalid JSON body");
    }
  }

  async function serveClientFile(
    decodedPath: string,
    method: string,
    response: ServerResponse,
  ): Promise<void> {
    let relativePath =
      decodedPath === "/" ? "index.html" : decodedPath.slice(1);
    relativePath = relativePath.replaceAll("\\", "/");
    const filePath = path.resolve(config.clientDirectory, relativePath);
    const clientRoot = path.resolve(config.clientDirectory);
    if (
      filePath !== clientRoot &&
      !filePath.startsWith(`${clientRoot}${path.sep}`)
    ) {
      sendJson(response, 400, { error: "Path traversal is not allowed" });
      return;
    }
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      response.writeHead(200, {
        "content-type":
          MIME_TYPES.get(path.extname(filePath)) ?? "application/octet-stream",
        "content-length": fileStat.size,
        "x-content-type-options": "nosniff",
      });
      if (method === "HEAD") {
        response.end();
        return;
      }
      await pipeline(createReadStream(filePath), response);
    } catch (error: unknown) {
      if (hasErrorCode(error, "ENOENT", "ENOTDIR")) {
        sendJson(response, 404, { error: "Not found" });
      } else {
        throw error;
      }
    }
  }

  async function streamReplay(
    matchId: string,
    response: ServerResponse,
  ): Promise<void> {
    const logPath = path.resolve(config.logDirectory, `${matchId}.ndjson`);
    const logRoot = path.resolve(config.logDirectory);
    if (!logPath.startsWith(`${logRoot}${path.sep}`)) {
      sendJson(response, 400, { error: "Invalid match id" });
      return;
    }
    try {
      const logStat = await stat(logPath);
      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-length": logStat.size,
        "content-disposition": `attachment; filename="${matchId}.ndjson"`,
        "cache-control": "no-store",
      });
      await pipeline(createReadStream(logPath), response);
    } catch (error: unknown) {
      if (hasErrorCode(error, "ENOENT")) {
        sendJson(response, 404, { error: "Match log not found" });
        return;
      }
      throw error;
    }
  }

  function sendJson(
    response: ServerResponse,
    status: number,
    value: unknown,
  ): void {
    const body = Buffer.from(JSON.stringify(value));
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": body.length,
      "x-content-type-options": "nosniff",
    });
    response.end(body);
  }

  function closeSocket(socket: WebSocket, code: number, reason: string): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(code, reason.slice(0, 120));
    } else if (socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  }

  async function close(): Promise<void> {
    if (stopping) return;
    stopping = true;
    acceptingConnections = false;
    clearInterval(heartbeat);
    if (gameTimer) clearTimeout(gameTimer);
    for (const client of sockets) {
      client.send(
        JSON.stringify({
          type: "shutdown",
          reason: "Server is restarting; return to the lobby.",
        }),
      );
      closeSocket(client.socket, 1001, "Server shutting down");
    }
    const closeHttp = new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    const closeWebSockets = new Promise<void>((resolve) =>
      websocketServer.close(() => resolve()),
    );
    const forceClose = setTimeout(() => {
      for (const client of sockets) client.socket.terminate();
    }, 8000);
    forceClose.unref();
    await rooms.close();
    await Promise.all([closeWebSockets, closeHttp]);
    clearTimeout(forceClose);
    sockets.clear();
    joinTimers.clear();
    missedPongs.clear();
    connectionsByIp.clear();
    eventLoopDelay.disable();
  }

  return {
    server,
    websocketServer,
    rooms,
    listen(): Promise<AddressInfo> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, () => {
          server.removeListener("error", reject);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Server did not bind to a TCP address."));
            return;
          }
          resolve(address);
        });
      });
    },
    close,
  };
}

function toBuffer(raw: RawData): Buffer {
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
}

function clientIp(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const forwardedIp = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const firstIp = forwardedIp?.split(",")[0]?.trim();
    if (firstIp) return firstIp;
  }
  return request.socket.remoteAddress ?? "unknown";
}

function hasErrorCode(
  error: unknown,
  ...codes: string[]
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled client message: ${JSON.stringify(value)}`);
}

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger(config.logLevel, config.buildSha);
  await mkdir(config.logDirectory, { recursive: true });
  const application = createGameServer(config, { logger });
  const address = await application.listen();
  logger.info(
    { port: address.port, buildSha: config.buildSha },
    "Server listening",
  );

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Graceful shutdown started");
    try {
      await application.close();
      logger.info({ signal }, "Graceful shutdown complete");
      process.exitCode = 0;
    } catch (error: unknown) {
      logger.fatal({ err: error, signal }, "Graceful shutdown failed");
      process.exitCode = 1;
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

process.on("uncaughtExceptionMonitor", (error, origin) => {
  bootstrapLogger.fatal(
    { err: error, origin },
    "Uncaught exception; process will exit",
  );
});

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    bootstrapLogger.fatal({ err: error }, "Server failed to start");
    process.exitCode = 1;
  });
}
