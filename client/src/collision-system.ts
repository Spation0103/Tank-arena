import { Asteroid, Bullet, Pickup, Ship } from "./entities.js";
import { emitGameEvent } from "./game-events.js";
import type { Entity } from "./entities.js";
import type { World } from "./world.js";

export class CircleCollisionSystem {
  resolve(world: World): void {
    const entities = [...world.entities.values()].filter(
      (entity) => !entity.dead,
    );
    for (let firstIndex = 0; firstIndex < entities.length; firstIndex += 1) {
      const first = entities[firstIndex];
      if (!first) continue;
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < entities.length;
        secondIndex += 1
      ) {
        const second = entities[secondIndex];
        if (!second) continue;
        if (first.dead || second.dead || !overlaps(first, second)) continue;
        this.resolvePair(world, first, second);
      }
    }
  }

  resolvePair(world: World, first: Entity, second: Entity): void {
    if (first instanceof Bullet) {
      this.hit(world, first, second);
      return;
    }
    if (second instanceof Bullet) {
      this.hit(world, second, first);
      return;
    }
    if (first instanceof Pickup && second instanceof Ship) {
      if (first.active) first.collect(second);
      return;
    }
    if (second instanceof Pickup && first instanceof Ship) {
      if (second.active) second.collect(first);
    }
  }

  hit(world: World, bullet: Bullet, target: Entity): void {
    if (bullet.dead) return;
    if (target.id === bullet.ownerId) return;
    if (!(target instanceof Ship) && !(target instanceof Asteroid)) return;

    bullet.dead = true;
    target.takeDamage(1);
    const owner = bullet.ownerId ? world.get(bullet.ownerId) : undefined;
    if (owner instanceof Ship) owner.score += 10;
    emitGameEvent(world.events, "hit", {
      bulletId: bullet.id,
      targetId: target.id,
      targetKind: target.kind,
    });
    world.explode(target.position, target.color, 5);

    if (target instanceof Asteroid && target.dead) {
      if (owner instanceof Ship) owner.score += 40;
      world.explode(target.position, target.color, 12);
      if (world.random() < 0.55)
        world.spawn(new Pickup({ position: target.position }));
    }
  }
}

function overlaps(first: Entity, second: Entity): boolean {
  const dx = first.position.x - second.position.x;
  const dy = first.position.y - second.position.y;
  const radius = first.radius + second.radius;
  return dx * dx + dy * dy <= radius * radius;
}
