import { simulateBots } from "./worker-benchmark.ts";

globalThis.postMessage({ type: "ready" });
globalThis.addEventListener("message", ({ data }) => {
  globalThis.postMessage({
    type: "result",
    result: simulateBots(data.iterations, data.playerCount),
  });
});
