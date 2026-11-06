import { z } from "zod";
import { delay, throwIfAborted } from "./async-utils.js";

const RETRY_LIMIT = 3;
const BASE_DELAY = 120;
const MAX_DELAY = 1500;

export const AssetManifestSchema = z.object({
  assets: z.array(
    z.discriminatedUnion("type", [
      z.object({
        key: z.string().min(1),
        type: z.literal("image"),
        url: z.string().min(1),
      }),
      z.object({
        key: z.string().min(1),
        type: z.literal("audio"),
        url: z.string().min(1),
      }),
      z.object({
        key: z.string().min(1),
        type: z.literal("json"),
        url: z.string().min(1),
      }),
    ]),
  ),
});

export type AssetManifest = z.infer<typeof AssetManifestSchema>;
export type AssetProgress = {
  readonly completed: number;
  readonly total: number;
  readonly key?: string | null;
  readonly status?: "start" | "loading" | "loaded" | "error";
  readonly error?: unknown;
};

interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly retries?: number;
  readonly timeoutMs?: number;
  readonly audioContext?: AudioContext;
}

interface LoadAllOptions extends RequestOptions {
  readonly onProgress?: (progress: AssetProgress) => void;
}

type Asset = AssetManifest["assets"][number];
type RetryOptions = Pick<RequestOptions, "signal" | "retries" | "timeoutMs">;

export class HttpError extends Error {
  readonly status: number;

  constructor(response: Response) {
    super(`Request failed: ${response.status} ${response.statusText}`);
    this.name = "HttpError";
    this.status = response.status;
  }
}

export async function fetchJson(
  url: string,
  { signal }: Pick<RequestOptions, "signal"> = {},
): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new HttpError(response);
  const value: unknown = await response.json();
  return value;
}

export function loadJson(
  url: string,
  options: RequestOptions = {},
): Promise<unknown> {
  return retry((signal) => fetchJson(url, { signal }), options);
}

async function retry<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  { signal, retries = RETRY_LIMIT, timeoutMs = 8000 }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const attemptSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    try {
      return await operation(attemptSignal);
    } catch (error: unknown) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (
        error instanceof HttpError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        throw error;
      }
      if (attempt >= retries) throw error;
      const exponentialDelay = Math.min(BASE_DELAY * 2 ** attempt, MAX_DELAY);
      const jitter = Math.random() * exponentialDelay * 0.3;
      await delay(exponentialDelay + jitter, signal);
    }
  }
}

export function loadImage(
  url: string,
  options: RetryOptions = {},
): Promise<ImageBitmap | HTMLImageElement> {
  return retry(async (signal) => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new HttpError(response);
    const blob = await response.blob();
    throwIfAborted(signal);
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(blob);
        if (signal.aborted) {
          bitmap.close();
          throwIfAborted(signal);
        }
        return bitmap;
      } catch (error: unknown) {
        throwIfAborted(signal);
        if (error instanceof DOMException && error.name === "AbortError") {
          throw error;
        }
      }
    }
    return imageFromBlob(blob, signal);
  }, options);
}

function imageFromBlob(
  blob: Blob,
  signal: AbortSignal,
): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(blob);
    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("Could not decode image asset."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    image.src = objectUrl;
  });
}

export function loadAudio(
  url: string,
  options: RequestOptions = {},
): Promise<AudioBuffer> {
  const { audioContext } = options;
  if (!audioContext) {
    return Promise.reject(new Error("loadAudio requires an AudioContext."));
  }
  return retry(async (signal) => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new HttpError(response);
    const data = await response.arrayBuffer();
    throwIfAborted(signal);
    const buffer = await audioContext.decodeAudioData(data);
    throwIfAborted(signal);
    return buffer;
  }, options);
}

export async function loadAll(
  manifest: AssetManifest,
  { signal, audioContext, onProgress, timeoutMs }: LoadAllOptions = {},
): Promise<Map<string, unknown>> {
  const assets = manifest.assets;
  let completed = 0;
  onProgress?.({ completed, total: assets.length, key: null, status: "start" });

  const controller = new AbortController();
  const assetSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const loaded = await Promise.all(
    assets.map(async (asset) => {
      try {
        const options = { signal: assetSignal, audioContext, timeoutMs };
        const value = await loadAsset(asset, options);
        completed += 1;
        onProgress?.({
          completed,
          total: assets.length,
          key: asset.key,
          status: "loaded",
        });
        return { key: asset.key, value };
      } catch (error: unknown) {
        controller.abort(error);
        onProgress?.({
          completed,
          total: assets.length,
          key: asset.key,
          status: "error",
          error,
        });
        throw error;
      }
    }),
  );
  const entries: [string, unknown][] = loaded.map(({ key, value }) => [
    key,
    value,
  ]);
  return new Map(entries);
}

async function loadAsset(
  asset: Asset,
  options: RequestOptions,
): Promise<unknown> {
  switch (asset.type) {
    case "image":
      return loadImage(asset.url, options);
    case "audio":
      return loadAudio(asset.url, options);
    case "json":
      return loadJson(asset.url, options);
    default:
      return assertNever(asset);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported asset type: ${JSON.stringify(value)}`);
}
