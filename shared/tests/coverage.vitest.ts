import { describe, expect, it } from "vitest";
import {
  ClientMessageSchema,
  decodeInputPacket,
  decodeSnapshotJson,
  decodeSnapshotPacket,
  encodeInputPacket,
  encodeSnapshotJson,
  encodeSnapshotPacket,
  isServerMessage,
  isSnapshotStepNewer,
  parseClientMessage,
  PROTOCOL_VERSION,
} from "../protocol.js";
import { FIXED_DT, createTank, integrate, sanitizeInput } from "../physics.js";
import { ArenaSimulation, createSeededRandom } from "../simulation.js";
import { asEntityId, asInputSequence, asSimulationStep } from "../types.js";

const pilot = asEntityId("pilot");
const target = asEntityId("target");

describe("shared physics edge cases", () => {
  it("sanitizes nullish and non-boolean controls", () => {
    expect(sanitizeInput(null)).toEqual({
      forward: false,
      backward: false,
      left: false,
      right: false,
      fire: false,
      homing: false,
    });
    expect(sanitizeInput({ forward: 1 as never, fire: true }).forward).toBe(
      false,
    );
    expect(sanitizeInput({ fire: true }).fire).toBe(true);
  });

  it("does not accelerate when throttle is neutral and applies drag", () => {
    const state = { ...createTank(pilot, "#fff", 20, 20), vx: 10, vy: -5 };
    const next = integrate(state, {}, FIXED_DT);
    expect(next.vx).toBeCloseTo(10 * 0.985);
    expect(next.vy).toBeCloseTo(-5 * 0.985);
  });

  it("clamps negative and over-boundary coordinates to the arena walls", () => {
    const state = { ...createTank(pilot, "#fff", -20, 1000), vx: 0, vy: 0 };
    const next = integrate(state, {}, 0);
    expect(next.x).toBe(16);
    expect(next.y).toBe(584);
  });
});

describe("shared simulation edge cases", () => {
  it("returns an existing player and removes the player's bullets", () => {
    const simulation = new ArenaSimulation({ width: 960, height: 600 }, 1);
    const first = simulation.addPlayer(pilot, 0);
    expect(simulation.addPlayer(pilot, 2)).toBe(first);
    simulation.fire(first, asInputSequence(1), false);
    simulation.removePlayer(pilot);
    expect(simulation.tanks.has(pilot)).toBe(false);
    expect(simulation.bullets.size).toBe(0);
  });

  it("fires on cooldown boundaries and emits a bullet with input sequence", () => {
    const simulation = new ArenaSimulation({ width: 960, height: 600 }, 2);
    const player = simulation.addPlayer(pilot, 0);
    const inputs = new Map([
      [pilot, { input: { fire: true }, seq: asInputSequence(8) }],
    ]);
    simulation.step(inputs);
    expect(simulation.bullets.size).toBe(1);
    expect([...simulation.bullets.values()][0]?.fireSeq).toBe(8);
    simulation.step(inputs);
    expect(simulation.bullets.size).toBe(1);
    expect(player.fireCooldown).toBeGreaterThan(0);
  });

  it("expires bullets and respawns dead tanks after the configured delay", () => {
    const simulation = new ArenaSimulation({ width: 960, height: 600 }, 3);
    const player = simulation.addPlayer(pilot, 0);
    player.hp = 0;
    player.respawn = FIXED_DT;
    simulation.step(new Map());
    expect(player.hp).toBe(3);
    expect(player.respawn).toBe(0);
    simulation.fire(player, asInputSequence(1), false);
    const bullet = simulation.bullets.get(1);
    expect(bullet).toBeDefined();
    if (bullet) bullet.ttl = 0;
    simulation.step(new Map());
    expect(simulation.bullets.size).toBe(0);
  });

  it("does not steer homing bullets when there is no living target", () => {
    const simulation = new ArenaSimulation({ width: 960, height: 600 }, 4);
    const player = simulation.addPlayer(pilot, 0);
    simulation.fire(player, asInputSequence(1), true);
    const bullet = simulation.bullets.get(1);
    expect(bullet).toBeDefined();
    const vx = bullet?.vx;
    const vy = bullet?.vy;
    simulation.step(new Map());
    expect(bullet?.vx).toBe(vx);
    expect(bullet?.vy).toBe(vy);
  });

  it("steers homing bullets toward the nearest living opponent", () => {
    const simulation = new ArenaSimulation({ width: 960, height: 600 }, 5);
    const shooter = simulation.addPlayer(pilot, 0);
    const opponent = simulation.addPlayer(target, 1);
    shooter.x = 100;
    shooter.y = 100;
    shooter.angle = 0;
    opponent.x = 100;
    opponent.y = 10;
    simulation.fire(shooter, asInputSequence(1), true);
    const bullet = simulation.bullets.get(1);
    expect(bullet).toBeDefined();
    simulation.step(new Map());
    expect(bullet?.vy).toBeLessThan(0);
  });

  it("creates stable snapshots and a non-constant seeded sequence", () => {
    const simulation = new ArenaSimulation({ width: 500, height: 300 }, 0);
    simulation.addPlayer(pilot, 0);
    const snapshot = simulation.snapshot(
      new Map([[pilot, asInputSequence(12)]]),
      123,
    );
    expect(snapshot.serverTime).toBe(123);
    expect(snapshot.acknowledgements.get(pilot)).toBe(12);
    const random = createSeededRandom(0);
    expect(random()).not.toBe(random());
  });

  it("brands reject invalid sequence and step values", () => {
    expect(() => asInputSequence(-1)).toThrow(RangeError);
    expect(() => asSimulationStep(0.5)).toThrow(RangeError);
    expect(() => asEntityId("")).toThrow(TypeError);
  });
});

