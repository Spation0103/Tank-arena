import { EventEmitter } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Transform } from "node:stream";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

type MatchLogEvent = Readonly<Record<string, unknown>>;

interface MatchLoggerEvents {
  error: [error: Error];
  backpressure: [{ readonly matchId: string }];
}

export class MatchLogger extends EventEmitter<MatchLoggerEvents> {
  readonly logDirectory: string;
  readonly matchId: string;
  readonly filePath: string;
  readonly source = new PassThrough({ objectMode: true, highWaterMark: 32 });
  readonly transform: Transform;
  closed = false;
  closePromise: Promise<void> | null = null;
  task: Promise<void> | null = null;
  readonly ready: Promise<void>;

  constructor(logDirectory: string, matchId: string) {
    super();
    this.logDirectory = logDirectory;
    this.matchId = matchId;
    this.filePath = path.join(logDirectory, `${matchId}.ndjson`);
    this.transform = new Transform({
      writableObjectMode: true,
      transform(event: MatchLogEvent, _encoding, callback) {
        callback(null, `${JSON.stringify(event)}\n`);
      },
    });
    this.ready = mkdir(logDirectory, { recursive: true }).then(() => {
      this.task = pipeline(
        this.source,
        this.transform,
        createWriteStream(this.filePath, { flags: "a" }),
      );
      void this.task.catch((error: Error) => this.emit("error", error));
    });
  }

  write(event: MatchLogEvent): boolean {
    if (this.closed) return false;
    if (this.source.write(event)) return true;
    this.emit("backpressure", { matchId: this.matchId });
    return false;
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      await this.ready;
      this.source.end();
      if (!this.task) throw new Error("Match logger pipeline was not started.");
      await this.task;
    })();
    return this.closePromise;
  }
}

export function replayStream(logDirectory: string, matchId: string): Readable {
  return createReadStream(path.join(logDirectory, `${matchId}.ndjson`));
}
