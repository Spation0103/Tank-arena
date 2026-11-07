import { z } from "zod";
import { asEntityId, asInputSequence, asSimulationStep } from "./types.js";
import type {
  BulletSnapshot,
  EntityId,
  InputSequence,
  PartialPlayerInput,
  SimulationSnapshot,
  SimulationStep,
  TankSnapshot,
} from "./types.js";

export const PROTOCOL_VERSION = 2;
export const INPUT_PACKET = 1;
export const SNAPSHOT_PACKET = 2;
export const INPUT_PACKET_BYTES = 7;

const SNAPSHOT_HEADER_BYTES = 26;
const TANK_RECORD_BYTES = 24;
const BULLET_RECORD_BYTES = 24;
const OBSTACLE_RECORD_BYTES = 16;
const MAX_UINT32 = 0xffffffff;

const entityIdSchema = z.string().min(1).transform(asEntityId);
const sequenceSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_UINT32)
  .transform(asInputSequence);
const inputSchema = z
  .object({
    forward: z.boolean().optional(),
    backward: z.boolean().optional(),
    left: z.boolean().optional(),
    right: z.boolean().optional(),
    fire: z.boolean().optional(),
    homing: z.boolean().optional(),
  })
  .strict();

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("join"),
      roomId: z.string().min(1).max(40),
      name: z
        .string()
        .max(16)
        .refine((value) => value.trim().length > 0),
      protocol: z.enum(["binary", "json"]).optional(),
    })
    .strict(),
  z.object({ type: z.literal("leave") }).strict(),
  z
    .object({
      type: z.literal("chat"),
      text: z
        .string()
        .max(500)
        .refine((value) => value.trim().length > 0),
    })
    .strict(),
  z
    .object({
      type: z.literal("input"),
      seq: sequenceSchema,
      input: inputSchema,
    })
    .strict(),
]);

const pointSchema = z.object({ x: z.number(), y: z.number() });
const arenaSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  obstacles: z
    .array(
      z.object({
        x: z.number(),
        y: z.number(),
        radius: z.number().positive(),
        vx: z.number().optional(),
        vy: z.number().optional(),
        hp: z.number().int().positive().max(255).optional(),
      }),
    )
    .optional(),
  pickup: pointSchema.optional(),
});
export const RoomInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  maxPlayers: z.number().int().positive(),
  players: z.number().int().nonnegative(),
  arena: arenaSchema,
});
const playerSchema = z.object({
  id: entityIdSchema,
  name: z.string(),
  index: z.number().int().nonnegative(),
});
const tankSnapshotSchema = z
  .object({
    kind: z.literal("tank"),
    id: entityIdSchema.optional(),
    index: z.number().int().nonnegative(),
    x: z.number().finite(),
    y: z.number().finite(),
    vx: z.number().finite(),
    vy: z.number().finite(),
    angle: z.number().finite(),
    hp: z.number().int().min(0).max(5),
    score: z.number().int().nonnegative(),
    color: z.string().optional(),
  })
  .strict();
const bulletSnapshotSchema = z
  .object({
    kind: z.literal("bullet"),
    id: z.number().int().min(1).max(0xffff),
    ownerId: entityIdSchema.optional(),
    ownerIndex: z.number().int().nonnegative(),
    fireSeq: sequenceSchema,
    x: z.number().finite(),
    y: z.number().finite(),
    vx: z.number().finite(),
    vy: z.number().finite(),
    homing: z.boolean(),
  })
  .strict();