describe("shared protocol validation edge cases", () => {
  it("distinguishes malformed JSON from valid JSON with an invalid schema", () => {
    expect(parseClientMessage("{").success).toBe(false);
    const parsed = parseClientMessage({ type: "chat", text: "" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.reason).toBe("invalid-message");
  });

  it("rejects extra client fields and accepts the inferred join shape", () => {
    expect(
      ClientMessageSchema.safeParse({
        type: "leave",
        coordinates: { x: 1, y: 1 },
      }).success,
    ).toBe(false);
    expect(parseClientMessage({ type: "leave" }).success).toBe(true);
  });

  it("rejects invalid binary versions, flags, and non-finite fields", () => {
    const packet = new Uint8Array(encodeInputPacket(asInputSequence(1), {}));
    packet[0] = 9;
    expect(() => decodeInputPacket(packet)).toThrow(RangeError);
    packet[0] = PROTOCOL_VERSION;
    packet[6] = 0x80;
    expect(() => decodeInputPacket(packet)).toThrow(RangeError);

    const snapshot = encodeSnapshotPacket(
      {
        tick: asSimulationStep(1),
        serverTime: 0,
        acknowledgements: new Map(),
        tanks: [
          {
            kind: "tank",
            index: 0,
            x: Number.NaN,
            y: 0,
            vx: 0,
            vy: 0,
            angle: 0,
            hp: 3,
            score: 0,
          },
        ],
        bullets: [],
        obstacles: [],
        pickup: { x: 480, y: 300, active: true },
      },
      pilot,
    );
    expect(() => decodeSnapshotPacket(snapshot)).toThrow(RangeError);
  });

  it("validates binary bullet flags, IDs and snapshot length", () => {
    const snapshot = {
      tick: asSimulationStep(1),
      serverTime: 0,
      acknowledgements: new Map(),
      tanks: [],
      bullets: [
        {
          kind: "bullet" as const,
          id: 1,
          ownerIndex: 0,
          fireSeq: asInputSequence(0),
          x: 1,
          y: 1,
          vx: 1,
          vy: 1,
          homing: false,
        },
      ],
      obstacles: [],
      pickup: { x: 480, y: 300, active: true },
    };
    const packet = new Uint8Array(encodeSnapshotPacket(snapshot, pilot));
    packet[26 + 3] = 2;
    expect(() => decodeSnapshotPacket(packet)).toThrow(/flags/);
    expect(() =>
      decodeSnapshotPacket(encodeSnapshotPacket(snapshot, pilot).slice(0, 26)),
    ).toThrow(/length/);
  });

  it("round-trips JSON states and detects server message discriminants", () => {
    const snapshot = {
      tick: asSimulationStep(3),
      serverTime: 7,
      acknowledgements: new Map([[pilot, asInputSequence(4)]]),
      tanks: [],
      bullets: [],
      obstacles: [],
      pickup: { x: 480, y: 300, active: true },
    };
    const message = encodeSnapshotJson(snapshot, pilot);
    expect(decodeSnapshotJson(message)).toEqual(message);
    expect(isServerMessage(message)).toBe(true);
    expect(isServerMessage({ type: "unknown" })).toBe(false);
    expect(() => decodeSnapshotJson({ type: "state" })).toThrow(TypeError);
  });

  it("orders snapshot ticks and rejects non-finite angles during encoding", () => {
    expect(isSnapshotStepNewer(asSimulationStep(2), asSimulationStep(1))).toBe(
      true,
    );
    expect(isSnapshotStepNewer(asSimulationStep(1), asSimulationStep(1))).toBe(
      false,
    );
    const malformed = {
      tick: asSimulationStep(0),
      serverTime: 0,
      acknowledgements: new Map(),
      tanks: [
        {
          kind: "tank" as const,
          index: 0,
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          angle: Infinity,
          hp: 3,
          score: 0,
        },
      ],
      bullets: [],
      obstacles: [],
      pickup: { x: 480, y: 300, active: true },
    };
    expect(() => encodeSnapshotPacket(malformed, pilot)).toThrow(RangeError);
  });
});
