import { ARENA_HEIGHT, ARENA_WIDTH, integrate } from "./physics.js";
import { MutableVector2, Vector2 } from "./vector2.js";
import type { Vector2Like } from "./vector2.js";
import { emitGameEvent } from "./game-events.js";
import { asEntityId } from "../../shared/types.js";
import type {
  EntityId,
  InputSequence,
  PartialPlayerInput,
  PlayerInput,
} from "../../shared/types.js";

const BULLET_SPEED = 390;

export type EntityKind =
  "entity" | "ship" | "bullet" | "asteroid" | "pickup" | "particle";

interface EntityOptions {
  readonly id?: EntityId;
  readonly position?: Vector2Like;
  readonly velocity?: Vector2Like;
  readonly radius?: number;
  readonly kind?: EntityKind;
  readonly color?: string;
}

interface ShipOptions extends Omit<EntityOptions, "kind"> {
  readonly angle?: number;
  readonly hp?: number;
  readonly score?: number;
  readonly local?: boolean;
}

export interface BulletOptions extends Omit<EntityOptions, "kind"> {
  readonly ownerId?: EntityId;
  readonly ttl?: number;
}

interface AsteroidOptions extends Omit<EntityOptions, "kind"> {
  readonly hp?: number;
}

type PickupOptions = Omit<EntityOptions, "kind" | "velocity">;

export interface ParticleOptions extends Omit<EntityOptions, "kind"> {
  readonly ttl?: number;
}

export class Entity {
  static #nextId = 0;
  id: EntityId;
  position: MutableVector2;
  previousPosition: MutableVector2;
  velocity: MutableVector2;
  radius: number;
  kind: EntityKind;
  color: string;
  dead: boolean;

  constructor({
    id,
    position,
    velocity,
    radius = 10,
    kind = "entity",
    color = "#c1e886",
  }: EntityOptions = {}) {
    this.id = id ?? asEntityId(`entity-${++Entity.#nextId}`);
    this.position = new MutableVector2(position?.x, position?.y);
    this.previousPosition = new MutableVector2(
      this.position.x,
      this.position.y,
    );
    this.velocity = new MutableVector2(velocity?.x, velocity?.y);
    this.radius = radius;
    this.kind = kind;
    this.color = color;
    this.dead = false;
  }

  update(dt: number, _world?: WorldEntities): void {
    this.previousPosition.copy(this.position);
    this.position.set(
      wrap(this.position.x + this.velocity.x * dt, ARENA_WIDTH),
      wrap(this.position.y + this.velocity.y * dt, ARENA_HEIGHT),
    );
  }

  protected resetBase({
    id,
    position,
    velocity,
    radius = 10,
    kind = "entity",
    color = "#c1e886",
  }: EntityOptions = {}): void {
    this.id = id ?? asEntityId(`entity-${++Entity.#nextId}`);
    this.position.set(position?.x ?? 0, position?.y ?? 0);
    this.previousPosition.copy(this.position);
    this.velocity.set(velocity?.x ?? 0, velocity?.y ?? 0);
    this.radius = radius;
    this.kind = kind;
    this.color = color;
    this.dead = false;
  }
}

export class Ship extends Entity {
  #hp: number;
  declare kind: "ship";
  angle: number;
  score: number;
  local: boolean;
  input: PlayerInput;
  fireCooldown: number;

  constructor({
    id,
    position,
    velocity,
    radius = 16,
    color = "#c1e886",
    angle = -Math.PI / 2,
    hp = 3,
    score = 0,
    local = false,
  }: ShipOptions = {}) {
    super({ id, position, velocity, radius, color, kind: "ship" });
    this.angle = angle;
    this.#hp = hp;
    this.score = score;
    this.local = local;
    this.input = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      fire: false,
      homing: false,
    };
    this.fireCooldown = 0;
  }

  get hp(): number {
    return this.#hp;
  }

  setInput(input: PartialPlayerInput): void {
    this.input = {
      forward: input.forward === true,
      backward: input.backward === true,
      left: input.left === true,
      right: input.right === true,
      fire: input.fire === true,
      homing: input.homing === true,
    };
  }

  update(dt: number, _world?: WorldEntities): void {
    this.previousPosition.copy(this.position);
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    const next = integrate(
      {
        id: this.id,
        x: this.position.x,
        y: this.position.y,
        vx: this.velocity.x,
        vy: this.velocity.y,
        angle: this.angle,
        color: this.color,
      },
      this.input,
      dt,
    );
    this.position.set(next.x, next.y);
    this.velocity.set(next.vx, next.vy);
    this.angle = next.angle;
  }

  fire(
    world: WorldEntities,
    { homing = false }: { readonly homing?: boolean } = {},
  ): Bullet | null {
    if (this.dead || this.fireCooldown > 0) return null;
    this.fireCooldown = 0.28;
    const directionX = Math.cos(this.angle);
    const directionY = Math.sin(this.angle);
    const bullet = world.spawnBullet({
      position: new Vector2(
        this.position.x + directionX * (this.radius + 5),
        this.position.y + directionY * (this.radius + 5),
      ),
      velocity: new Vector2(
        this.velocity.x + directionX * BULLET_SPEED,
        this.velocity.y + directionY * BULLET_SPEED,
      ),
      ownerId: this.id,
      color: this.color,
    });

    if (homing) {
      const target = world.nearestOfKind("asteroid", this.position);
      if (target) bullet.behavior = new HomingBehavior(target.id);
    }
    if (world.events) {
      emitGameEvent(world.events, "fired", {
        shipId: this.id,
        bulletId: bullet.id,
        homing,
      });
    }
    return bullet;
  }

  takeDamage(amount = 1): number {
    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp === 0) this.dead = true;
    return this.#hp;
  }

  heal(amount = 1): void {
    this.#hp = Math.min(3, this.#hp + amount);
  }
}

