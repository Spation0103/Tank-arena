import { CircleCollisionSystem } from "./collision-system.js";
import { Asteroid, Bullet, Particle, Pickup, Ship } from "./entities.js";
import type {
  BulletOptions,
  Entity,
  EntityKind,
  ParticleOptions,
  WorldEntities,
} from "./entities.js";
import { createGameEvents, emitGameEvent } from "./game-events.js";
import { Vector2 } from "./vector2.js";
import type { Vector2Like } from "./vector2.js";
import type {
  EntityId,
  PartialPlayerInput,
  RoomInfo,
} from "../../shared/types.js";

interface RespawnState {
  remaining: number;
  readonly color: string;
  readonly score: number;
}

interface WorldOptions {
  readonly random?: () => number;
  readonly events?: EventTarget;
}

export class World implements WorldEntities {
  readonly entities = new Map<EntityId, Entity>();
  readonly collisionSystem = new CircleCollisionSystem();
  readonly respawns = new Map<EntityId, RespawnState>();
  readonly #stepEntities: Entity[] = [];
  readonly #bulletPool: Bullet[] = [];
  readonly #particlePool: Particle[] = [];
  readonly random: () => number;
  readonly events: EventTarget;
  #createdBullets = 0;
  #reusedBullets = 0;
  #createdParticles = 0;
  #reusedParticles = 0;

  constructor({
    random = Math.random,
    events = createGameEvents(),
  }: WorldOptions = {}) {
    this.random = random;
    this.events = events;
  }

  get(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  spawn<T extends Entity>(entity: T): T {
    if (this.entities.has(entity.id)) {
      throw new Error(`Entity id already exists: ${entity.id}`);
    }
    this.entities.set(entity.id, entity);
    return entity;
  }

  spawnBullet(options: BulletOptions = {}): Bullet {
    const bullet = this.#bulletPool.pop();
    if (bullet) {
      bullet.reset(options);
      this.#reusedBullets += 1;
    } else {
      this.#createdBullets += 1;
    }
    return this.spawn(bullet ?? new Bullet(options));
  }

  spawnParticle(options: ParticleOptions = {}): Particle {
    const particle = this.#particlePool.pop();
    if (particle) {
      particle.reset(options);
      this.#reusedParticles += 1;
    } else {
      this.#createdParticles += 1;
    }
    return this.spawn(particle ?? new Particle(options));
  }

  get poolStats() {
    return {
      createdBullets: this.#createdBullets,
      reusedBullets: this.#reusedBullets,
      createdParticles: this.#createdParticles,
      reusedParticles: this.#reusedParticles,
      availableBullets: this.#bulletPool.length,
      availableParticles: this.#particlePool.length,
    };
  }

  despawn(id: EntityId): void {
    const entity = this.entities.get(id);
    if (entity) entity.dead = true;
  }

  *ofKind(kind: EntityKind): Generator<Entity> {
    for (const entity of this.entities.values()) {
      if (entity.kind === kind && !entity.dead) yield entity;
    }
  }

  nearestOfKind(kind: EntityKind, position: Vector2Like): Entity | null {
    let nearest: Entity | null = null;
    let nearestDistance = Infinity;
    for (const entity of this.ofKind(kind)) {
      const dx = entity.position.x - position.x;
      const dy = entity.position.y - position.y;
      const distance = dx * dx + dy * dy;
      if (distance < nearestDistance) {
        nearest = entity;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  step(dt: number, input: PartialPlayerInput = {}): void {
    let localShip: Ship | undefined;
    for (const entity of this.entities.values()) {
      if (entity instanceof Ship && entity.local && !entity.dead) {
        localShip = entity;
        break;
      }
    }
    localShip?.setInput(input);
    this.#stepEntities.length = 0;
    for (const entity of this.entities.values()) {
      this.#stepEntities.push(entity);
    }
    try {
      for (const entity of this.#stepEntities) {
        if (!entity.dead) entity.update(dt, this);
      }
    } finally {
      this.#stepEntities.length = 0;
    }
    this.collisionSystem.resolve(this);
    this.scheduleRespawns();
    this.sweep();
    this.advanceRespawns(dt);
  }

  explode(position: Vector2Like, color: string, count = 8): void {
    for (let index = 0; index < count; index += 1) {
      const angle = (Math.PI * 2 * index) / count;
      const speed = 25 + this.random() * 65;
      this.spawnParticle({
        position,
        velocity: new Vector2(Math.cos(angle) * speed, Math.sin(angle) * speed),
        color,
        ttl: 0.25 + this.random() * 0.4,
        radius: 1.5 + this.random() * 2.5,
      });
    }
    emitGameEvent(this.events, "exploded", { position, color, count });
  }

  respawnIn(id: EntityId): number | null {
    return this.respawns.get(id)?.remaining ?? null;
  }

  scheduleRespawns(): void {
    for (const entity of this.entities.values()) {
      if (
        entity instanceof Ship &&
        entity.local &&
        entity.dead &&
        !this.respawns.has(entity.id)
      ) {
        this.respawns.set(entity.id, {
          remaining: 2,
          color: entity.color,
          score: entity.score,
        });
      }
    }
  }

  sweep(): void {
    for (const [id, entity] of this.entities) {
      if (!entity.dead) continue;
      this.entities.delete(id);
      if (entity instanceof Bullet) this.#bulletPool.push(entity);
      else if (entity instanceof Particle) this.#particlePool.push(entity);
    }
  }

  advanceRespawns(dt: number): void {
    for (const [id, respawn] of this.respawns) {
      respawn.remaining -= dt;
      if (respawn.remaining > 0) continue;
      this.respawns.delete(id);
      this.spawn(
        new Ship({
          id,
          position: new Vector2(480, 300),
          color: respawn.color,
          score: respawn.score,
          local: true,
        }),
      );
    }
  }
}

export function createArenaWorld(
  config: Pick<RoomInfo, "arena"> | null,
  events = createGameEvents(),
): World {
  const world = new World({ events });
  const obstacles = config?.arena?.obstacles ?? [
    { x: 170, y: 140, radius: 27, vx: -16, vy: 11 },
    { x: 390, y: 430, radius: 37, vx: 12, vy: -9 },
    { x: 690, y: 180, radius: 31, vx: -8, vy: 15 },
    { x: 820, y: 440, radius: 23, vx: 18, vy: 12 },
    { x: 530, y: 100, radius: 20, vx: 0, vy: 0 },
  ];
  for (const { x, y, radius, vx = 0, vy = 0 } of obstacles) {
    world.spawn(
      new Asteroid({
        position: new Vector2(x, y),
        velocity: new Vector2(vx, vy),
        radius,
      }),
    );
  }
  const pickup = config?.arena?.pickup ?? { x: 480, y: 450 };
  world.spawn(new Pickup({ position: new Vector2(pickup.x, pickup.y) }));
  return world;
}
