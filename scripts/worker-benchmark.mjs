import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const iterations = Number(process.env.WORKER_BENCH_ITERATIONS ?? 1200);
const playerCount = 8;
const vite = await createServer({
  configFile: path.resolve("client/vite.config.ts"),
  root: path.resolve("client"),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: true },
});
let browser;

try {
  await vite.listen();
  const address = vite.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Vite did not bind to a TCP address.");
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/src/worker-benchmark.ts`);
  const report = await page.evaluate(
    async ({ iterations, playerCount }) => {
      const { simulateBots } = await import("/src/worker-benchmark.ts");
      const worker = new Worker("/src/worker-benchmark.worker.js", {
        type: "module",
      });
      await new Promise((resolve, reject) => {
        worker.addEventListener(
          "message",
          ({ data }) => {
            if (data.type === "ready") resolve();
          },
          { once: true },
        );
        worker.addEventListener("error", reject, { once: true });
      });

      async function measure(run) {
        const delays = [];
        let previous = performance.now();
        const timer = setInterval(() => {
          const now = performance.now();
          delays.push(Math.max(0, now - previous - 10));
          previous = now;
        }, 10);
        try {
          const result = await run();
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            ...result,
            maxMainThreadTimerDelayMs: Math.max(0, ...delays),
          };
        } finally {
          clearInterval(timer);
        }
      }

      const mainThread = await measure(() =>
        Promise.resolve(simulateBots(iterations, playerCount)),
      );
      const workerThread = await measure(
        () =>
          new Promise((resolve, reject) => {
            const onMessage = ({ data }) => {
              if (data.type !== "result") return;
              worker.removeEventListener("message", onMessage);
              resolve(data.result);
            };
            worker.addEventListener("message", onMessage);
            worker.postMessage({ iterations, playerCount });
            worker.addEventListener("error", reject, { once: true });
          }),
      );
      worker.terminate();
      return {
        iterations,
        simulatedClients: playerCount,
        input: "forward + right + fire",
        mainThread,
        workerThread,
      };
    },
    { iterations, playerCount },
  );

  await mkdir("docs", { recursive: true });
  await writeFile(
    "docs/worker-benchmark.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await vite.close();
}
