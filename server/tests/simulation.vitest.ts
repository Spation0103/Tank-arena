import { describe, expect, it } from "vitest";
import { ClientPrediction } from "../../client/src/prediction.js";
import type { PredictedState } from "../../client/src/prediction.js";
import { SERVER_DT } from "../../shared/physics.js";
import { ArenaSimulation } from "../../shared/simulation.js";
import { asEntityId, asInputSequence } from "../../shared/types.js";
import type { EntityId } from "../../shared/types.js";
import type { SimulationInput } from "../../shared/simulation.js";

describe("authoritative simulation reconciliation", () => {
  it.each([
    { forward: true, right: false },
    { forward: true, right: true },
    { forward: false, left: true },
    { backward: true, left: true },
  ])("replays the same state on client and server for input %o", (input) => {
    const id = asEntityId("pilot");
    const server = new ArenaSimulation({ width: 960, height: 600 }, 0x1234);
    const tank = server.addPlayer(id, 0);
    const initial: PredictedState = {
      id,
      color: tank.color,
      x: tank.x,
      y: tank.y,
      vx: tank.vx,
      vy: tank.vy,
      angle: tank.angle,
      index: tank.index,
      hp: tank.hp,
      score: tank.score,
    };
    const client = new ClientPrediction(initial);

    for (let sequence = 1; sequence <= 45; sequence += 1) {
      const seq = asInputSequence(sequence);
      client.step(input, seq);
      const inputMap = new Map<EntityId, SimulationInput>([
        [id, { input, seq }],
      ]);
      server.step(inputMap, SERVER_DT);
      const authoritative = server.tanks.get(id);
      expect(authoritative).toBeDefined();
      if (!authoritative) throw new Error("Server tank disappeared.");
      client.reconcile(
        {
          ...authoritative,
          id,
        },
        seq,
      );
      expect(client.state.x).toBeCloseTo(authoritative.x, 8);
      expect(client.state.y).toBeCloseTo(authoritative.y, 8);
      expect(client.state.angle).toBeCloseTo(authoritative.angle, 8);
    }
    expect(client.pendingCount).toBe(0);
  });
});
