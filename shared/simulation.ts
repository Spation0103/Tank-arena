import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  FIXED_DT,
  createTank,
  integrate,
  sanitizeInput,
} from "./physics.js";
import { asInputSequence, asSimulationStep } from "./types.js";
import type {
  BulletSnapshot,
  EntityId,
  InputSequence,
  PartialPlayerInput,
  SimulationSnapshot,
  SimulationStep,
  TankSnapshot,
} from "./types.js";

const BULLET_SPEED = 390;
const BULLET_TTL = 1.8;
const FIRE_COOLDOWN = 0.28;
const HOMING_TURN_RATE = 3.2;
const TANK_RADIUS = 16;
const BULLET_RADIUS = 4;
const RESPAWN_DELAY = 2;
const COLORS = ["#c1e886", "#e7a96d", "#8bc6d8", "#cf9cdd"];

export interface ArenaSize {
  readonly width: number;
  readonly height: number;
}

interface SimulationTank {
  readonly id: EntityId;
  readonly color: string;
  readonly index: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  hp: number;
  score: number;
  fireCooldown: number;
  respawn: number;
}

interface SimulationBullet {
  readonly id: number;
  readonly ownerId: EntityId;
  readonly ownerIndex: number;
  readonly fireSeq: InputSequence;
  readonly homing: boolean;
  readonly color: string;
  readonly radius: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ttl: number;
}

export interface SimulationInput {
  readonly input: PartialPlayerInput;
  readonly seq: InputSequence;
}

export class ArenaSimulation {
  readonly arena: ArenaSize;
  readonly seed: number;
  readonly random: () => number;
  readonly tanks = new Map<EntityId, SimulationTank>();
  readonly bullets = new Map<number, SimulationBullet>();
  nextBulletId = 1;
  tick: SimulationStep = asSimulationStep(0);

  constructor(arena: ArenaSize, seed: number) {
    this.arena = arena;
    this.seed = seed >>> 0;
    this.random = createSeededRandom(seed);
  }

  addPlayer(id: EntityId, index: number): SimulationTank {
    const existing = this.tanks.get(id);
    if (existing) return existing;
    const spawn = this.spawnPosition(index);
    const color = COLORS[index % COLORS.length] ?? "#c1e886";
    const tank = {
      ...createTank(id, color, spawn.x, spawn.y),
      index,
      hp: 3,
      score: 0,
      fireCooldown: 0,
      respawn: 0,
    };
    this.tanks.set(id, tank);
    return tank;
  }

  removePlayer(id: EntityId): void {
    this.tanks.delete(id);
    for (const [bulletId, bullet] of this.bullets) {
      if (bullet.ownerId === id) this.bullets.delete(bulletId);
    }
  }

  step(inputs: ReadonlyMap<EntityId, SimulationInput>, dt = FIXED_DT): void {
    this.tick = asSimulationStep((this.tick + 1) >>> 0);
    for (const [id, tank] of this.tanks) {
      const state = inputs.get(id) ?? {
        input: {},
        seq: asInputSequence(0),
      };
      if (tank.hp <= 0) {
        tank.respawn -= dt;
        if (tank.respawn <= 0) this.respawn(tank);
        tank.fireCooldown = Math.max(0, tank.fireCooldown - dt);
        continue;
      }

      const controls = sanitizeInput(state.input);
      tank.fireCooldown = Math.max(0, tank.fireCooldown - dt);
      const next = integrate(tank, controls, dt);
      Object.assign(tank, next);
      if (controls.fire && tank.fireCooldown <= 0) {
        this.fire(tank, state.seq, controls.homing);
        tank.fireCooldown = FIRE_COOLDOWN;
      }
    }

    for (const [id, bullet] of this.bullets) {
      bullet.ttl -= dt;
      if (bullet.homing) this.steerHomingBullet(bullet, dt);
      bullet.x = wrap(bullet.x + bullet.vx * dt, ARENA_WIDTH);
      bullet.y = wrap(bullet.y + bullet.vy * dt, ARENA_HEIGHT);
      if (bullet.ttl <= 0) {
        this.bullets.delete(id);
        continue;
      }
      this.resolveHit(bullet);
    }
  }

  snapshot(
    acknowledgements: ReadonlyMap<EntityId, InputSequence> = new Map(),
    serverTime = Date.now(),
  ): SimulationSnapshot {
    return {
      tick: this.tick,
      serverTime: serverTime >>> 0,
      tanks: [...this.tanks.values()].map((tank): TankSnapshot => ({
        kind: "tank",
        id: tank.id,
        color: tank.color,
        index: tank.index,
        x: tank.x,
        y: tank.y,
        vx: tank.vx,
        vy: tank.vy,
        angle: tank.angle,
        hp: tank.hp,
        score: tank.score,
      })),
      bullets: [...this.bullets.values()].map((bullet): BulletSnapshot => ({
        kind: "bullet",
        id: bullet.id,
        ownerId: bullet.ownerId,
        ownerIndex: bullet.ownerIndex,
        fireSeq: bullet.fireSeq,
        x: bullet.x,
        y: bullet.y,
        vx: bullet.vx,
        vy: bullet.vy,
        homing: bullet.homing,
      })),
      acknowledgements,
    };
  }

