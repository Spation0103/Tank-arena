import { monitorEventLoopDelay } from "node:perf_hooks";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { createGameServer } from "../server/build/server/index.js";
import { readConfig } from "../server/build/server/config.js";
import { encodeInputPacket } from "../server/build/shared/protocol.js";
import { asInputSequence } from "../server/build/shared/types.js";

const clientCounts = [8, 32, 64, 128];
const durationMs = Number(process.env.LOAD_TEST_DURATION_MS ?? 10_000);
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "tank-load-"));
const logDirectory = path.join(temporaryDirectory, "logs");
const configuration = {
  ...readConfig({ PORT: "3001", LOG_DIR: logDirectory }),
  port: 0,
  logDirectory,
};
const samples = [];
const app = createGameServer(configuration, {
  onStep(sample) {
    samples.push(sample.durationMs);
  },
});
const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
eventLoopDelay.enable();

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))
  ];
}

function waitForWelcome(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Bot did not receive a welcome message.")),
      5000,
    );
    const onMessage = (data, binary) => {
      if (binary) return;
      try {
        const message = JSON.parse(data.toString());
        if (message.type !== "welcome") return;
        clearTimeout(timeout);
        socket.off("message", onMessage);
        socket.off("error", onError);
        resolve(message);
      } catch (error) {
        clearTimeout(timeout);
        socket.off("message", onMessage);
        socket.off("error", onError);
        reject(error);
      }
    };
    const onError = (error) => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      reject(error);
    };
    socket.on("message", onMessage);
    socket.once("error", onError);
  });
}

function summarize(count) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    clients: count,
    sampleCount: sorted.length,
    stepMs: {
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: Math.max(0, ...sorted),
    },
    over33ms: sorted.filter((duration) => duration > 1000 / 30).length,
    eventLoopDelayMs: {
      mean: Number(eventLoopDelay.mean / 1e6),
      p99: Number(eventLoopDelay.percentile(99) / 1e6),
      max: Number(eventLoopDelay.max / 1e6),
    },
  };
}

async function closeSockets(sockets) {
  await Promise.all(
    sockets.map(
      (socket) =>
        new Promise((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          socket.once("close", resolve);
          socket.close();
          setTimeout(() => {
            if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
            resolve();
          }, 1500).unref();
        }),
    ),
  );
}

try {
  const address = await app.listen();
  const results = [];
  for (const count of clientCounts) {
    const room = app.rooms.create({
      name: `Load test ${count}`,
      maxPlayers: count,
    });
    const sockets = [];
    for (let index = 0; index < count; index += 1) {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
      sockets.push(socket);
      const welcome = waitForWelcome(socket);
      await new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      socket.send(
        JSON.stringify({
          type: "join",
          roomId: room.id,
          name: `Bot ${index + 1}`,
          protocol: "binary",
        }),
      );
      await welcome;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
    samples.length = 0;
    eventLoopDelay.reset();
    let sequence = 0;
    const timer = setInterval(() => {
      sequence = (sequence + 1) >>> 0;
      const packet = encodeInputPacket(asInputSequence(sequence), {
        forward: true,
        right: true,
        fire: true,
      });
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN) socket.send(packet);
      }
    }, 1000 / 30);
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    clearInterval(timer);
    results.push(summarize(count));
    await closeSockets(sockets);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const report = {
    generatedAt: new Date().toISOString(),
    durationPerLoad: durationMs,
    input: "forward + right + fire, binary input at 30 Hz",
    results,
  };
  await writeFile(
    "docs/load-test.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  eventLoopDelay.disable();
  await app.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