export class Bullet extends Entity {
  declare kind: "bullet";
  ownerId: EntityId | undefined;
  ttl: number;
  behavior: HomingBehavior | null;
  predicted?: boolean;
  fireSeq?: InputSequence;
  ownerIndex?: number;

  constructor({
    id,
    position,
    velocity,
    ownerId,
    radius = 4,
    color = "#f3dfa0",
    ttl = 1.8,
  }: BulletOptions = {}) {
    super({ id, position, velocity, radius, color, kind: "bullet" });
    this.ownerId = ownerId;
    this.ttl = ttl;
    this.behavior = null;
  }

  update(dt: number, world: WorldEntities): void {
    this.previousPosition.copy(this.position);
    this.ttl -= dt;
    if (this.ttl <= 0) {
      this.dead = true;
      return;
    }
    this.behavior?.update(this, world, dt);
    this.position.set(
      wrap(this.position.x + this.velocity.x * dt, ARENA_WIDTH),
      wrap(this.position.y + this.velocity.y * dt, ARENA_HEIGHT),
    );
  }

  reset(options: BulletOptions = {}): void {
    this.resetBase({
      ...options,
      radius: options.radius ?? 4,
      color: options.color ?? "#f3dfa0",
      kind: "bullet",
    });
    this.ownerId = options.ownerId;
    this.ttl = options.ttl ?? 1.8;
    this.behavior = null;
    this.predicted = undefined;
    this.fireSeq = undefined;
    this.ownerIndex = undefined;
  }
}

export class Asteroid extends Entity {
  declare kind: "asteroid";
  hp: number;
  rotation: number;

  constructor({
    id,
    position,
    velocity = new Vector2(),
    radius = 25,
    color = "#777b68",
    hp = 2,
  }: AsteroidOptions = {}) {
    super({ id, position, velocity, radius, color, kind: "asteroid" });
    this.hp = hp;
    this.rotation = 0;
  }

  update(dt: number, _world?: WorldEntities): void {
    super.update(dt);
    this.rotation += dt * 0.16;
  }

  takeDamage(amount = 1): number {
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp === 0) this.dead = true;
    return this.hp;
  }
}

export class Pickup extends Entity {
  declare kind: "pickup";
  behavior: RepairPickup;
  rotation: number;

  constructor({
    id,
    position,
    radius = 13,
    color = "#e7c56e",
  }: PickupOptions = {}) {
    super({ id, position, radius, color, kind: "pickup" });
    this.behavior = new RepairPickup();
    this.rotation = 0;
  }

  update(dt: number, _world?: WorldEntities): void {
    this.previousPosition.copy(this.position);
    this.rotation += dt;
  }

  collect(ship: Ship): void {
    this.behavior.apply(ship);
    this.dead = true;
  }
}

export class Particle extends Entity {
  declare kind: "particle";
  ttl: number;
  maxTtl: number;

  constructor({
    position,
    velocity,
    color,
    ttl = 0.45,
    radius = 2,
  }: ParticleOptions = {}) {
    super({ position, velocity, radius, color, kind: "particle" });
    this.ttl = ttl;
    this.maxTtl = ttl;
  }

  update(dt: number, _world?: WorldEntities): void {
    super.update(dt);
    this.ttl -= dt;
    if (this.ttl <= 0) this.dead = true;
  }

  reset(options: ParticleOptions = {}): void {
    this.resetBase({
      ...options,
      radius: options.radius ?? 2,
      kind: "particle",
    });
    this.ttl = options.ttl ?? 0.45;
    this.maxTtl = this.ttl;
  }
}

export class HomingBehavior {
  readonly targetId: EntityId;
  readonly turnRate: number;

  constructor(targetId: EntityId, turnRate = 3.2) {
    this.targetId = targetId;
    this.turnRate = turnRate;
  }

  update(bullet: Bullet, world: WorldEntities, dt: number): void {
    const target = world.get(this.targetId);
    if (!target || target.dead) return;
    const dx = target.position.x - bullet.position.x;
    const dy = target.position.y - bullet.position.y;
    const magnitude = Math.hypot(dx, dy);
    if (magnitude === 0) return;
    const speed =
      Math.hypot(bullet.velocity.x, bullet.velocity.y) || BULLET_SPEED;
    const currentAngle = Math.atan2(bullet.velocity.y, bullet.velocity.x);
    const desiredAngle = Math.atan2(dy / magnitude, dx / magnitude);
    const turn = shortestAngle(desiredAngle - currentAngle);
    const nextAngle =
      currentAngle + clamp(turn, -this.turnRate * dt, this.turnRate * dt);
    bullet.velocity.set(
      Math.cos(nextAngle) * speed,
      Math.sin(nextAngle) * speed,
    );
  }
}

export class RepairPickup {
  apply(ship: Ship): void {
    const previousHp = ship.hp;
    ship.heal(1);
    ship.score += previousHp === ship.hp ? 25 : 10;
  }
}

export interface WorldEntities {
  readonly events: EventTarget | null;
  get(id: EntityId): Entity | undefined;
  nearestOfKind(kind: EntityKind, position: Vector2Like): Entity | null;
  spawn<T extends Entity>(entity: T): T;
  spawnBullet(options: BulletOptions): Bullet;
  spawnParticle(options: ParticleOptions): Particle;
}

function wrap(value: number, limit: number): number {
  return ((value % limit) + limit) % limit;
}

function shortestAngle(delta: number): number {
  return Math.atan2(Math.sin(delta), Math.cos(delta));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
