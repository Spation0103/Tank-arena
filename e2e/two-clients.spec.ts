import { expect, test } from "@playwright/test";
import { ServerMessageSchema } from "../shared/protocol.js";
import type { StateMessage } from "../shared/protocol.js";

interface ClientCapture {
  playerId: string | null;
  readonly states: StateMessage[];
}

test("two clients see movement and receive chat in the same room", async ({
  browser,
}) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  const captures: ClientCapture[] = [
    { playerId: null, states: [] },
    { playerId: null, states: [] },
  ];

  for (const [index, page] of [first, second].entries()) {
    const capture = captures[index];
    if (!capture) throw new Error("Missing browser capture state.");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    cdp.on("Network.webSocketFrameReceived", ({ response }) => {
      if (response.opcode !== 1) return;
      const parsed = ServerMessageSchema.safeParse(
        JSON.parse(response.payloadData),
      );
      if (!parsed.success)
        throw new Error("Server sent an invalid JSON frame.");
      if (parsed.data.type === "welcome")
        capture.playerId = parsed.data.playerId;
      if (parsed.data.type === "state") capture.states.push(parsed.data);
    });
  }

  await Promise.all([
    first.goto("/?protocol=json"),
    second.goto("/?protocol=json"),
  ]);
  await Promise.all([
    first.locator("#join-button").click(),
    second.locator("#join-button").click(),
  ]);
  await expect(first.locator("#player-count")).toHaveText("2 ГРАВЦІ");
  await expect(second.locator("#player-count")).toHaveText("2 ГРАВЦІ");

  const firstCapture = captures[0];
  const secondCapture = captures[1];
  expect(firstCapture).toBeDefined();
  expect(secondCapture).toBeDefined();
  await expect
    .poll(() => Boolean(firstCapture?.playerId && secondCapture?.playerId), {
      timeout: 5000,
    })
    .toBe(true);
  await expect
    .poll(() => secondCapture?.states.length ?? 0, { timeout: 5000 })
    .toBeGreaterThan(2);
  const movingPlayerId = firstCapture?.playerId;
  const before = secondCapture?.states.at(-1);
  expect(before).toBeDefined();
  const movingTank = before?.tanks.find((tank) => tank.id === movingPlayerId);
  expect(movingTank?.id).toBeTruthy();

  await first.keyboard.down("w");
  await expect
    .poll(
      () => {
        const latest = secondCapture?.states.at(-1);
        const tank = latest?.tanks.find((entry) => entry.id === movingPlayerId);
        return tank && movingTank
          ? Math.hypot(tank.x - movingTank.x, tank.y - movingTank.y)
          : 0;
      },
      { timeout: 5000 },
    )
    .toBeGreaterThan(1);
  await first.keyboard.up("w");

  await first.locator("#chat-message").fill("Playwright ready");
  await first.locator("#chat-message").press("Enter");
  await expect(second.locator("#chat-log")).toContainText("Playwright ready");

  await firstContext.close();
  await secondContext.close();
});
