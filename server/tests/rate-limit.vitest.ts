import { describe, expect, it } from "vitest";
import { withinRateLimit } from "../rate-limit.js";

describe("server message rate limit", () => {
  it("accepts messages up to the configured per-second limit", () => {
    const client = { messagesThisSecond: 0, rateWindowStarted: 1000 };
    expect(withinRateLimit(client, 2, 1000)).toBe(true);
    expect(withinRateLimit(client, 2, 1100)).toBe(true);
    expect(withinRateLimit(client, 2, 1200)).toBe(false);
  });

  it("resets the counter at the next window boundary", () => {
    const client = { messagesThisSecond: 3, rateWindowStarted: 1000 };
    expect(withinRateLimit(client, 1, 2000)).toBe(true);
    expect(client.messagesThisSecond).toBe(1);
    expect(client.rateWindowStarted).toBe(2000);
  });

  it("does not reset before a full second elapses", () => {
    const client = { messagesThisSecond: 1, rateWindowStarted: 1000 };
    expect(withinRateLimit(client, 1, 1999)).toBe(false);
    expect(client.rateWindowStarted).toBe(1000);
  });
});
