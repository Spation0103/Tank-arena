import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { ZodError } from "zod";
import { readConfig } from "../config.js";
import { createGameServer } from "../index.js";
import { RoomManager } from "../rooms.js";
import { MatchLogger } from "../streams.js";
import {
  decodeSnapshotPacket,
  encodeInputPacket,
} from "../../shared/protocol.js";

async function createFixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tank-server-"));
  const clientDirectory = path.join(directory, "client");
  await mkdir(clientDirectory);
  await writeFile(
    path.join(clientDirectory, "index.html"),
    "<h1>Tank Arena</h1>",
  );
  const config = {
    ...readConfig({ PORT: "3001", LOG_DIR: path.join(directory, "logs") }),
    port: 0,
    clientDirectory,
    ...overrides,
  };
  const app = createGameServer(config, {
    logger: { error() {}, warn() {}, info() {} },
  });
  const address = await app.listen();
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    app,
    address,
    baseUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/ws`,
    logDirectory: config.logDirectory,
  };
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      socket.off("message", onMessage);
      socket.off("error", onError);
      resolve(message);
    };
    const onError = (error) => {
      socket.off("message", onMessage);
      reject(error);
    };
    socket.on("message", onMessage);
    socket.once("error", onError);
  });
}

function nextBinaryMessage(socket) {
  return new Promise((resolve, reject) => {
    const onMessage = (data, isBinary) => {
      if (!isBinary) return;
      socket.off("message", onMessage);
      socket.off("error", onError);
      resolve(data);
    };
    const onError = (error) => {
      socket.off("message", onMessage);
      reject(error);
    };
    socket.on("message", onMessage);
    socket.once("error", onError);
  });
}

function closed(socket) {
  return new Promise((resolve) =>
    socket.once("close", (code, reason) =>
      resolve({
        code,
        reason: reason.toString(),
      }),
    ),
  );
}

test("config validates port and resolves log directory from environment", () => {
  const config = readConfig({ PORT: "4321", LOG_DIR: ".test-logs" });
  assert.equal(config.port, 4321);
  assert.ok(path.isAbsolute(config.logDirectory));
  assert.throws(() => readConfig({ PORT: "70000" }), ZodError);
  assert.throws(() => readConfig({ PORT: "abc" }), ZodError);
  assert.throws(
    () => readConfig({ PORT: "3001", MAX_CONNECTIONS_PER_IP: "0" }),
    ZodError,
  );
  assert.deepEqual(
    readConfig({
      PORT: "3001",
      ALLOWED_ORIGINS: "https://arena.example, https://www.example",
      MAX_CONNECTIONS_PER_IP: "3",
      MAX_ROOMS: "8",
      MAX_PLAYERS_PER_ROOM: "16",
      TRUST_PROXY: "true",
      BUILD_SHA: "v1.0.0",
    }),
    {
      ...readConfig({ PORT: "3001" }),
      allowedOrigins: ["https://arena.example", "https://www.example"],
      maxConnectionsPerIp: 3,
      maxRooms: 8,
      maxPlayersPerRoom: 16,
      trustProxy: true,
      buildSha: "v1.0.0",
    },
  );
});

test("RoomManager removes empty rooms and logs join, chat and leave as NDJSON", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tank-room-"));
  const manager = new RoomManager(directory, [], {
    logger: { error() {}, warn() {}, info() {}, fatal() {} },
  });
  t.after(async () => {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  });
  const room = manager.create({ name: "Test Arena", maxPlayers: 4 });
  const sent = [];
  const client = {
    id: "pilot-1",
    send: (value) => sent.push(JSON.parse(value)),
  };
  manager.join(room.id, client, "Pilot");
  room.chat(client.id, "hello");
  assert.ok(sent.some((message) => message.type === "room"));
  assert.ok(sent.some((message) => message.type === "chat"));

  manager.leave(client.id, "leave");
  assert.equal(manager.get(room.id), undefined);
  await manager.close();
  const lines = (await readFile(room.logger.filePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map((line) => line.type),
    ["join", "chat", "leave"],
  );
});

test("HTTP serves health, GET/POST rooms, safe static files and rejects traversal", async (t) => {
  const { baseUrl } = await createFixture(t);
  const health = await fetch(`${baseUrl}/health`).then((response) =>
    response.json(),
  );
  assert.equal(health.status, "ok");
  assert.equal(health.buildSha, "development");
  assert.equal(
    await fetch(`${baseUrl}/ready`).then((response) => response.status),
    200,
  );
  const metrics = await fetch(`${baseUrl}/metrics`).then((response) =>
    response.text(),
  );
  assert.match(metrics, /tank_arena_players 0/);
  assert.match(metrics, /tank_arena_process_resident_memory_bytes/);

  const rooms = await fetch(`${baseUrl}/api/rooms`).then((response) =>
    response.json(),
  );
  assert.deepEqual(
    rooms.map((room) => room.id),
    ["ALPHA-07", "BRAVO-12"],
  );
  const created = await fetch(`${baseUrl}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Custom Room", maxPlayers: 6 }),
  });

  test("WebSocket upgrades validate Origin and enforce per-IP connection limits", async (t) => {
    const { app, address } = await createFixture(t, {
      allowedOrigins: ["https://allowed.example"],
      maxConnectionsPerIp: 1,
    });
    const denied = new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
        headers: { Origin: "https://attacker.example" },
      });
      socket.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode);
        response.resume();
      });
      socket.once("error", reject);
    });
    assert.equal(await denied, 403);

    const first = await openSocket(`ws://127.0.0.1:${address.port}/ws`);
    const secondDenied = new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
        headers: { Origin: "https://allowed.example" },
      });
      socket.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode);
        response.resume();
      });
      socket.once("error", reject);
    });
    assert.equal(await secondDenied, 429);
    const firstClosed = closed(first);
    first.close();
    await firstClosed;
    assert.equal(app.rooms.rooms.size, 2);
  });

  test("graceful shutdown notifies clients, closes with 1001, and drains room logs", async (t) => {
    const { app, wsUrl } = await createFixture(t);
    const socket = await openSocket(wsUrl);
    const welcome = nextMessage(
      socket,
      (message) => message.type === "welcome",
    );
    socket.send(
      JSON.stringify({
        type: "join",
        roomId: "ALPHA-07",
        name: "Shutdown test",
        protocol: "json",
      }),
    );
    await welcome;
    const shutdownMessage = nextMessage(
      socket,
      (message) => message.type === "shutdown",
    );
    const socketClosed = closed(socket);
    await app.close();
    assert.equal((await shutdownMessage).type, "shutdown");
    assert.equal((await socketClosed).code, 1001);
  });

  test("malformed frame flood disconnects the sender while another room keeps ticking", async (t) => {
    const { wsUrl } = await createFixture(t);
    const player = await openSocket(wsUrl);
    const welcome = nextMessage(
      player,
      (message) => message.type === "welcome",
    );
    player.send(
      JSON.stringify({
        type: "join",
        roomId: "BRAVO-12",
        name: "Active player",
        protocol: "json",
      }),
    );
    await welcome;

    const malicious = await openSocket(wsUrl);
    const maliciousWelcome = nextMessage(
      malicious,
      (message) => message.type === "welcome",
    );
    malicious.send(
      JSON.stringify({
        type: "join",
        roomId: "ALPHA-07",
        name: "Malformed client",
        protocol: "json",
      }),
    );
    await maliciousWelcome;
    const maliciousClosed = closed(malicious);
    const otherRoomTick = nextMessage(
      player,
      (message) => message.type === "state",
    );
    for (let index = 0; index < 1000; index += 1) {
      malicious.send("{not-json");
    }
    assert.equal((await maliciousClosed).code, 1007);
    assert.equal((await otherRoomTick).type, "state");
    const playerClosed = closed(player);
    player.close();
    await playerClosed;
  });

  test("disconnecting mid-match removes only that player from the room", async (t) => {
    const { app, wsUrl } = await createFixture(t);
    const first = await openSocket(wsUrl);
    const firstWelcome = nextMessage(
      first,
      (message) => message.type === "welcome",
    );
    first.send(
      JSON.stringify({
        type: "join",
        roomId: "ALPHA-07",
        name: "First",
        protocol: "json",
      }),
    );
    await firstWelcome;

    const second = await openSocket(wsUrl);
    const secondWelcome = nextMessage(
      second,
      (message) => message.type === "welcome",
    );
    const rosterLeave = nextMessage(
      second,
      (message) => message.type === "room" && message.action === "leave",
    );
    second.send(
      JSON.stringify({
        type: "join",
        roomId: "ALPHA-07",
        name: "Second",
        protocol: "json",
      }),
    );
    await secondWelcome;
    const firstClosed = closed(first);
    const secondClosed = closed(second);
    first.terminate();
    await firstClosed;
    assert.equal((await rosterLeave).player.name, "First");
    assert.equal(app.rooms.get("ALPHA-07")?.size, 1);
    second.close();
    await secondClosed;
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).name, "Custom Room");

  const staticResponse = await fetch(baseUrl);
  assert.equal(staticResponse.status, 200);
  assert.match(await staticResponse.text(), /Tank Arena/);
  const traversal = await fetch(`${baseUrl}/%2e%2e%2fserver/config.js`);
  assert.equal(traversal.status, 400);
  const malformed = await fetch(`${baseUrl}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{bad",
  });
  assert.equal(malformed.status, 400);
});

test("replay HTTP endpoint streams the closed room log", async (t) => {
  const { app, baseUrl } = await createFixture(t);
  const room = app.rooms.create({ name: "Replay Room" });
  room.logger.write({ type: "chat", text: "streamed replay" });
  await room.logger.close();

  const response = await fetch(`${baseUrl}/api/matches/${room.id}/replay`, {
    headers: { connection: "close" },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
  assert.match(await response.text(), /"text":"streamed replay"/);
});

test("WebSocket clients join, chat, leave and receive room events without coordinates", async (t) => {
  const { wsUrl } = await createFixture(t);
  const first = await openSocket(wsUrl);
  const firstClose = closed(first);
  const firstWelcome = nextMessage(
    first,
    (message) => message.type === "welcome",
  );
  first.send(
    JSON.stringify({
      type: "join",
      roomId: "ALPHA-07",
      name: "Pilot",
      protocol: "json",
    }),
  );
  const welcome = await firstWelcome;
  assert.equal(welcome.roomId, "ALPHA-07");
  assert.equal(welcome.players.length, 1);
  assert.equal("player" in welcome, false);

  const second = await openSocket(wsUrl);
  const joined = nextMessage(second, (message) => message.type === "welcome");
  const rosterUpdate = nextMessage(first, (message) => message.type === "room");
  second.send(
    JSON.stringify({
      type: "join",
      roomId: "ALPHA-07",
      name: "Echo",
      protocol: "json",
    }),
  );
  const secondWelcome = await joined;
  assert.equal(secondWelcome.players.length, 2);
  assert.equal((await rosterUpdate).action, "join");

  const chatAtFirst = nextMessage(first, (message) => message.type === "chat");
  const chatAtSecond = nextMessage(
    second,
    (message) => message.type === "chat",
  );
  second.send(JSON.stringify({ type: "chat", text: "Ready!" }));
  assert.equal((await chatAtFirst).text, "Ready!");
  assert.equal((await chatAtSecond).name, "Echo");
  assert.equal(first.readyState, WebSocket.OPEN);

  const leftMessage = nextMessage(second, (message) => message.type === "left");
  second.send(JSON.stringify({ type: "leave" }));
  assert.equal((await leftMessage).roomId, "ALPHA-07");

  first.close();
  const secondClose = closed(second);
  second.close();
  await Promise.all([firstClose, secondClose]);
});

test("unknown and malformed protocol messages close with policy codes", async (t) => {
  const { wsUrl } = await createFixture(t);
  const socket = await openSocket(wsUrl);
  const result = closed(socket);
  socket.send(JSON.stringify({ type: "coordinates", x: 4, y: 9 }));
  assert.equal((await result).code, 1008);

  const malformedSocket = await openSocket(wsUrl);
  const malformedClose = closed(malformedSocket);
  malformedSocket.send("{invalid");
  assert.equal((await malformedClose).code, 1007);
});

test("binary input is authoritative and server snapshots acknowledge sequences", async (t) => {
  const { wsUrl } = await createFixture(t);
  const socket = await openSocket(wsUrl);
  const welcomePromise = nextMessage(
    socket,
    (message) => message.type === "welcome",
  );
  socket.send(
    JSON.stringify({
      type: "join",
      roomId: "ALPHA-07",
      name: "Binary Pilot",
      protocol: "binary",
    }),
  );
  const welcome = await welcomePromise;
  assert.ok(welcome.state);

  const snapshotPromise = (async () => {
    while (true) {
      const state = decodeSnapshotPacket(await nextBinaryMessage(socket));
      if (state.ack >= 1) return state;
    }
  })();
  for (let sequence = 1; sequence <= 4; sequence += 1) {
    socket.send(
      Buffer.from(
        encodeInputPacket(sequence, {
          forward: true,
          right: true,
        }),
      ),
    );
  }
  const snapshot = await snapshotPromise;
  assert.ok(snapshot.ack >= 1);
  assert.equal(snapshot.tanks.length, 1);
  assert.notEqual(snapshot.tanks[0].x, welcome.state.x);
  assert.notEqual(snapshot.tanks[0].angle, welcome.state.angle);

  const socketClose = closed(socket);
  socket.close();
  await socketClose;
});

test("JSON input mode remains available when explicitly negotiated", async (t) => {
  const { wsUrl } = await createFixture(t);
  const socket = await openSocket(wsUrl);
  const welcomePromise = nextMessage(
    socket,
    (message) => message.type === "welcome",
  );
  socket.send(
    JSON.stringify({
      type: "join",
      roomId: "ALPHA-07",
      name: "JSON Pilot",
      protocol: "json",
    }),
  );
  const welcome = await welcomePromise;

  const statePromise = nextMessage(
    socket,
    (message) => message.type === "state" && message.ack >= 1,
  );
  socket.send(
    JSON.stringify({
      type: "input",
      seq: 1,
      input: { forward: true, right: true },
    }),
  );
  const state = await statePromise;
  assert.equal(state.ack, 1);
  assert.notEqual(state.tanks[0].x, welcome.state.x);

  const socketClose = closed(socket);
  socket.close();
  await socketClose;
});

test("socket that does not join before deadline is closed", async (t) => {
  const { wsUrl } = await createFixture(t, { joinTimeoutMs: 35 });
  const socket = await openSocket(wsUrl);
  const result = await closed(socket);
  assert.equal(result.code, 1008);
});

test("MatchLogger exposes file replay as a readable stream", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tank-replay-"));
  const logger = new MatchLogger(directory, "sample-match");
  logger.on("error", (error) => assert.fail(error.message));
  logger.write({ type: "join", playerId: "one" });
  logger.write({ type: "chat", text: "stream me" });
  await Promise.all([logger.close(), logger.close()]);
  const { replayStream } = await import("../streams.js");
  const replay = await new Promise((resolve, reject) => {
    const chunks = [];
    replayStream(directory, "sample-match")
      .on("data", (chunk) => chunks.push(chunk))
      .on("end", () => resolve(Buffer.concat(chunks).toString()))
      .on("error", reject);
  });
  assert.match(replay, /"text":"stream me"/);
  await rm(directory, { recursive: true, force: true });
});
