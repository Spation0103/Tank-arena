import { SERVER_DT, integrate } from "./physics.js";
import { asInputSequence } from "../../shared/types.js";
import type {
  InputSequence,
  PartialPlayerInput,
  PhysicsState,
} from "../../shared/types.js";

const RECONCILIATION_SECONDS = 0.1;

export interface PredictedState extends PhysicsState {
  readonly index?: number;
  hp: number;
  score: number;
}

interface PendingInput {
  readonly sequence: InputSequence;
  readonly input: PartialPlayerInput;
}

export class ClientPrediction {
  state: PredictedState;
  fixedDt: number;
  sequence: InputSequence = asInputSequence(0);
  pending: PendingInput[] = [];
  correction = { x: 0, y: 0, angle: 0 };
  correctionRemaining = 0;

  constructor(initialState: PredictedState, fixedDt = SERVER_DT) {
    this.state = { ...initialState };
    this.fixedDt = fixedDt;
  }

  step(
    input: PartialPlayerInput,
    sequence = asInputSequence((this.sequence + 1) >>> 0),
  ): InputSequence {
    this.sequence = sequence;
    this.pending.push({ sequence: this.sequence, input: { ...input } });
    this.state = integrate(this.state, input, this.fixedDt);
    return this.sequence;
  }

  reconcile(
    serverState: Partial<PredictedState>,
    acknowledgement: InputSequence,
  ): number {
    const previous = this.state;
    this.pending = this.pending.filter(
      (entry) => entry.sequence > acknowledgement,
    );
    this.state = { ...this.state, ...serverState };
    for (const entry of this.pending) {
      this.state = integrate(this.state, entry.input, this.fixedDt);
    }

    this.correction = {
      x: previous.x - this.state.x,
      y: previous.y - this.state.y,
      angle: shortestAngle(previous.angle - this.state.angle),
    };
    this.correctionRemaining = RECONCILIATION_SECONDS;
    return Math.hypot(this.correction.x, this.correction.y);
  }

  advance(dt: number): void {
    this.correctionRemaining = Math.max(0, this.correctionRemaining - dt);
  }

  get visualState(): PredictedState {
    const alpha = this.correctionRemaining / RECONCILIATION_SECONDS;
    return {
      ...this.state,
      x: clamp(this.state.x + this.correction.x * alpha, 16, 944),
      y: clamp(this.state.y + this.correction.y * alpha, 16, 584),
      angle: this.state.angle + this.correction.angle * alpha,
    };
  }

  get correctionMagnitude(): number {
    return (
      Math.hypot(this.correction.x, this.correction.y) *
      (this.correctionRemaining / RECONCILIATION_SECONDS)
    );
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function shortestAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}
