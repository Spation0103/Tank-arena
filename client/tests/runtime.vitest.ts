import { describe, expect, it, vi } from "vitest";
import { Asteroid, Bullet, Particle, Pickup, Ship } from "../src/entities.js";
import { CircleCollisionSystem } from "../src/collision-system.js";
import { FIXED_DT, createTank, integrate } from "../src/physics.js";
import { ClientPrediction } from "../src/prediction.js";
import { Vector2 } from "../src/vector2.js";
import { World } from "../src/world.js";
import { createLoop } from "../src/loop.js";
import { asEntityId, asInputSequence } from "../../shared/types.js";
import type { PredictedState } from "../src/prediction.js";

describe("Vector2 remains pure", () => {
  it.each([
    [0, 0, 1, 2, 1, 2],
    [3, 4, -2, 5, 1, 9],
    [-8, 2, 8, -2, 0, 0],
    [1.5, 2.5, 1.5, -0.5, 3, 2],
    [100, -100, 4, 5, 104, -95],
  ])("adds (%s, %s) and (%s, %s)", (ax, ay, bx, by, x, y) => {
    const first = new Vector2(ax, ay);
    const second = new Vector2(bx, by);
    expect(first.add(second)).toEqual(new Vector2(x, y));
    expect(first).toEqual(new Vector2(ax, ay));
    expect(second).toEqual(new Vector2(bx, by));
  });

  it.each([
    [3, 4, 5],
    [0, 0, 0],
    [-3, 4, 5],
  ])("normalizes vector (%s, %s)", (x, y, magnitude) => {
    const normalized = new Vector2(x, y).normalize();
    expect(normalized.magnitude()).toBe(magnitude === 0 ? 0 : 1);
  });
});

describe("fixed-step integration", () => {
  it.each([
    [{ forward: true }, 120, 100],
    [{ backward: true }, 120, 100],
    [{ left: true }, 120, 100],
    [{ right: true }, 120, 100],
    [{}, 0, 0],
  ])("integrates an input without mutating its tank", (input, x, y) => {
    const tank = createTank(asEntityId("p"), "#fff", x, y);
    const before = { ...tank };
    const result = integrate(tank, input, FIXED_DT);
    expect(tank).toEqual(before);
    expect(result).not.toBe(tank);
    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result.x).toBeLessThan(960);
    expect(result.y).toBeGreaterThanOrEqual(0);
    expect(result.y).toBeLessThan(600);
  });
});

