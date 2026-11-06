import {
  ServerMessageSchema,
  decodeSnapshotJson,
  decodeSnapshotPacket,
  encodeInputPacket,
} from "../../shared/protocol.js";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";
import type { InputSequence, PartialPlayerInput } from "../../shared/types.js";

const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ??
  `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
const MAX_QUEUED_MESSAGES = 50;

export type ConnectionStatus =
  "connecting" | "connected" | "disconnected" | "queue-full" | "error";
export type TrafficDirection = "in" | "out";

interface ConnectionOptions {
  readonly onMessage: (message: ServerMessage) => void;
  readonly onStatus: (
    status: ConnectionStatus,
    detail?: {
      readonly code?: number;
      readonly reason?: string;
      readonly limit?: number;
    },
  ) => void;
  readonly onTraffic?: (direction: TrafficDirection, bytes: number) => void;
  readonly roomId: string;
  readonly name: string;
}

interface QueuedMessage {
  readonly data: string | ArrayBuffer;
  readonly simulate: boolean;
}

export interface GameConnection {
  readonly protocol: "json" | "binary";
  readonly predictionEnabled: boolean;
  send(message: ClientMessage): boolean;
  sendInput(sequence: InputSequence, input: PartialPlayerInput): boolean;
  close(): void;
}

export function connect({
  onMessage,
  onStatus,
  onTraffic,
  roomId,
  name,
}: ConnectionOptions): GameConnection {
  const query = new URLSearchParams(location.search);
  const protocol = query.get("protocol") === "json" ? "json" : "binary";
  const predictionEnabled = query.get("prediction") !== "off";
  const delayMs = boundedNumber(query.get("netDelay"), 0, 0, 1000);
  const jitterMs = boundedNumber(query.get("netJitter"), 0, 0, 500);
  const lossRate = boundedNumber(query.get("netLoss"), 0, 0, 0.5);
  let socket: WebSocket | null = null;
  let reconnectTimer = 0;
  let stableTimer = 0;
  let closed = false;
  let attempts = 0;
  const queue: QueuedMessage[] = [];

  function open(): void {
    if (closed) return;
    onStatus("connecting");
    const activeSocket = new WebSocket(SERVER_URL);
    socket = activeSocket;
    activeSocket.binaryType = "arraybuffer";

    activeSocket.addEventListener("open", () => {
      window.clearTimeout(stableTimer);
      stableTimer = window.setTimeout(() => {
        attempts = 0;
      }, 30000);
      activeSocket.send(
        JSON.stringify({ type: "join", roomId, name, protocol }),
      );
      while (queue.length && activeSocket.readyState === WebSocket.OPEN) {
        const queued = queue.shift();
        if (queued) transmit(queued.data, queued.simulate);
      }
      onStatus("connected");
    });
    activeSocket.addEventListener("message", (event: MessageEvent<unknown>) => {
      const sourceSocket = activeSocket;
      if (socket !== sourceSocket) return;
      try {
        if (event.data instanceof ArrayBuffer) {
          onTraffic?.("in", event.data.byteLength);
          const snapshot = decodeSnapshotPacket(event.data);
          simulatePacket(() => onMessage(snapshot), sourceSocket);
          return;
        }
        if (typeof event.data !== "string") {
          throw new TypeError("Unsupported server message payload.");
        }
        const decoded: unknown = JSON.parse(event.data);
        const parsed = ServerMessageSchema.safeParse(decoded);
        if (!parsed.success) {
          throw new TypeError("Invalid server message.");
        }
        const message = parsed.data;
        if (message.type === "state") {
          onTraffic?.("in", event.data.length);
          const snapshot = decodeSnapshotJson(message);
          simulatePacket(() => onMessage(snapshot), sourceSocket);
        } else {
          onMessage(message);
        }
      } catch (error: unknown) {
        console.error("Could not process server message:", error);
      }
    });
    activeSocket.addEventListener("close", (event) => {
      window.clearTimeout(stableTimer);
      onStatus("disconnected", {
        code: event.code,
        reason: event.reason,
      });
      if (closed) return;
      attempts += 1;
      const base = Math.min(500 * 2 ** (attempts - 1), 10000);
      const backoff = base * (0.8 + Math.random() * 0.4);
      reconnectTimer = window.setTimeout(open, backoff);
    });
    activeSocket.addEventListener("error", () => {
      onStatus("error");
      activeSocket.close();
    });
  }

  function send(message: ClientMessage): boolean {
    return enqueue(JSON.stringify(message), false);
  }

  function sendInput(
    sequence: InputSequence,
    input: PartialPlayerInput,
  ): boolean {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    if (protocol === "json") {
      const encoded = JSON.stringify({ type: "input", seq: sequence, input });
      onTraffic?.("out", encoded.length);
      return enqueue(encoded, true);
    }
    const encoded = encodeInputPacket(sequence, input);
    onTraffic?.("out", encoded.byteLength);
    return enqueue(encoded, true);
  }

  function enqueue(data: string | ArrayBuffer, simulate: boolean): boolean {
    if (socket?.readyState === WebSocket.OPEN) {
      transmit(data, simulate);
      return true;
    }
    if (queue.length >= MAX_QUEUED_MESSAGES) {
      onStatus("queue-full", { limit: MAX_QUEUED_MESSAGES });
      return false;
    }
    queue.push({ data, simulate });
    return false;
  }

  function transmit(data: string | ArrayBuffer, simulate: boolean): void {
    const targetSocket = socket;
    const deliver = () => {
      if (
        closed ||
        socket !== targetSocket ||
        targetSocket?.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      targetSocket.send(data);
    };
    if (simulate) {
      if (Math.random() < lossRate) return;
      const jitter = jitterMs ? Math.random() * jitterMs * 2 - jitterMs : 0;
      const delay = Math.max(0, delayMs + jitter);
      if (delay > 0) window.setTimeout(deliver, delay);
      else deliver();
      return;
    }
    deliver();
  }

  function simulatePacket(deliver: () => void, sourceSocket: WebSocket): void {
    if (Math.random() < lossRate) return;
    const jitter = jitterMs ? Math.random() * jitterMs * 2 - jitterMs : 0;
    const delay = Math.max(0, delayMs + jitter);
    const guardedDeliver = () => {
      if (!closed && socket === sourceSocket) deliver();
    };
    if (delay > 0) window.setTimeout(guardedDeliver, delay);
    else guardedDeliver();
  }

  open();
  return {
    send,
    sendInput,
    protocol,
    predictionEnabled,
    close() {
      if (closed) return;
      closed = true;
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(stableTimer);
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "leave" }));
      }
      socket?.close(1000, "Client leaving");
      queue.length = 0;
    },
  };
}

function boundedNumber(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, parsed))
    : fallback;
}