const stateMessageSchema = z.object({
  type: z.literal("state"),
  tick: z.number().int().min(0).max(MAX_UINT32).transform(asSimulationStep),
  serverTime: z.number().int().min(0).max(MAX_UINT32),
  ack: sequenceSchema,
  tanks: z.array(tankSnapshotSchema),
  bullets: z.array(bulletSnapshotSchema),
  obstacles: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      x: z.number().finite(),
      y: z.number().finite(),
      radius: z.number().positive(),
      hp: z.number().int().nonnegative(),
      maxHp: z.number().int().positive(),
    }),
  ),
  pickup: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    active: z.boolean(),
  }),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    playerId: entityIdSchema,
    roomId: z.string(),
    room: RoomInfoSchema,
    seed: z.number().int().nonnegative(),
    state: z
      .object({
        id: entityIdSchema,
        index: z.number().int().nonnegative(),
        x: z.number().finite(),
        y: z.number().finite(),
        vx: z.number().finite(),
        vy: z.number().finite(),
        angle: z.number().finite(),
        color: z.string(),
        hp: z.number().int().min(0).max(5),
        score: z.number().int().nonnegative(),
      })
      .optional(),
    players: z.array(playerSchema),
  }),
  z.object({
    type: z.literal("room"),
    action: z.enum(["join", "leave"]),
    player: playerSchema,
  }),
  z.object({
    type: z.literal("chat"),
    roomId: z.string(),
    playerId: entityIdSchema,
    name: z.string(),
    text: z.string(),
    timestamp: z.number(),
  }),
  stateMessageSchema,
  z.object({ type: z.literal("left"), roomId: z.string().nullable() }),
  z.object({
    type: z.literal("shutdown"),
    reason: z.string().optional(),
  }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type JoinMessage = Extract<ClientMessage, { type: "join" }>;
export type InputMessage = Extract<ClientMessage, { type: "input" }>;
export type StateMessage = z.infer<typeof stateMessageSchema>;

export type ClientMessageParseResult =
  | { readonly success: true; readonly data: ClientMessage }
  | {
      readonly success: false;
      readonly reason: "invalid-json" | "invalid-message";
      readonly error: string;
    };

export function parseClientMessage(value: unknown): ClientMessageParseResult {
  let candidate = value;
  if (typeof value === "string") {
    try {
      const decoded: unknown = JSON.parse(value);
      candidate = decoded;
    } catch (error: unknown) {
      return {
        success: false,
        reason: "invalid-json",
        error: error instanceof Error ? error.message : "Invalid JSON",
      };
    }
  }
  const parsed = ClientMessageSchema.safeParse(candidate);
  return parsed.success
    ? { success: true, data: parsed.data }
    : {
        success: false,
        reason: "invalid-message",
        error: parsed.error.message,
      };
}

export function encodeInputPacket(
  sequence: InputSequence,
  input: PartialPlayerInput,
): ArrayBuffer {
  const buffer = new ArrayBuffer(INPUT_PACKET_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, INPUT_PACKET);
  view.setUint32(2, sequence, true);
  view.setUint8(6, encodeInputFlags(input));
  return buffer;
}

export function decodeInputPacket(data: ArrayBuffer | ArrayBufferView): {
  readonly sequence: InputSequence;
  readonly input: Required<PartialPlayerInput>;
} {
  const view = asDataView(data);
  if (
    view.byteLength !== INPUT_PACKET_BYTES ||
    view.getUint8(0) !== PROTOCOL_VERSION ||
    view.getUint8(1) !== INPUT_PACKET
  ) {
    throw new RangeError("Invalid input packet.");
  }
  const flags = view.getUint8(6);
  if (flags & 0xc0) throw new RangeError("Reserved input flags must be zero.");
  return {
    sequence: asInputSequence(view.getUint32(2, true)),
    input: {
      forward: Boolean(flags & 1),
      backward: Boolean(flags & 2),
      left: Boolean(flags & 4),
      right: Boolean(flags & 8),
      fire: Boolean(flags & 16),
      homing: Boolean(flags & 32),
    },
  };
}

export function encodeSnapshotPacket(
  snapshot: SimulationSnapshot,
  localId: EntityId,
): ArrayBuffer {
  if (
    snapshot.tanks.length > 255 ||
    snapshot.bullets.length > 255 ||
    snapshot.obstacles.length > 255
  ) {
    throw new RangeError("Snapshot entity counts must fit in one byte.");
  }
  if (
    !Number.isFinite(snapshot.pickup.x) ||
    !Number.isFinite(snapshot.pickup.y) ||
    snapshot.obstacles.some(
      (obstacle) =>
        obstacle.hp < 0 ||
        obstacle.hp > obstacle.maxHp ||
        obstacle.maxHp > 255 ||
        obstacle.index > 255 ||
        ![obstacle.x, obstacle.y, obstacle.radius].every(Number.isFinite),
    )
  ) {
    throw new RangeError("Snapshot arena values are out of range.");
  }
  const buffer = new ArrayBuffer(
    SNAPSHOT_HEADER_BYTES +
      snapshot.tanks.length * TANK_RECORD_BYTES +
      snapshot.bullets.length * BULLET_RECORD_BYTES +
      snapshot.obstacles.length * OBSTACLE_RECORD_BYTES,
  );
  const view = new DataView(buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, SNAPSHOT_PACKET);
  view.setUint32(2, snapshot.tick, true);
  view.setUint32(6, snapshot.acknowledgements.get(localId) ?? 0, true);
  view.setUint32(10, snapshot.serverTime, true);
  view.setUint8(14, snapshot.tanks.length);
  view.setUint8(15, snapshot.bullets.length);
  view.setUint8(16, snapshot.obstacles.length);
  view.setUint8(17, Number(snapshot.pickup.active));
  view.setFloat32(18, snapshot.pickup.x, true);
  view.setFloat32(22, snapshot.pickup.y, true);

  let offset = SNAPSHOT_HEADER_BYTES;
  for (const tank of snapshot.tanks) {
    view.setUint8(offset, tank.index);
    view.setFloat32(offset + 1, tank.x, true);
    view.setFloat32(offset + 5, tank.y, true);
    view.setFloat32(offset + 9, tank.vx, true);
    view.setFloat32(offset + 13, tank.vy, true);
    view.setInt16(offset + 17, encodeAngle(tank.angle), true);
    view.setUint8(offset + 19, tank.hp);
    view.setUint32(offset + 20, tank.score, true);
    offset += TANK_RECORD_BYTES;
  }
  for (const bullet of snapshot.bullets) {
    view.setUint16(offset, bullet.id, true);
    view.setUint8(offset + 2, bullet.ownerIndex);
    view.setUint8(offset + 3, Number(bullet.homing));
    view.setUint32(offset + 4, bullet.fireSeq, true);
    view.setFloat32(offset + 8, bullet.x, true);
    view.setFloat32(offset + 12, bullet.y, true);
    view.setFloat32(offset + 16, bullet.vx, true);
    view.setFloat32(offset + 20, bullet.vy, true);
    offset += BULLET_RECORD_BYTES;
  }
  for (const obstacle of snapshot.obstacles) {
    view.setUint8(offset, obstacle.index);
    view.setFloat32(offset + 1, obstacle.x, true);
    view.setFloat32(offset + 5, obstacle.y, true);
    view.setFloat32(offset + 9, obstacle.radius, true);
    view.setUint8(offset + 13, obstacle.hp);
    view.setUint8(offset + 14, obstacle.maxHp);
    offset += OBSTACLE_RECORD_BYTES;
  }
  return buffer;
}

export function decodeSnapshotPacket(
  data: ArrayBuffer | ArrayBufferView,
): StateMessage {
  const view = asDataView(data);
  if (
    view.byteLength < SNAPSHOT_HEADER_BYTES ||
    view.getUint8(0) !== PROTOCOL_VERSION ||
    view.getUint8(1) !== SNAPSHOT_PACKET
  ) {
    throw new RangeError("Invalid snapshot packet.");
  }
  const tankCount = view.getUint8(14);
  const bulletCount = view.getUint8(15);
  const obstacleCount = view.getUint8(16);
  const pickupActive = view.getUint8(17);
  if (pickupActive > 1) throw new RangeError("Invalid pickup flags.");
  const expectedLength =
    SNAPSHOT_HEADER_BYTES +
    tankCount * TANK_RECORD_BYTES +
    bulletCount * BULLET_RECORD_BYTES +
    obstacleCount * OBSTACLE_RECORD_BYTES;
  if (view.byteLength !== expectedLength) {
    throw new RangeError("Snapshot packet has an invalid length.");
  }

  const tanks: TankSnapshot[] = [];
  const bullets: BulletSnapshot[] = [];
  const obstacles: StateMessage["obstacles"][number][] = [];
  let offset = SNAPSHOT_HEADER_BYTES;
  for (let index = 0; index < tankCount; index += 1) {
    const tank: TankSnapshot = {
      kind: "tank",
      index: view.getUint8(offset),
      x: view.getFloat32(offset + 1, true),
      y: view.getFloat32(offset + 5, true),
      vx: view.getFloat32(offset + 9, true),
      vy: view.getFloat32(offset + 13, true),
      angle: decodeAngle(view.getInt16(offset + 17, true)),
      hp: view.getUint8(offset + 19),
      score: view.getUint32(offset + 20, true),
    };
    validateTankValues(tank);
    tanks.push(tank);
    offset += TANK_RECORD_BYTES;
  }
  for (let index = 0; index < bulletCount; index += 1) {
    const flags = view.getUint8(offset + 3);
    if (flags > 1) throw new RangeError("Reserved bullet flags must be zero.");
    const bullet: BulletSnapshot = {
      kind: "bullet",
      id: view.getUint16(offset, true),
      ownerIndex: view.getUint8(offset + 2),
      fireSeq: asInputSequence(view.getUint32(offset + 4, true)),
      x: view.getFloat32(offset + 8, true),
      y: view.getFloat32(offset + 12, true),
      vx: view.getFloat32(offset + 16, true),
      vy: view.getFloat32(offset + 20, true),
      homing: Boolean(flags),
    };
    validateBulletValues(bullet);
    bullets.push(bullet);
    offset += BULLET_RECORD_BYTES;
  }
  for (let index = 0; index < obstacleCount; index += 1) {
    const obstacle = {
      index: view.getUint8(offset),
      x: view.getFloat32(offset + 1, true),
      y: view.getFloat32(offset + 5, true),
      radius: view.getFloat32(offset + 9, true),
      hp: view.getUint8(offset + 13),
      maxHp: view.getUint8(offset + 14),
    };
    if (view.getUint8(offset + 15) !== 0) {
      throw new RangeError("Reserved obstacle flags must be zero.");
    }
    if (
      ![obstacle.x, obstacle.y, obstacle.radius].every(Number.isFinite) ||
      obstacle.radius <= 0 ||
      obstacle.hp > obstacle.maxHp ||
      obstacle.maxHp === 0
    ) {
      throw new RangeError("Invalid obstacle values.");
    }
    obstacles.push(obstacle);
    offset += OBSTACLE_RECORD_BYTES;
  }
  const pickup = {
    x: view.getFloat32(18, true),
    y: view.getFloat32(22, true),
    active: Boolean(pickupActive),
  };
  if (![pickup.x, pickup.y].every(Number.isFinite)) {
    throw new RangeError("Pickup coordinates must be finite.");
  }
  return {
    type: "state",
    tick: asSimulationStep(view.getUint32(2, true)),
    ack: asInputSequence(view.getUint32(6, true)),
    serverTime: view.getUint32(10, true),
    tanks,
    bullets,
    obstacles,
    pickup,
  };
}

export function encodeSnapshotJson(
  snapshot: SimulationSnapshot,
  localId: EntityId,
): StateMessage {
  return {
    type: "state",
    tick: snapshot.tick,
    serverTime: snapshot.serverTime,
    ack: snapshot.acknowledgements.get(localId) ?? asInputSequence(0),
    tanks: [...snapshot.tanks],
    bullets: [...snapshot.bullets],
    obstacles: [...snapshot.obstacles],
    pickup: { ...snapshot.pickup },
  };
}

export function decodeSnapshotJson(message: unknown): StateMessage {
  const parsed = stateMessageSchema.safeParse(message);
  if (!parsed.success) throw new TypeError("Invalid JSON snapshot.");
  return parsed.data;
}

export function isServerMessage(value: unknown): value is ServerMessage {
  return ServerMessageSchema.safeParse(value).success;
}

function encodeInputFlags(input: PartialPlayerInput): number {
  return (
    Number(input.forward === true) |
    (Number(input.backward === true) << 1) |
    (Number(input.left === true) << 2) |
    (Number(input.right === true) << 3) |
    (Number(input.fire === true) << 4) |
    (Number(input.homing === true) << 5)
  );
}

function encodeAngle(angle: number): number {
  if (!Number.isFinite(angle)) throw new RangeError("Angle must be finite.");
  return Math.round((normalizeAngle(angle) / Math.PI) * 32767);
}

function decodeAngle(value: number): number {
  return (value / 32767) * Math.PI;
}

function normalizeAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function asDataView(data: ArrayBuffer | ArrayBufferView): DataView {
  if (data instanceof ArrayBuffer) return new DataView(data);
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function validateTankValues(tank: {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly hp: number;
}): void {
  if (![tank.x, tank.y, tank.vx, tank.vy].every(Number.isFinite)) {
    throw new RangeError("Tank coordinates and velocity must be finite.");
  }
  if (tank.hp > 5) throw new RangeError("Tank HP is out of range.");
}

function validateBulletValues(
  bullet: Pick<BulletSnapshot, "id" | "x" | "y" | "vx" | "vy">,
): void {
  if (bullet.id === 0) throw new RangeError("Bullet ids must be non-zero.");
  if (![bullet.x, bullet.y, bullet.vx, bullet.vy].every(Number.isFinite)) {
    throw new RangeError("Bullet coordinates and velocity must be finite.");
  }
}

export function isSnapshotStepNewer(
  candidate: SimulationStep,
  current: SimulationStep,
): boolean {
  return candidate > current;
}