describe("collision system", () => {
  it.each([
    ["hit ship", 3, "ship"],
    ["hit asteroid", 2, "asteroid"],
  ] as const)("resolves a bullet to %s", (_label, targetHp, kind) => {
    const world = new World({ random: () => 1 });
    const owner = world.spawn(new Ship({ id: asEntityId("owner") }));
    const target =
      kind === "ship"
        ? world.spawn(new Ship({ id: asEntityId("target") }))
        : world.spawn(new Asteroid({ id: asEntityId("target") }));
    const bullet = world.spawn(
      new Bullet({ position: target.position, ownerId: owner.id }),
    );
    new CircleCollisionSystem().resolve(world);
    expect(bullet.dead).toBe(true);
    expect(target.hp).toBe(targetHp - 1);
  });

  it("does not hit a bullet owner", () => {
    const world = new World();
    const ship = world.spawn(new Ship({ id: asEntityId("owner") }));
    const bullet = world.spawn(
      new Bullet({ position: ship.position, ownerId: ship.id }),
    );
    new CircleCollisionSystem().resolve(world);
    expect(ship.hp).toBe(3);
    expect(bullet.dead).toBe(false);
  });

  it("does not resolve non-overlapping entities", () => {
    const world = new World();
    const ship = world.spawn(
      new Ship({ id: asEntityId("ship"), position: new Vector2(10, 10) }),
    );
    const bullet = world.spawn(
      new Bullet({
        id: asEntityId("bullet"),
        position: new Vector2(100, 100),
        ownerId: asEntityId("other"),
      }),
    );
    new CircleCollisionSystem().resolve(world);
    expect(ship.hp).toBe(3);
    expect(bullet.dead).toBe(false);
  });

  it("repairs a damaged ship on pickup collection", () => {
    const world = new World();
    const ship = world.spawn(new Ship({ id: asEntityId("ship") }));
    ship.takeDamage();
    world.spawn(new Pickup({ position: ship.position }));
    world.collisionSystem.resolve(world);
    expect(ship.hp).toBe(3);
  });

  it("marks expired particles and bullets dead", () => {
    const particle = new Particle({ ttl: FIXED_DT });
    const bullet = new Bullet({ ttl: FIXED_DT });
    particle.update(FIXED_DT);
    bullet.update(FIXED_DT, new World());
    expect(particle.dead).toBe(true);
    expect(bullet.dead).toBe(true);
  });

  it("reuses bullet and particle objects after sweeping dead entities", () => {
    const world = new World();
    const bullet = world.spawnBullet({
      ownerId: asEntityId("owner"),
      position: new Vector2(1, 2),
    });
    const bulletId = bullet.id;
    bullet.dead = true;
    world.sweep();
    const reusedBullet = world.spawnBullet({
      ownerId: asEntityId("next-owner"),
      position: new Vector2(8, 9),
      ttl: 4,
    });
    expect(reusedBullet).toBe(bullet);
    expect(reusedBullet.id).not.toBe(bulletId);
    expect(reusedBullet.ownerId).toBe(asEntityId("next-owner"));
    expect(reusedBullet.ttl).toBe(4);
    expect(reusedBullet.dead).toBe(false);
    expect(world.poolStats.reusedBullets).toBe(1);

    const particle = world.spawnParticle({ ttl: 1 });
    particle.dead = true;
    world.sweep();
    const reusedParticle = world.spawnParticle({ ttl: 2 });
    expect(reusedParticle).toBe(particle);
    expect(reusedParticle.ttl).toBe(2);
    expect(reusedParticle.maxTtl).toBe(2);
    expect(world.poolStats.reusedParticles).toBe(1);
  });

  it("updates entity vectors in place each simulation step", () => {
    const world = new World();
    const ship = world.spawn(new Ship({ id: asEntityId("pilot") }));
    const { position, previousPosition, velocity } = ship;
    ship.setInput({ forward: true });
    ship.update(FIXED_DT);
    expect(ship.position).toBe(position);
    expect(ship.previousPosition).toBe(previousPosition);
    expect(ship.velocity).toBe(velocity);
  });
});

describe("client/server prediction reconciliation", () => {
  it.each([1, 2, 3, 4])("replays inputs newer than ack %i", (ack) => {
    const id = asEntityId("pilot");
    const initial: PredictedState = {
      ...createTank(id, "#fff", 480, 300),
      hp: 3,
      score: 0,
    };
    const prediction = new ClientPrediction(initial);
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      prediction.step(
        { forward: sequence % 2 === 0, right: true },
        asInputSequence(sequence),
      );
    }
    const ackState = integrate(initial, { forward: true }, FIXED_DT);
    prediction.reconcile(ackState, asInputSequence(ack));
    expect(prediction.pendingCount).toBe(5 - ack);
    expect(prediction.sequence).toBe(asInputSequence(5));
  });
});

describe("fixed-step game loop", () => {
  it("accumulates elapsed time and calls simulation with fixed dt", () => {
    vi.useFakeTimers();
    let rafTime = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      globalThis.setTimeout(() => {
        rafTime += 1000 / 60;
        callback(rafTime);
      }, 1000 / 60),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) =>
      globalThis.clearTimeout(id),
    );
    vi.stubGlobal("window", globalThis);
    const updates: number[] = [];
    const loop = createLoop({
      update: (dt) => updates.push(dt),
      render: () => {},
      onMetrics: () => {},
    });
    loop.start();
    vi.advanceTimersByTime(250);
    expect(updates.length).toBeGreaterThanOrEqual(10);
    expect(updates.every((dt) => dt === FIXED_DT)).toBe(true);
    vi.clearAllTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("switches to interval mode and emits metrics", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      globalThis.setTimeout(() => callback(performance.now()), 16),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) =>
      globalThis.clearTimeout(id),
    );
    const metrics = vi.fn();
    const loop = createLoop({
      update: () => {},
      render: () => {},
      onMetrics: metrics,
    });
    loop.start();
    loop.setMode("interval");
    vi.advanceTimersByTime(1100);
    expect(metrics).toHaveBeenCalled();
    vi.clearAllTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
