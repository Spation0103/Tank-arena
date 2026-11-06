import { PerformanceObserver } from "node:perf_hooks";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createGameServer } from "../server/build/server/index.js";
import { readConfig } from "../server/build/server/config.js";

const label = process.argv[2] ?? "after";
if (!["before", "after"].includes(label)) {
  throw new Error("Pass `before` or `after` as the profile label.");
}

const durationMs = 30_000;
const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "tank-profile-"),
);
const logDirectory = path.join(temporaryDirectory, "logs");
const configuration = {
  ...readConfig({ PORT: "3001", LOG_DIR: logDirectory }),
  port: 0,
  logDirectory,
};
const serverSteps = [];
const app = createGameServer(configuration, {
  onStep(sample) {
    serverSteps.push(sample.durationMs);
  },
});
let browser;
const gcPauses = [];
const gcObserver = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) gcPauses.push(entry.duration);
});
gcObserver.observe({ entryTypes: ["gc"] });

function percentile(samples, ratio) {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))
  ];
}

function summarizeProfile(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const totals = new Map();
  for (let index = 0; index < profile.samples.length; index += 1) {
    const node = nodes.get(profile.samples[index]);
    if (!node) continue;
    const name = node.callFrame.functionName || "(anonymous)";
    const delta = profile.timeDeltas[index] ?? 0;
    totals.set(name, (totals.get(name) ?? 0) + delta);
  }
  return [...totals]
    .map(([functionName, sampledMicroseconds]) => ({
      functionName,
      sampledMicroseconds,
    }))
    .sort((a, b) => b.sampledMicroseconds - a.sampledMicroseconds)
    .slice(0, 12);
}

function summarizeAllocations(profile) {
  const totals = new Map();
  function visit(node) {
    const name = node.callFrame.functionName || "(anonymous)";
    totals.set(name, (totals.get(name) ?? 0) + node.selfSize);
    for (const child of node.children ?? []) visit(child);
  }
  visit(profile.head);
  return [...totals]
    .map(([functionName, sampledBytes]) => ({ functionName, sampledBytes }))
    .sort((a, b) => b.sampledBytes - a.sampledBytes)
    .slice(0, 12);
}

function flameSvg(profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parentById = new Map();
  for (const node of profile.nodes) {
    for (const childId of node.children ?? []) {
      parentById.set(childId, node.id);
    }
  }
  const root = { name: "Main thread", weight: 0, children: new Map() };
  for (
    let sampleIndex = 0;
    sampleIndex < profile.samples.length;
    sampleIndex += 1
  ) {
    const stack = [];
    let node = byId.get(profile.samples[sampleIndex]);
    if (
      node?.callFrame.functionName === "(idle)" ||
      node?.callFrame.functionName === "(program)"
    ) {
      continue;
    }
    while (node) {
      stack.push(node);
      const parentId = parentById.get(node.id);
      node = parentId === undefined ? undefined : byId.get(parentId);
    }
    stack.reverse();
    const weight = profile.timeDeltas[sampleIndex] ?? 1000;
    let parent = root;
    for (const frame of stack) {
      const name = frame.callFrame.functionName || "(anonymous)";
      let child = parent.children.get(name);
      if (!child) {
        child = { name, weight: 0, children: new Map() };
        parent.children.set(name, child);
      }
      child.weight += weight;
      parent = child;
    }
  }

  const width = 1400;
  const rowHeight = 24;
  const frames = [];
  let deepestY = 2;
  function draw(node, x, y, availableWidth) {
    deepestY = Math.max(deepestY, y + rowHeight);
    let cursor = x;
    const children = [...node.children.values()].sort(
      (a, b) => b.weight - a.weight,
    );
    for (const child of children) {
      const childWidth =
        (availableWidth * child.weight) / Math.max(node.weight, 1);
      const color = `hsl(${(child.name.length * 41) % 360} 48% 68%)`;
      frames.push(
        `<g><title>${escapeXml(child.name)} · ${(child.weight / 1000).toFixed(1)} ms</title><rect x="${cursor.toFixed(2)}" y="${y}" width="${Math.max(1, childWidth).toFixed(2)}" height="22" fill="${color}" stroke="#27313a"/><text x="${(cursor + 4).toFixed(2)}" y="${y + 15}" font-size="11">${escapeXml(child.name)}</text></g>`,
      );
      draw(child, cursor, y + rowHeight, childWidth);
      cursor += childWidth;
    }
  }
  root.weight = profile.samples.reduce((sum, sample, index) => {
    const node = byId.get(sample);
    return node?.callFrame.functionName === "(idle)" ||
      node?.callFrame.functionName === "(program)"
      ? sum
      : sum + (profile.timeDeltas[index] ?? 0);
  }, 0);
  draw(root, 0, 2, width);
  const height = Math.max(100, deepestY + rowHeight);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#111827"/><text x="8" y="18" fill="white" font-size="14">V8 sampled CPU profile · ${label} · 8 browser bots · 30 seconds</text>${frames.join("")}</svg>`;
}

