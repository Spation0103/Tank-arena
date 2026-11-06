import { SERVER_DT } from "../../shared/physics.js";
import { ArenaSimulation } from "../../shared/simulation.js";
import { asEntityId, asInputSequence } from "../../shared/types.js";
import type {
  EntityId,
  InputSequence,
  SimulationStep,
} from "../../shared/types.js";

export interface WorkerBenchmarkResult {
  readonly durationMs: number;
  readonly ticks: SimulationStep;
  readonly bullets: number;
}

interface SimulationInput {
  readonly input: {
    readonly forward: true;
    readonly right: true;
    readonly fire: true;
  };
  readonly seq: InputSequence;
}

export function simulateBots(
  iterations: number,
  playerCount: number,
): WorkerBenchmarkResult {
  const simulation = new ArenaSimulation({ width: 960, height: 600 }, 90210);
  const inputs = new Map<EntityId, SimulationInput>();
  for (let index = 0; index < playerCount; index += 1) {
    const id = asEntityId(`worker-bot-${index}`);
    simulation.addPlayer(id, index);
    inputs.set(id, {
      input: { forward: true, right: true, fire: true },
      seq: asInputSequence(1),
    });
  }

  const startedAt = performance.now();
  for (let tick = 0; tick < iterations; tick += 1) {
    simulation.step(inputs, SERVER_DT);
  }
  return {
    durationMs: performance.now() - startedAt,
    ticks: simulation.tick,
    bullets: simulation.bullets.size,
  };
}
