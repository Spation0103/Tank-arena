import type { AssetProgress } from "./asset-loader.js";

function getContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable.");
  return context;
}

export function createLoadingProgress(canvas: HTMLCanvasElement): {
  draw(progress: AssetProgress): void;
  destroy(): void;
} {
  const context = getContext(canvas);
  let width = 0;
  let height = 0;
  let ratio = 1;

  function resize() {
    const bounds = canvas.getBoundingClientRect();
    width = bounds.width;
    height = bounds.height;
    ratio = Math.max(1, devicePixelRatio || 1);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function draw({
    completed = 0,
    total = 1,
    key = null,
    status = "loading",
  }: AssetProgress): void {
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#171d17";
    context.fillRect(0, 0, width, height);
    const barWidth = Math.min(width - 48, 420);
    const x = (width - barWidth) / 2;
    const y = height / 2;
    const progress = total ? completed / total : 0;
    context.fillStyle = "#9da597";
    context.font = "12px monospace";
    context.textAlign = "center";
    context.fillText(
      status === "error"
        ? `ПОМИЛКА: ${key ?? "asset"}`
        : `ЗАВАНТАЖЕННЯ ${completed}/${total}`,
      width / 2,
      y - 20,
    );
    context.strokeStyle = "#67725c";
    context.strokeRect(x, y, barWidth, 10);
    context.fillStyle = "#c1e886";
    context.fillRect(x + 1, y + 1, Math.max(0, (barWidth - 2) * progress), 8);
  }

  resize();
  window.addEventListener("resize", resize);
  return {
    draw,
    destroy() {
      window.removeEventListener("resize", resize);
    },
  };
}
