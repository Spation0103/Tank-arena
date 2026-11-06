import type { EntityId } from "../../shared/types.js";
import type { Vector2Like } from "./vector2.js";
import type { EntityKind } from "./entities.js";

export interface GameEventMap {
  fired: {
    readonly shipId: EntityId;
    readonly bulletId: EntityId;
    readonly homing: boolean;
  };
  hit: {
    readonly bulletId: EntityId;
    readonly targetId: EntityId;
    readonly targetKind: EntityKind;
  };
  exploded: {
    readonly position: Vector2Like;
    readonly color: string;
    readonly count: number;
  };
}

export function createGameEvents(): EventTarget {
  return new EventTarget();
}

export function emitGameEvent<K extends keyof GameEventMap>(
  target: EventTarget,
  type: K,
  detail: GameEventMap[K],
): void {
  target.dispatchEvent(new CustomEvent(type, { detail }));
}
