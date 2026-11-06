import { FIXED_DT } from "./physics.js";

const MAX_FRAME_DELTA = 0.25;
const MAX_STEPS_PER_FRAME = 8;

export type LoopMode = "raf" | "interval" | "variable";

export interface LoopMetrics {
  readonly stepsPerSecond: number;
  readonly framesPerSecond: number;
  readonly frameTime: string;
}

interface LoopOptions {
  readonly update: (dt: number) => void;
  readonly render: (alpha: number) => void;
  readonly onMetrics: (metrics: LoopMetrics) => void;
}

export function createLoop({ update, render, onMetrics }: LoopOptions): {
  start(): void;
  stop(): void;
  setMode(nextMode: LoopMode): void;
  blockNextFrame(): void;
} {
  let mode: LoopMode = "raf";
  let rafId = 0;
  let intervalId = 0;
  let previousTime = 0;
  let accumulator = 0;
  let frames = 0;
  let steps = 0;
  let metricsElapsed = 0;
  let maxFrameTime = 0;
  let blockNextFrame = false;
  let running = false;

  function tick(now: number): void {
    if (!running) return;
    const start = performance.now();
    const elapsed = previousTime === 0 ? 0 : (now - previousTime) / 1000;
    previousTime = now;
    frames += 1;
    metricsElapsed += elapsed;

    if (blockNextFrame) {
      blockNextFrame = false;
      const blockUntil = performance.now() + 80;
      while (performance.now() < blockUntil) {
        // Intentionally block the main thread for the event-loop experiment.
      }
    }

    if (mode === "variable") {
      if (elapsed > 0) {
        update(Math.min(elapsed, MAX_FRAME_DELTA));
        steps += 1;
      }
      accumulator = 0;
    } else {
      accumulator += Math.min(elapsed, MAX_FRAME_DELTA);
      let frameSteps = 0;
      while (accumulator >= FIXED_DT && frameSteps < MAX_STEPS_PER_FRAME) {
        update(FIXED_DT);
        accumulator -= FIXED_DT;
        steps += 1;
        frameSteps += 1;
      }
      if (frameSteps === MAX_STEPS_PER_FRAME) accumulator = 0;
    }

    render(mode === "variable" ? 1 : accumulator / FIXED_DT);
    maxFrameTime = Math.max(maxFrameTime, performance.now() - start);

    if (metricsElapsed >= 0.5) {
      onMetrics({
        stepsPerSecond: Math.round(steps / metricsElapsed),
        framesPerSecond: Math.round(frames / metricsElapsed),
        frameTime: maxFrameTime.toFixed(2),
      });
      frames = 0;
      steps = 0;
      metricsElapsed = 0;
      maxFrameTime = 0;
    }

    if (mode === "raf") schedule();
  }

  function schedule(): void {
    if (!running) return;
    if (mode === "interval") {
      intervalId = window.setInterval(() => tick(performance.now()), 1000 / 60);
    } else {
      rafId = requestAnimationFrame(tick);
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    previousTime = 0;
    schedule();
  }

  function stop(): void {
    running = false;
    cancelAnimationFrame(rafId);
    window.clearInterval(intervalId);
    previousTime = 0;
    accumulator = 0;
  }

  function setMode(nextMode: LoopMode): void {
    mode = nextMode;
    if (running) {
      cancelAnimationFrame(rafId);
      window.clearInterval(intervalId);
      previousTime = 0;
      schedule();
    }
  }

  return {
    start,
    stop,
    setMode,
    blockNextFrame() {
      blockNextFrame = true;
    },
  };
}
