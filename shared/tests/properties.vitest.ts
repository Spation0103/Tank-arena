import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decodeInputPacket,
  decodeSnapshotPacket,
  encodeInputPacket,
  encodeSnapshotPacket,
  parseClientMessage,
} from "../protocol.js";
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  FIXED_DT,
  createTank,
  integrate,
} from "../physics.js";
import { ArenaSimulation } from "../simulation.js";
import { asEntityId, asInputSequence, asSimulationStep } from "../types.js";
import type { SimulationSnapshot } from "../types.js";

const finiteFloat = (min: number, max: number) =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

describe("fast-check protocol, simulation, and validation properties", () => {
  it("binary snapshots decode the original message within float and angle quantization", () => {
    fc.assert(
      fc.property(
        finiteFloat(-2000, 2000),
        finiteFloat(-2000, 2000),
        finiteFloat(-1000, 1000),
        finiteFloat(-1000, 1000),
        finiteFloat(-Math.PI * 4, Math.PI * 4),
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 0xffffffff }),
        (x, y, vx, vy, angle, hp, score) => {
          const id = asEntityId("tank");
          const snapshot: SimulationSnapshot = {
            tick: asSimulationStep(42),
            serverTime: 123,
            acknowledgements: new Map([[id, asInputSequence(7)]]),
            tanks: [
              {
                kind: "tank",
                id,
                index: 0,
                x,
                y,
                vx,
                vy,
                angle,
                hp,
                score,
              },
            ],
            bullets: [],
            obstacles: [],
            pickup: { x: 480, y: 300, active: true },
          };
          const decoded = decodeSnapshotPacket(
            encodeSnapshotPacket(snapshot, id),
          );
          const tank = decoded.tanks[0];
          expect(tank).toBeDefined();
          expect(Math.abs(tank!.x - x)).toBeLessThan(0.001);
          expect(Math.abs(tank!.y - y)).toBeLessThan(0.001);
          expect(Math.abs(tank!.vx - vx)).toBeLessThan(0.001);
          expect(Math.abs(tank!.vy - vy)).toBeLessThan(0.001);
          const normalized = Math.atan2(Math.sin(angle), Math.cos(angle));
          expect(Math.abs(tank!.angle - normalized)).toBeLessThan(0.0001);
          expect(tank!.hp).toBe(hp);
          expect(tank!.score).toBe(score);
          expect(decoded.ack).toBe(7);
        },
      ),
      { numRuns: 250 },
    );
  });

  it("packet size matches the header and declared entity record lengths", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 12 }),
        fc.integer({ min: 0, max: 12 }),
        (tankCount, bulletCount) => {
          const tanks = Array.from({ length: tankCount }, (_, index) => ({
            kind: "tank" as const,
            index,
            x: index,
            y: index,
            vx: 0,
            vy: 0,
            angle: 0,
            hp: 3,
            score: 0,
          }));
          const bullets = Array.from({ length: bulletCount }, (_, index) => ({
            kind: "bullet" as const,
            id: index + 1,
            ownerIndex: 0,
            fireSeq: asInputSequence(index),
            x: index,
            y: index,
            vx: 0,
            vy: 0,
            homing: false,
          }));
          const packet = encodeSnapshotPacket(
            {
              tick: asSimulationStep(1),
              serverTime: 0,
              acknowledgements: new Map(),
              tanks,
              bullets,
              obstacles: [],
              pickup: { x: 480, y: 300, active: true },
            },
            asEntityId("pilot"),
          );
          expect(packet.byteLength).toBe(
            26 + tankCount * 24 + bulletCount * 24,
          );
          const view = new DataView(packet);
          expect(view.getUint8(14)).toBe(tankCount);
          expect(view.getUint8(15)).toBe(bulletCount);
        },
      ),
    );
  });

  it("short or malformed binary frames reject as errors, not process failures", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 15 }), (bytes) => {
        expect(() => decodeSnapshotPacket(bytes)).toThrow(RangeError);
      }),
    );
  });

  it("integrated tank coordinates remain within arena bounds", () => {
    fc.assert(
      fc.property(
        finiteFloat(-10000, 10000),
        finiteFloat(-10000, 10000),
        finiteFloat(-Math.PI * 20, Math.PI * 20),
        finiteFloat(-1000, 1000),
        finiteFloat(-1000, 1000),
        finiteFloat(0, 0.25),
        fc.boolean(),
        fc.boolean(),
        (x, y, angle, vx, vy, dt, forward, right) => {
          const state = {
            ...createTank(asEntityId("pilot"), "#fff", x, y),
            angle,
            vx,
            vy,
          };
          const next = integrate(state, { forward, right }, dt);
          expect(next.x).toBeGreaterThanOrEqual(0);
          expect(next.x).toBeLessThan(ARENA_WIDTH);
          expect(next.y).toBeGreaterThanOrEqual(0);
          expect(next.y).toBeLessThan(ARENA_HEIGHT);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("client input parsing accepts valid messages and rejects malformed payloads", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 16 })
          .filter((value) => value.trim().length > 0),
        fc.string({ minLength: 1, maxLength: 40 }),
        (name, roomId) => {
          const parsed = parseClientMessage({
            type: "join",
            name,
            roomId,
            protocol: "binary",
          });
          expect(parsed.success).toBe(true);
          expect(
            parseClientMessage({
              type: "join",
              name: "",
              roomId,
              protocol: "bogus",
            }).success,
          ).toBe(false);
          expect(parseClientMessage("{broken").success).toBe(false);
          expect(parseClientMessage({ type: "missing" }).success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("input frames round-trip every boolean combination", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 0, max: 0xffffffff }),
        (forward, backward, left, right, fire, homing, sequence) => {
          const input = { forward, backward, left, right, fire, homing };
          expect(
            decodeInputPacket(
              encodeInputPacket(asInputSequence(sequence), input),
            ),
          ).toEqual({ sequence, input });
        },
      ),
    );
  });

  it("seeded simulations produce identical snapshots for generated inputs", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            forward: fc.boolean(),
            left: fc.boolean(),
            right: fc.boolean(),
          }),
          { maxLength: 100 },
        ),
        (inputs) => {
          const id = asEntityId("pilot");
          const first = new ArenaSimulation(
            { width: 960, height: 600 },
            0x1234,
          );
          const second = new ArenaSimulation(
            { width: 960, height: 600 },
            0x1234,
          );
          first.addPlayer(id, 0);
          second.addPlayer(id, 0);
          for (const [index, input] of inputs.entries()) {
            const map = new Map([
              [
                id,
                {
                  input,
                  seq: asInputSequence(index),
                },
              ],
            ]);
            first.step(map, FIXED_DT);
            second.step(map, FIXED_DT);
          }
          expect(first.snapshot(new Map(), 0)).toEqual(
            second.snapshot(new Map(), 0),
          );
        },
      ),
    );
  });
});
