export type EntityId = string & { readonly __entityId: unique symbol };
export type SimulationStep = number & {
  readonly __simulationStep: unique symbol;
};
export type InputSequence = number & {
  readonly __inputSequence: unique symbol;
};

export function asEntityId(value: string): EntityId {
  if (!value) throw new TypeError("Entity ids must not be empty.");
  return value as EntityId; // The caller has validated this identifier.
}

export function asSimulationStep(value: number): SimulationStep {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError("Simulation steps must be unsigned 32-bit integers.");
  }
  return value as SimulationStep; // The range check establishes the brand.
}

export function asInputSequence(value: number): InputSequence {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError("Input sequences must be unsigned 32-bit integers.");
  }
  return value as InputSequence; // The range check establishes the brand.
}

export interface PlayerInput {
  readonly forward: boolean;
  readonly backward: boolean;
  readonly left: boolean;
  readonly right: boolean;
  readonly fire: boolean;
  readonly homing: boolean;
}

export type PartialPlayerInput = Partial<PlayerInput>;

export interface PhysicsState {
  readonly id: EntityId;
  readonly color: string;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
}

export interface TankSnapshot {
  readonly kind: "tank";
  readonly id?: EntityId;
  readonly color?: string;
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  readonly hp: number;
  readonly score: number;
}

export interface BulletSnapshot {
  readonly kind: "bullet";
  readonly id: number;
  readonly ownerId?: EntityId;
  readonly ownerIndex: number;
  readonly fireSeq: InputSequence;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly homing: boolean;
}

export type SnapshotEntity = TankSnapshot | BulletSnapshot;

export interface SimulationSnapshot {
  readonly tick: SimulationStep;
  readonly serverTime: number;
  readonly tanks: readonly TankSnapshot[];
  readonly bullets: readonly BulletSnapshot[];
  readonly acknowledgements: ReadonlyMap<EntityId, InputSequence>;
}

export interface ArenaConfig {
  readonly width: number;
  readonly height: number;
  readonly obstacles?: readonly {
    readonly x: number;
    readonly y: number;
    readonly radius: number;
    readonly vx?: number;
    readonly vy?: number;
  }[];
  readonly pickup?: { readonly x: number; readonly y: number };
}

export interface RoomInfo {
  readonly id: string;
  readonly name: string;
  readonly maxPlayers: number;
  readonly players: number;
  readonly arena: ArenaConfig;
}

export interface RoomPlayer {
  readonly id: EntityId;
  readonly name: string;
  readonly index: number;
}
