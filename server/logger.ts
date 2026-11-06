import { pino } from "pino";

export function createLogger(level: pino.LevelWithSilent, buildSha: string) {
  return pino({
    level,
    base: { service: "tank-arena", buildSha },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "headers.authorization",
        "headers.cookie",
        "password",
        "token",
        "secret",
      ],
      censor: "[REDACTED]",
    },
  });
}