function escapeXml(value) {
  return value.replace(
    /[<>&"]/g,
    (character) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
      })[character],
  );
}

await mkdir("docs", { recursive: true });

try {
  const address = await app.listen();
  browser = await chromium.launch({ headless: true });
  const contexts = [];
  const pages = [];
  const frameSamples = [];
  const longTasks = [];
  let profilerSession;
  let heapSession;

  for (let index = 0; index < 8; index += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    contexts.push(context);
    pages.push(page);
    const cdp = await context.newCDPSession(page);
    if (index === 0) {
      profilerSession = cdp;
      heapSession = cdp;
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.start");
      await cdp.send("HeapProfiler.startSampling", { samplingInterval: 32768 });
    }
    await page.goto(`http://127.0.0.1:${address.port}/?protocol=json`);
    await page.locator("#player-name").fill(`BOT-${index + 1}`);
    await page.locator("#join-button").click();
  }

  await Promise.all(
    pages.map((page) =>
      page.locator("#player-count").getByText("8 TANKS").waitFor(),
    ),
  );
  await Promise.all(
    pages.map(async (page) => {
      await page.evaluate(() => {
        const samples = [];
        const longTaskEntries = [];
        window.__tankProfile = { samples, longTaskEntries, recording: false };
        try {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              window.__tankProfile.longTaskEntries.push(entry.duration);
            }
          }).observe({ type: "longtask", buffered: true });
        } catch {
          // The browser may not implement long-task entries.
        }
        let last = 0;
        const collect = (now) => {
          if (window.__tankProfile.recording && last > 0) {
            window.__tankProfile.samples.push(now - last);
          }
          last = now;
          requestAnimationFrame(collect);
        };
        requestAnimationFrame(collect);
      });
      await page.keyboard.down("w");
      await page.keyboard.down("Space");
      await page.evaluate(() => {
        window.__tankProfile.recording = true;
      });
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, durationMs));
  const pageResults = await Promise.all(
    pages.map(async (page) => {
      await page.keyboard.up("w");
      await page.keyboard.up("Space");
      return page.evaluate(() => {
        window.__tankProfile.recording = false;
        return {
          frames: window.__tankProfile.samples,
          longTasks: window.__tankProfile.longTaskEntries,
        };
      });
    }),
  );
  for (const result of pageResults) {
    frameSamples.push(...result.frames);
    longTasks.push(...result.longTasks);
  }

  const cpu = await profilerSession.send("Profiler.stop");
  const heap = await heapSession.send("HeapProfiler.stopSampling");
  const report = {
    label,
    generatedAt: new Date().toISOString(),
    durationSeconds: durationMs / 1000,
    browserClients: pages.length,
    frameTimesMs: {
      samples: frameSamples.length,
      p50: percentile(frameSamples, 0.5),
      p95: percentile(frameSamples, 0.95),
      p99: percentile(frameSamples, 0.99),
      max: Math.max(0, ...frameSamples),
    },
    longTasks: {
      count: longTasks.length,
      maxMs: Math.max(0, ...longTasks),
    },
    nodeGcPausesMs: {
      count: gcPauses.length,
      total: gcPauses.reduce((sum, duration) => sum + duration, 0),
      max: Math.max(0, ...gcPauses),
    },
    serverStepMs: {
      samples: serverSteps.length,
      p50: percentile(serverSteps, 0.5),
      p95: percentile(serverSteps, 0.95),
      p99: percentile(serverSteps, 0.99),
      max: Math.max(0, ...serverSteps),
    },
    hottestClientFunctions: summarizeProfile(cpu.profile),
    largestSampledAllocators: summarizeAllocations(heap.profile),
  };
  await writeFile(
    `docs/performance-${label}.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const svg = flameSvg(cpu.profile);
  await writeFile(`docs/flame-${label}.svg`, svg);
  const chartPage = await browser.newPage({
    viewport: { width: 1400, height: 900 },
  });
  await chartPage.setContent(svg);
  await chartPage.screenshot({
    path: `docs/flame-${label}.png`,
    fullPage: true,
  });
  await chartPage.close();
  console.log(JSON.stringify(report, null, 2));
  await Promise.all(contexts.map((context) => context.close()));
} finally {
  gcObserver.disconnect();
  await browser?.close();
  await app.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
