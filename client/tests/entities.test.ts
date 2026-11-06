import assert from "node:assert/strict";
import test from "node:test";
import {
  Asteroid,
  Bullet,
  Entity,
  HomingBehavior,
  Pickup,
  Ship,
} from "../src/entities.js";
import { Vector2 } from "../src/vector2.js";
import { World } from "../src/world.js";
import { createGameEvents } from "../src/game-events.js";

test("Vector2 methods return new vectors without mutating their inputs", () => {
  const first = new Vector2(3, 4);
  const second = new Vector2(2, -1);
  const sum = first.add(second);
  const rotated = first.rotate(Math.PI / 2);

  assert.deepEqual(sum, new Vector2(5, 3));
  assert.ok(Math.abs(rotated.x + 4) < 1e-10);
  assert.ok(Math.abs(rotated.y - 3) < 1e-10);
  assert.deepEqual(first, new Vector2(3, 4));
  assert.notEqual(sum, first);
});

test("Ship extends Entity, exposes read-only hp and fires from its nose", () => {
  const world = new World();
  const ship = world.spawn(
    new Ship({
      id: "pilot",
      position: new Vector2(100, 100),
      angle: 0,
      local: true,
    }),
  );
  const bullet = ship.fire(world);

  assert.ok(ship instanceof Entity);
  assert.equal(ship.hp, 3);
  assert.ok(bullet instanceof Bullet);
  assert.ok(bullet.position.x > ship.position.x);
  assert.equal(ship.fire(world), null);
  assert.equal(Reflect.set(ship, "hp", 99), false);
  assert.equal(ship.hp, 3);
});

test("passing fire as an unbound callback loses this; a closure preserves it", () => {
  const ship = new Ship({ id: "pilot" });
  const invoke = ship.fire;
  assert.throws(() => invoke(new World()), TypeError);

  const world = new World();
  const boundByClosure = () => ship.fire(world);
  assert.ok(boundByClosure() instanceof Bullet);
});

test("World stores entities in a Map, filters kinds and sweeps dead entities", () => {
  const world = new World();
  const asteroid = world.spawn(new Asteroid({ id: "rock" }));
  world.spawn(new Pickup({ id: "repair" }));

  assert.equal(world.entities.size, 2);
  assert.deepEqual([...world.ofKind("asteroid")], [asteroid]);
  world.despawn("rock");
  assert.equal(asteroid.dead, true);
  assert.equal([...world.ofKind("asteroid")].length, 0);
  world.sweep();
  assert.equal(world.get("rock"), undefined);
});

test("circle collisions apply bullet damage and pickup composition", () => {
  const world = new World({ random: () => 0 });
  const shooter = world.spawn(
    new Ship({ id: "shooter", position: new Vector2(10, 10) }),
  );
  const target = world.spawn(
    new Ship({ id: "target", position: new Vector2(100, 100) }),
  );
  world.spawn(
    new Bullet({
      position: target.position,
      velocity: new Vector2(),
      ownerId: shooter.id,
    }),
  );
  world.collisionSystem.resolve(world);
  world.sweep();
  assert.equal(target.hp, 2);
  assert.equal(shooter.score, 10);

  const pickup = world.spawn(new Pickup({ position: target.position }));
  world.collisionSystem.resolve(world);
  world.sweep();
  assert.equal(target.hp, 3);
  assert.equal(pickup.dead, true);
});

test("bullets destroy asteroids and spawn pickup drops with explosions", () => {
  const world = new World({ random: () => 0 });
  const shooter = world.spawn(
    new Ship({ id: "shooter", position: new Vector2(10, 10) }),
  );
  const asteroid = world.spawn(
    new Asteroid({
      id: "rock",
      position: new Vector2(200, 200),
      hp: 1,
    }),
  );
  world.spawn(
    new Bullet({
      position: asteroid.position,
      velocity: new Vector2(),
      ownerId: shooter.id,
    }),
  );

  world.collisionSystem.resolve(world);
  world.sweep();
  assert.equal(world.get("rock"), undefined);
  assert.equal(shooter.score, 50);
  assert.equal([...world.ofKind("pickup")].length, 1);
  assert.ok([...world.ofKind("particle")].length >= 12);
});

test("homing behavior targets an asteroid and a local ship respawns after 2 seconds", () => {
  const world = new World({ random: () => 0 });
  const ship = world.spawn(
    new Ship({
      id: "pilot",
      position: new Vector2(100, 100),
      angle: 0,
      local: true,
    }),
  );
  const asteroid = world.spawn(
    new Asteroid({ id: "target-rock", position: new Vector2(100, 30) }),
  );
  const bullet = ship.fire(world, { homing: true });

  assert.ok(bullet.behavior instanceof HomingBehavior);
  assert.equal(bullet.behavior.targetId, asteroid.id);
  ship.takeDamage(3);
  world.step(1 / 60);
  assert.equal(world.get("pilot"), undefined);
  for (let step = 0; step < 120; step += 1) world.step(1 / 60);
  assert.ok(world.get("pilot") instanceof Ship);
});

test("world emits fired, hit and exploded events without importing audio or DOM", () => {
  const events = createGameEvents();
  const seen = [];
  for (const type of ["fired", "hit", "exploded"]) {
    events.addEventListener(type, (event) => seen.push(event.type));
  }
  const world = new World({ events, random: () => 0 });
  const ship = world.spawn(
    new Ship({
      id: "pilot",
      position: new Vector2(10, 10),
      angle: 0,
    }),
  );
  const asteroid = world.spawn(
    new Asteroid({
      id: "rock",
      position: new Vector2(200, 200),
      hp: 1,
    }),
  );
  ship.fire(world);
  world.spawn(
    new Bullet({
      position: asteroid.position,
      velocity: new Vector2(),
      ownerId: ship.id,
    }),
  );
  world.collisionSystem.resolve(world);
  assert.deepEqual(seen, ["fired", "hit", "exploded", "exploded"]);
});
