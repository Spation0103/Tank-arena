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
  ArenaConfig,
  BulletSnapshot,
  EntityId,
  InputSequence,
  ObstacleSnapshot,
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
const PICKUP_RESPAWN_DELAY = 10;
const MAX_TANK_HP = 5;
const COLORS = ["#c1e886", "#e7a96d", "#8bc6d8", "#cf9cdd"];

interface SimulationObstacle {
  x: number;
  y: number;
  readonly radius: number;
  vx: number;
  vy: number;
  hp: number;
  readonly maxHp: number;
}

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
  readonly obstacles: SimulationObstacle[];
  readonly pickup: { x: number; y: number; active: boolean; respawn: number };
  nextBulletId = 1;
  tick: SimulationStep = asSimulationStep(0);

  constructor(
    arena: ArenaSize,
    seed: number,
    config: Pick<ArenaConfig, "obstacles" | "pickup"> = {},
  ) {
    this.arena = arena;
    this.seed = seed >>> 0;
    this.random = createSeededRandom(seed);
    this.obstacles = (config.obstacles ?? []).map((obstacle) => ({
      x: obstacle.x,
      y: obstacle.y,
      radius: obstacle.radius,
      vx: obstacle.vx ?? 0,
      vy: obstacle.vy ?? 0,
      hp: obstacle.hp ?? 3,
      maxHp: obstacle.hp ?? 3,
    }));
    this.pickup = {
      x: config.pickup?.x ?? arena.width / 2,
      y: config.pickup?.y ?? arena.height / 2,
      active: true,
      respawn: 0,
    };
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
      this.resolveTankObstacles(tank);
      if (controls.fire && tank.fireCooldown <= 0) {
        this.fire(tank, state.seq, controls.homing);
        tank.fireCooldown = FIRE_COOLDOWN;
      }
    }

    this.advanceObstacles(dt);
    this.collectPickup(dt);

    for (const [id, bullet] of this.bullets) {
      bullet.ttl -= dt;
      if (bullet.homing) this.steerHomingBullet(bullet, dt);
      bullet.x += bullet.vx * dt;
      bullet.y += bullet.vy * dt;
      if (
        bullet.x < 0 ||
        bullet.x > this.arena.width ||
        bullet.y < 0 ||
        bullet.y > this.arena.height
      ) {
        this.bullets.delete(id);
        continue;
      }
      if (bullet.ttl <= 0) {
        this.bullets.delete(id);
        continue;
      }
      if (this.resolveObstacleHit(bullet)) continue;
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
      obstacles: this.obstacles.map((obstacle, index): ObstacleSnapshot => ({
        index,
        x: obstacle.x,
        y: obstacle.y,
        radius: obstacle.radius,
        hp: obstacle.hp,
        maxHp: obstacle.maxHp,
      })),
      pickup: {
        x: this.pickup.x,
        y: this.pickup.y,
        active: this.pickup.active,
      },
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
      x: tank.x + directionX * (TANK_RADIUS + 5),
      y: tank.y + directionY * (TANK_RADIUS + 5),
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
      const dx = tank.x - bullet.x;
      const dy = tank.y - bullet.y;
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
      const dx = tank.x - bullet.x;
      const dy = tank.y - bullet.y;
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

  advanceObstacles(dt: number): void {
    for (const obstacle of this.obstacles) {
      if (obstacle.hp <= 0) continue;
      obstacle.x += obstacle.vx * dt;
      obstacle.y += obstacle.vy * dt;
      if (
        obstacle.x < obstacle.radius ||
        obstacle.x > this.arena.width - obstacle.radius
      ) {
        obstacle.vx *= -1;
        obstacle.x = Math.max(
          obstacle.radius,
          Math.min(this.arena.width - obstacle.radius, obstacle.x),
        );
      }
      if (
        obstacle.y < obstacle.radius ||
        obstacle.y > this.arena.height - obstacle.radius
      ) {
        obstacle.vy *= -1;
        obstacle.y = Math.max(
          obstacle.radius,
          Math.min(this.arena.height - obstacle.radius, obstacle.y),
        );
      }
    }
  }

  resolveTankObstacles(tank: SimulationTank): void {
    for (const obstacle of this.obstacles) {
      if (obstacle.hp <= 0) continue;
      let dx = tank.x - obstacle.x;
      let dy = tank.y - obstacle.y;
      let distance = Math.hypot(dx, dy);
      const minimum = TANK_RADIUS + obstacle.radius;
      if (distance >= minimum) continue;
      if (distance === 0) {
        dx = 1;
        dy = 0;
        distance = 1;
      }
      const nx = dx / distance;
      const ny = dy / distance;
      tank.x = obstacle.x + nx * minimum;
      tank.y = obstacle.y + ny * minimum;
      const speedIntoObstacle = tank.vx * nx + tank.vy * ny;
      if (speedIntoObstacle < 0) {
        tank.vx -= speedIntoObstacle * nx;
        tank.vy -= speedIntoObstacle * ny;
      }
      tank.x = Math.max(
        TANK_RADIUS,
        Math.min(this.arena.width - TANK_RADIUS, tank.x),
      );
      tank.y = Math.max(
        TANK_RADIUS,
        Math.min(this.arena.height - TANK_RADIUS, tank.y),
      );
    }
  }

  resolveObstacleHit(bullet: SimulationBullet): boolean {
    for (const obstacle of this.obstacles) {
      if (obstacle.hp <= 0) continue;
      const dx = bullet.x - obstacle.x;
      const dy = bullet.y - obstacle.y;
      const radius = obstacle.radius + BULLET_RADIUS;
      if (dx * dx + dy * dy > radius * radius) continue;
      obstacle.hp = Math.max(0, obstacle.hp - 1);
      const owner = this.tanks.get(bullet.ownerId);
      if (obstacle.hp === 0 && owner) owner.score += 40;
      this.bullets.delete(bullet.id);
      return true;
    }
    return false;
  }

  collectPickup(dt: number): void {
    if (!this.pickup.active) {
      this.pickup.respawn -= dt;
      if (this.pickup.respawn <= 0) this.pickup.active = true;
      return;
    }
    for (const tank of this.tanks.values()) {
      if (tank.hp <= 0) continue;
      const dx = tank.x - this.pickup.x;
      const dy = tank.y - this.pickup.y;
      if (dx * dx + dy * dy > (TANK_RADIUS + 13) ** 2) continue;
      tank.hp = Math.min(MAX_TANK_HP, tank.hp + 2);
      tank.score += 25;
      this.pickup.active = false;
      this.pickup.respawn = PICKUP_RESPAWN_DELAY;
      break;
    }
  }

  spawnPosition(index: number): { x: number; y: number } {
    const width = this.arena.width || ARENA_WIDTH;
    const height = this.arena.height || ARENA_HEIGHT;
    const angle = (index / 32) * Math.PI * 2 + this.random() * 0.15;
    const radius = 70 + this.random() * 30;
    return {
      x: Math.max(
        16,
        Math.min(width - 16, width / 2 + Math.cos(angle) * radius),
      ),
      y: Math.max(
        16,
        Math.min(height - 16, height / 2 + Math.sin(angle) * radius),
      ),
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
