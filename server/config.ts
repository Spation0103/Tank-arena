import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot =
  path.basename(path.dirname(serverDirectory)) === "build"
    ? path.resolve(serverDirectory, "../../..")
    : path.resolve(serverDirectory, "..");

const EnvironmentSchema = z.object({
  PORT: z.preprocess(
    (value: unknown) => (value === undefined ? 3001 : Number(value)),
    z.number().int().min(1).max(65535),
  ),
  LOG_DIR: z.string().min(1).optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  MAX_CONNECTIONS_PER_IP: z.coerce.number().int().min(1).max(10_000).default(8),
  MAX_ROOMS: z.coerce.number().int().min(2).max(100_000).default(100),
  MAX_PLAYERS_PER_ROOM: z.coerce.number().int().min(2).max(128).default(32),
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  BUILD_SHA: z.string().trim().min(1).max(128).default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export interface ServerConfig {
  readonly port: number;
  readonly logDirectory: string;
  readonly clientDirectory: string;
  readonly joinTimeoutMs: number;
  readonly pingIntervalMs: number;
  readonly maxPayloadBytes: number;
  readonly maxMessagesPerSecond: number;
  readonly maxBufferedBytes: number;
  readonly allowedOrigins: readonly string[];
  readonly maxConnectionsPerIp: number;
  readonly maxRooms: number;
  readonly maxPlayersPerRoom: number;
  readonly trustProxy: boolean;
  readonly buildSha: string;
  readonly logLevel:
    "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

export function readConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const parsed = EnvironmentSchema.parse(environment);
  return Object.freeze({
    port: parsed.PORT,
    logDirectory: path.resolve(
      parsed.LOG_DIR ?? path.join(projectRoot, "server", "logs"),
    ),
    clientDirectory: path.join(projectRoot, "client", "dist"),
    joinTimeoutMs: 5000,
    pingIntervalMs: 15000,
    maxPayloadBytes: 4096,
    maxMessagesPerSecond: 60,
    maxBufferedBytes: 64 * 1024,
    allowedOrigins: parsed.ALLOWED_ORIGINS
      ? parsed.ALLOWED_ORIGINS.split(",")
          .map((origin) => origin.trim())
          .filter(Boolean)
      : [
          "http://localhost:5173",
          "http://127.0.0.1:5173",
          "http://localhost:3001",
          "http://127.0.0.1:3001",
        ],
    maxConnectionsPerIp: parsed.MAX_CONNECTIONS_PER_IP,
    maxRooms: parsed.MAX_ROOMS,
    maxPlayersPerRoom: parsed.MAX_PLAYERS_PER_ROOM,
    trustProxy: parsed.TRUST_PROXY,
    buildSha: parsed.BUILD_SHA,
    logLevel: parsed.LOG_LEVEL,
  });
}
