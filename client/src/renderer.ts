import { ARENA_HEIGHT, ARENA_WIDTH } from "./physics.js";
import {
  Asteroid,
  Bullet,
  Entity,
  Particle,
  Pickup,
  Ship,
} from "./entities.js";
import type { Vector2Like } from "./vector2.js";

function getContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable.");
  return context;
}

export function createRenderer(
  canvas: HTMLCanvasElement,
  assets: ReadonlyMap<string, unknown> = new Map(),
): {
  draw(entities: Iterable<Entity>, localId: string | null, alpha: number): void;
  destroy(): void;
} {
  const context = getContext(canvas);
  let width = 1;
  let height = 1;
  let pixelRatio = 1;
  const interpolatedPosition = { x: 0, y: 0 };

  function resize() {
    const bounds = canvas.getBoundingClientRect();
    pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    width = bounds.width;
    height = bounds.height;
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  }

  function render(
    entities: Iterable<Entity>,
    localId: string | null,
    alpha = 1,
  ): void {
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#171d17";
    context.fillRect(0, 0, width, height);
    drawGrid();

    const scaleX = width / ARENA_WIDTH;
    const scaleY = height / ARENA_HEIGHT;
    context.save();
    context.scale(scaleX, scaleY);
    for (const entity of entities) {
      interpolatePosition(entity, alpha, interpolatedPosition);
      const position = interpolatedPosition;
      switch (entity.kind) {
        case "entity":
          break;
        case "ship":
          if (entity instanceof Ship)
            drawShip(entity, position, entity.id === localId);
          break;
        case "bullet":
          if (entity instanceof Bullet) drawBullet(entity, position);
          break;
        case "asteroid":
          if (entity instanceof Asteroid) drawAsteroid(entity, position);
          break;
        case "pickup":
          if (entity instanceof Pickup && entity.active)
            drawPickup(entity, position);
          break;
        case "particle":
          if (entity instanceof Particle) drawParticle(entity, position);
          break;
        default:
          assertNever(entity.kind);
      }
    }
    context.restore();
  }

  function interpolatePosition(
    entity: Entity,
    alpha: number,
    result: { x: number; y: number },
  ): void {
    result.x =
      entity.previousPosition.x +
      wrappedDelta(entity.position.x - entity.previousPosition.x, ARENA_WIDTH) *
        alpha;
    result.y =
      entity.previousPosition.y +
      wrappedDelta(
        entity.position.y - entity.previousPosition.y,
        ARENA_HEIGHT,
      ) *
        alpha;
  }

  function drawGrid(): void {
    const cell = 32;
    context.strokeStyle = "rgba(185, 210, 156, 0.055)";
    context.lineWidth = 1;
    context.beginPath();
    for (let x = 0.5; x < width; x += cell) {
      context.moveTo(x, 0);
      context.lineTo(x, height);
    }
    for (let y = 0.5; y < height; y += cell) {
      context.moveTo(0, y);
      context.lineTo(width, y);
    }
    context.stroke();
    context.strokeStyle = "rgba(193, 232, 134, 0.55)";
    context.lineWidth = 2;
    context.strokeRect(1, 1, width - 2, height - 2);
  }

  function drawShip(ship: Ship, position: Vector2Like, isLocal: boolean): void {
    context.save();
    context.translate(position.x, position.y);
    context.rotate(ship.angle);
    context.fillStyle = "rgba(0, 0, 0, 0.3)";
    context.fillRect(-15, -9, 33, 22);
    const tankSheet = getImageAsset(assets, "tank");
    if (tankSheet) {
      context.drawImage(
        tankSheet,
        tankFrame(ship.color) * 32,
        0,
        32,
        32,
        -20,
        -16,
        40,
        32,
      );
    } else {
      context.fillStyle = "#333b30";
      context.fillRect(-15, -11, 30, 7);
      context.fillRect(-15, 4, 30, 7);
      context.fillStyle = ship.color;
      context.fillRect(-12, -8, 24, 16);
      context.fillStyle = "#d8e6bd";
      context.fillRect(3, -2, 19, 4);
      context.beginPath();
      context.arc(0, 0, 6, 0, Math.PI * 2);
      context.fillStyle = isLocal ? "#f2f5df" : "#c2cfaa";
      context.fill();
    }
    context.restore();

    context.font = "11px 'IBM Plex Mono', monospace";
    context.textAlign = "center";
    context.fillStyle = isLocal ? "#d5edaa" : "rgba(232, 236, 221, 0.7)";
    context.fillText(
      isLocal ? "YOU" : ship.id.slice(0, 6).toUpperCase(),
      position.x,
      position.y - 20,
    );
    if (ship.hp < 5) {
      context.fillStyle = ship.hp <= 2 ? "#e78770" : "#c1e886";
      context.fillRect(position.x - 16, position.y - 27, 32 * (ship.hp / 5), 2);
    }
  }

  function drawBullet(bullet: Bullet, position: Vector2Like): void {
    const bulletSheet = getImageAsset(assets, "bullet");
    if (bulletSheet) {
      context.drawImage(
        bulletSheet,
        bulletFrame(bullet.color) * 16,
        0,
        16,
        16,
        position.x - bullet.radius,
        position.y - bullet.radius,
        bullet.radius * 2,
        bullet.radius * 2,
      );
      return;
    }
    context.beginPath();
    context.arc(position.x, position.y, bullet.radius, 0, Math.PI * 2);
    context.fillStyle = bullet.color;
    context.shadowColor = bullet.color;
    context.shadowBlur = 9;
    context.fill();
    context.shadowBlur = 0;
  }

  function drawAsteroid(asteroid: Asteroid, position: Vector2Like): void {
    const asteroidSheet = getImageAsset(assets, "asteroid");
    if (asteroidSheet) {
      context.save();
      context.translate(position.x, position.y);
      context.rotate(asteroid.rotation);
      context.drawImage(
        asteroidSheet,
        asteroidFrame(asteroid.radius) * 32,
        0,
        32,
        32,
        -asteroid.radius,
        -asteroid.radius,
        asteroid.radius * 2,
        asteroid.radius * 2,
      );
      context.restore();
    } else {
      context.save();
      context.translate(position.x, position.y);
      context.rotate(asteroid.rotation);
      context.beginPath();
      for (let index = 0; index < 9; index += 1) {
        const angle = (index / 9) * Math.PI * 2;
        const radius = asteroid.radius * (index % 2 === 0 ? 1 : 0.78);
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.closePath();
      context.fillStyle = asteroid.color;
      context.fill();
      context.strokeStyle = "#a0a18a";
      context.lineWidth = 2;
      context.stroke();
      context.restore();
    }
    if (asteroid.hp < asteroid.maxHp) {
      context.fillStyle = "rgba(13, 18, 14, 0.8)";
      context.fillRect(
        position.x - asteroid.radius,
        position.y + asteroid.radius + 5,
        asteroid.radius * 2,
        3,
      );
      context.fillStyle = "#f0bd6b";
      context.fillRect(
        position.x - asteroid.radius,
        position.y + asteroid.radius + 5,
        (asteroid.radius * 2 * asteroid.hp) / asteroid.maxHp,
        3,
      );
    }
  }

  function drawPickup(pickup: Pickup, position: Vector2Like): void {
    context.save();
    context.translate(position.x, position.y);
    context.rotate(pickup.rotation);
    context.fillStyle = pickup.color;
    context.shadowColor = pickup.color;
    context.shadowBlur = 14;
    context.fillRect(
      -pickup.radius,
      -pickup.radius,
      pickup.radius * 2,
      pickup.radius * 2,
    );
    context.shadowBlur = 0;
    context.fillStyle = "#28281e";
    context.fillRect(-2, -pickup.radius + 4, 4, pickup.radius * 2 - 8);
    context.fillRect(-pickup.radius + 4, -2, pickup.radius * 2 - 8, 4);
    context.restore();
  }

  function drawParticle(particle: Particle, position: Vector2Like): void {
    context.globalAlpha = Math.max(0, particle.ttl / particle.maxTtl);
    context.beginPath();
    context.arc(position.x, position.y, particle.radius, 0, Math.PI * 2);
    context.fillStyle = particle.color;
    context.fill();
    context.globalAlpha = 1;
  }

  resize();
  window.addEventListener("resize", resize);
  return {
    draw(entities, localId, alpha) {
      render(entities, localId, alpha);
    },
    destroy() {
      window.removeEventListener("resize", resize);
    },
  };
}

function getImageAsset(
  assets: ReadonlyMap<string, unknown>,
  key: string,
): ImageBitmap | HTMLImageElement | undefined {
  const asset = assets.get(key);
  if (asset instanceof ImageBitmap || asset instanceof HTMLImageElement) {
    return asset;
  }
  return undefined;
}

function assertNever(value: never): never {
  throw new Error(`Unknown entity kind: ${value}`);
}

function wrappedDelta(delta: number, size: number): number {
  return ((((delta + size / 2) % size) + size) % size) - size / 2;
}

function tankFrame(color: string): number {
  const frames = ["#c1e886", "#e7a96d", "#8bc6d8", "#cf9cdd"];
  return Math.max(0, frames.indexOf(color));
}

function bulletFrame(color: string): number {
  const frames = ["#f3dfa0", "#c1e886", "#e7a96d", "#8bc6d8"];
  return Math.max(0, frames.indexOf(color));
}

function asteroidFrame(radius: number): number {
  return radius < 25 ? 0 : radius < 30 ? 1 : radius < 36 ? 2 : 3;
}