  fire(tank: SimulationTank, inputSeq: InputSequence, homing: boolean): void {
    const directionX = Math.cos(tank.angle);
    const directionY = Math.sin(tank.angle);
    const bullet = {
      id: this.nextBulletId,
      ownerId: tank.id,
      ownerIndex: tank.index,
      fireSeq: inputSeq,
      x: wrap(tank.x + directionX * (TANK_RADIUS + 5), ARENA_WIDTH),
      y: wrap(tank.y + directionY * (TANK_RADIUS + 5), ARENA_HEIGHT),
      vx: tank.vx + directionX * BULLET_SPEED,
      vy: tank.vy + directionY * BULLET_SPEED,
      ttl: BULLET_TTL,
      radius: BULLET_RADIUS,
      homing,
      color: homing
        ? "#c1e886"
        : (COLORS[tank.index % COLORS.length] ?? "#c1e886"),
    };
    this.nextBulletId = (this.nextBulletId + 1) & 0xffff;
    if (this.nextBulletId === 0) this.nextBulletId = 1;
    this.bullets.set(bullet.id, bullet);
  }

  resolveHit(bullet: SimulationBullet): void {
    for (const tank of this.tanks.values()) {
      if (tank.id === bullet.ownerId || tank.hp <= 0) continue;
      const dx = wrappedDelta(tank.x - bullet.x, ARENA_WIDTH);
      const dy = wrappedDelta(tank.y - bullet.y, ARENA_HEIGHT);
      const radius = TANK_RADIUS + BULLET_RADIUS;
      if (dx * dx + dy * dy > radius * radius) continue;
      tank.hp = Math.max(0, tank.hp - 1);
      if (tank.hp === 0) tank.respawn = RESPAWN_DELAY;
      const owner = this.tanks.get(bullet.ownerId);
      if (owner) owner.score += 10;
      this.bullets.delete(bullet.id);
      return;
    }
  }

  steerHomingBullet(bullet: SimulationBullet, dt: number): void {
    let target: { x: number; y: number } | null = null;
    let targetDistance = Infinity;
    for (const tank of this.tanks.values()) {
      if (tank.id === bullet.ownerId || tank.hp <= 0) continue;
      const dx = wrappedDelta(tank.x - bullet.x, ARENA_WIDTH);
      const dy = wrappedDelta(tank.y - bullet.y, ARENA_HEIGHT);
      const distance = dx * dx + dy * dy;
      if (distance < targetDistance) {
        target = { x: dx, y: dy };
        targetDistance = distance;
      }
    }
    if (!target) return;
    const speed = Math.hypot(bullet.vx, bullet.vy);
    const currentAngle = Math.atan2(bullet.vy, bullet.vx);
    const desiredAngle = Math.atan2(target.y, target.x);
    const delta = Math.atan2(
      Math.sin(desiredAngle - currentAngle),
      Math.cos(desiredAngle - currentAngle),
    );
    const angle =
      currentAngle +
      Math.max(-HOMING_TURN_RATE * dt, Math.min(HOMING_TURN_RATE * dt, delta));
    bullet.vx = Math.cos(angle) * speed;
    bullet.vy = Math.sin(angle) * speed;
  }

  respawn(tank: SimulationTank): void {
    const spawn = this.spawnPosition(tank.index);
    Object.assign(tank, createTank(tank.id, tank.color, spawn.x, spawn.y), {
      index: tank.index,
      hp: 3,
      score: tank.score,
      fireCooldown: 0,
      respawn: 0,
    });
  }

  spawnPosition(index: number): { x: number; y: number } {
    const width = this.arena.width || ARENA_WIDTH;
    const height = this.arena.height || ARENA_HEIGHT;
    const angle = (index / 32) * Math.PI * 2 + this.random() * 0.15;
    const radius = 70 + this.random() * 30;
    return {
      x: wrap(width / 2 + Math.cos(angle) * radius, width),
      y: wrap(height / 2 + Math.sin(angle) * radius, height),
    };
  }
}

export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function wrap(value: number, limit: number): number {
  return ((value % limit) + limit) % limit;
}

function wrappedDelta(delta: number, size: number): number {
  return ((((delta + size / 2) % size) + size) % size) - size / 2;
}
