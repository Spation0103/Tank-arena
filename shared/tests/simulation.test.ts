import assert from "node:assert/strict";
import test from "node:test";
import { SERVER_DT } from "../physics.js";
import { ArenaSimulation } from "../simulation.js";
import { asEntityId, asInputSequence } from "../types.js";
import type { EntityId } from "../types.js";
import type { SimulationInput } from "../simulation.js";

test("seeded simulation is deterministic for the same player inputs", () => {
  const first = new ArenaSimulation({ width: 960, height: 600 }, 1234);
  const second = new ArenaSimulation({ width: 960, height: 600 }, 1234);
  const pilot = asEntityId("pilot");
  for (const simulation of [first, second]) simulation.addPlayer(pilot, 0);
  const controls = new Map<EntityId, SimulationInput>([
    [
      pilot,
      {
        input: { forward: true, right: true },
        seq: asInputSequence(1),
      },
    ],
  ]);
  for (let tick = 0; tick < 60; tick += 1) {
    first.step(controls, SERVER_DT);
    second.step(controls, SERVER_DT);
  }
  assert.deepEqual(first.snapshot(new Map(), 0), second.snapshot(new Map(), 0));
});

test("simulation owns tank movement, firing, hit points and respawn", () => {
  const simulation = new ArenaSimulation({ width: 960, height: 600 }, 5);
  const shooterId = asEntityId("shooter");
  const targetId = asEntityId("target");
  const shooter = simulation.addPlayer(shooterId, 0);
  const target = simulation.addPlayer(targetId, 1);
  target.x = 800;
  target.y = 500;
  shooter.angle = 0;
  const input = new Map<EntityId, SimulationInput>([
    [shooterId, { input: { fire: true }, seq: asInputSequence(4) }],
    [targetId, { input: {}, seq: asInputSequence(0) }],
  ]);
  simulation.step(input, SERVER_DT);
  const bullet = [...simulation.bullets.values()][0];
  assert.equal(bullet.fireSeq, 4);

  target.x = bullet.x;
  target.y = bullet.y + bullet.vy * SERVER_DT;
  simulation.step(new Map(), SERVER_DT);
  assert.equal(target.hp, 2);
  assert.equal(shooter.score, 10);
});
