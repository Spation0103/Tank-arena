import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeInputPacket,
  decodeSnapshotPacket,
  encodeInputPacket,
  encodeSnapshotPacket,
} from "../protocol.js";
import { asEntityId, asInputSequence, asSimulationStep } from "../types.js";
import type { SimulationSnapshot } from "../types.js";

test("input packets encode sequence and flags in a little-endian DataView", () => {
  const packet = encodeInputPacket(asInputSequence(0x12345678), {
    forward: true,
    right: true,
    fire: true,
    homing: true,
  });
  const bytes = new Uint8Array(packet);
  assert.deepEqual([...bytes], [2, 1, 0x78, 0x56, 0x34, 0x12, 0x39]);
  assert.deepEqual(decodeInputPacket(packet), {
    sequence: 0x12345678,
    input: {
      forward: true,
      backward: false,
      left: false,
      right: true,
      fire: true,
      homing: true,
    },
  });
});

test("snapshot packets round-trip tanks, angles, bullets and per-client ack", () => {
  const pilotId = asEntityId("pilot-a");
  const snapshot: SimulationSnapshot = {
    tick: asSimulationStep(20),
    serverTime: 12345,
    acknowledgements: new Map([[pilotId, asInputSequence(19)]]),
    tanks: [
      {
        kind: "tank",
        id: pilotId,
        color: "#c1e886",
        index: 0,
        x: 17.25,
        y: 29.5,
        vx: -1,
        vy: 2,
        angle: -Math.PI / 2,
        hp: 5,
        score: 40000,
      },
    ],
    bullets: [
      {
        kind: "bullet",
        id: 8,
        ownerId: pilotId,
        ownerIndex: 0,
        fireSeq: asInputSequence(18),
        homing: true,
        x: 50,
        y: 60,
        vx: 10,
        vy: -11,
      },
    ],
    obstacles: [{ index: 0, x: 120, y: 80, radius: 25, hp: 2, maxHp: 3 }],
    pickup: { x: 480, y: 450, active: false },
  };
  const decoded = decodeSnapshotPacket(encodeSnapshotPacket(snapshot, pilotId));
  assert.equal(decoded.tick, 20);
  assert.equal(decoded.ack, 19);
  assert.equal(decoded.tanks[0].hp, 5);
  assert.equal(decoded.tanks[0].score, 40000);
  assert.ok(Math.abs(decoded.tanks[0].angle + Math.PI / 2) < 0.0001);
  assert.equal(decoded.bullets[0].fireSeq, 18);
  assert.equal(decoded.bullets[0].homing, true);
  assert.equal(decoded.bullets[0].vy, -11);
  assert.deepEqual(decoded.obstacles, [
    { index: 0, x: 120, y: 80, radius: 25, hp: 2, maxHp: 3 },
  ]);
  assert.deepEqual(decoded.pickup, { x: 480, y: 450, active: false });
});

test("invalid packet versions, reserved input bits and snapshot lengths reject", () => {
  const sequence = asInputSequence(1);
  const input = new Uint8Array(encodeInputPacket(sequence, {}));
  input[0] = 3;
  assert.throws(() => decodeInputPacket(input), /Invalid input packet/);

  const reserved = new Uint8Array(encodeInputPacket(sequence, {}));
  reserved[6] = 0x80;
  assert.throws(() => decodeInputPacket(reserved), /Reserved input flags/);

  const snapshot = new Uint8Array(
    encodeSnapshotPacket(
      {
        tick: asSimulationStep(0),
        serverTime: 0,
        acknowledgements: new Map(),
        tanks: [],
        bullets: [],
        obstacles: [],
        pickup: { x: 480, y: 300, active: true },
      },
      asEntityId("pilot"),
    ),
  );
  assert.throws(() => decodeSnapshotPacket(snapshot.subarray(0, 15)));
});
