export interface RateLimitState {
  messagesThisSecond: number;
  rateWindowStarted: number;
}

export function withinRateLimit(
  client: RateLimitState,
  limit: number,
  now = Date.now(),
): boolean {
  if (now - client.rateWindowStarted >= 1000) {
    client.rateWindowStarted = now;
    client.messagesThisSecond = 0;
  }
  client.messagesThisSecond += 1;
  return client.messagesThisSecond <= limit;
}
