import assert from "node:assert/strict";
import test from "node:test";
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  FIXED_DT,
  createTank,
  integrate,
} from "../src/physics.js";

test("tank integration is deterministic at the fixed timestep", () => {
  const input = { forward: true, right: true };
  const first = integrate(createTank("one", "#fff", 100, 100), input, FIXED_DT);
  const second = integrate(
    createTank("one", "#fff", 100, 100),
    input,
    FIXED_DT,
  );
  assert.deepEqual(first, second);
  assert.ok(first.vx > 0);
  assert.ok(first.vy < 0);
});

test("tank stops at all arena edges", () => {
  const rightEdge = {
    ...createTank("one", "#fff", ARENA_WIDTH - 1, 200),
    angle: 0,
    vx: 100,
  };
  const bottomEdge = {
    ...createTank("two", "#fff", 200, ARENA_HEIGHT - 1),
    angle: Math.PI / 2,
    vy: 100,
  };
  assert.equal(integrate(rightEdge, {}, FIXED_DT).x, ARENA_WIDTH - 16);
  assert.equal(integrate(bottomEdge, {}, FIXED_DT).y, ARENA_HEIGHT - 16);
});

test("tank speed remains capped", () => {
  const tank = { ...createTank("one", "#fff", 0, 0), vx: 1000, vy: 1000 };
  const updated = integrate(tank, {}, FIXED_DT);
  assert.ok(Math.hypot(updated.vx, updated.vy) <= 210);
});
