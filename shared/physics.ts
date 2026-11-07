import type { PartialPlayerInput, PhysicsState, PlayerInput } from "./types.js";

export const FIXED_DT = 1 / 60;
export const SERVER_DT = 1 / 30;
export const ARENA_WIDTH = 960;
export const ARENA_HEIGHT = 600;

const TURN_SPEED = 2.8;
const ACCELERATION = 250;
const DRAG = 0.985;
const MAX_SPEED = 210;

export function createTank(
  id: PhysicsState["id"],
  color: string,
  x: number,
  y: number,
): PhysicsState {
  return { id, color, x, y, angle: -Math.PI / 2, vx: 0, vy: 0 };
}

export function integrate<T extends PhysicsState>(
  tank: T,
  input: PartialPlayerInput,
  dt: number,
): T {
  const turn = Number(Boolean(input.right)) - Number(Boolean(input.left));
  const throttle =
    Number(Boolean(input.forward)) - Number(Boolean(input.backward));
  const angle = tank.angle + turn * TURN_SPEED * dt;
  const acceleration = throttle * ACCELERATION;
  let vx = (tank.vx + Math.cos(angle) * acceleration * dt) * DRAG;
  let vy = (tank.vy + Math.sin(angle) * acceleration * dt) * DRAG;

  const speed = Math.hypot(vx, vy);
  if (speed > MAX_SPEED) {
    const ratio = MAX_SPEED / speed;
    vx *= ratio;
    vy *= ratio;
  }

  return {
    ...tank,
    angle,
    vx,
    vy,
    x: clamp(tank.x + vx * dt, 16, ARENA_WIDTH - 16),
    y: clamp(tank.y + vy * dt, 16, ARENA_HEIGHT - 16),
  };
}

export function sanitizeInput(
  value: PartialPlayerInput | null | undefined,
): PlayerInput {
  return {
    forward: value?.forward === true,
    backward: value?.backward === true,
    left: value?.left === true,
    right: value?.right === true,
    fire: value?.fire === true,
    homing: value?.homing === true,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
