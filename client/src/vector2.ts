export interface Vector2Like {
  readonly x: number;
  readonly y: number;
}

export class MutableVector2 implements Vector2Like {
  x: number;
  y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  set(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  copy(value: Vector2Like): void {
    this.set(value.x, value.y);
  }
}

export class Vector2 {
  readonly x: number;
  readonly y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  add(other: Vector2Like): Vector2 {
    return new Vector2(this.x + other.x, this.y + other.y);
  }

  subtract(other: Vector2Like): Vector2 {
    return new Vector2(this.x - other.x, this.y - other.y);
  }

  scale(amount: number): Vector2 {
    return new Vector2(this.x * amount, this.y * amount);
  }

  rotate(angle: number): Vector2 {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    return new Vector2(
      this.x * cosine - this.y * sine,
      this.x * sine + this.y * cosine,
    );
  }

  normalize(): Vector2 {
    const magnitude = this.magnitude();
    return magnitude === 0 ? new Vector2() : this.scale(1 / magnitude);
  }

  magnitude(): number {
    return Math.hypot(this.x, this.y);
  }

  magnitudeSquared(): number {
    return this.x * this.x + this.y * this.y;
  }

  distanceTo(other: Vector2Like): number {
    return this.subtract(other).magnitude();
  }

  static from(value: Partial<Vector2Like> = {}): Vector2 {
    return new Vector2(value.x ?? 0, value.y ?? 0);
  }
}
