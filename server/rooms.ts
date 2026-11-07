import { EventEmitter } from "node:events";
import { randomInt, randomUUID } from "node:crypto";
import { SERVER_DT } from "../shared/physics.js";
import { ArenaSimulation } from "../shared/simulation.js";
import type {
  ArenaConfig,
  EntityId,
  InputSequence,
  PartialPlayerInput,
  RoomInfo,
  RoomPlayer,
  SimulationSnapshot,
} from "../shared/types.js";
import type { ServerMessage } from "../shared/protocol.js";
import { createLogger } from "./logger.js";
import { MatchLogger } from "./streams.js";

interface RoomLogger {
  error(object: object, message?: string): void;
  info(object: object, message?: string): void;
}

interface DefaultRoom {
  readonly id: string;
  readonly name: string;
  readonly maxPlayers: number;
  readonly arena: ArenaConfig;
}

export interface RoomClient {
  readonly id: EntityId;
  input: PartialPlayerInput;
  lastInputSeq: InputSequence;
  send(encoded: string): boolean;
  sendState(snapshot: SimulationSnapshot): boolean;
}

interface RoomMember extends RoomPlayer {
  readonly client: RoomClient;
}

interface RoomOptions extends Omit<DefaultRoom, "id"> {
  readonly id?: string;
  readonly logDirectory: string;
  readonly logger: RoomLogger;
}

interface RoomEvents {
  error: [error: Error];
  join: [{ readonly playerId: EntityId; readonly name: string }];
  leave: [
    {
      readonly playerId: EntityId;
      readonly name: string;
      readonly reason: string;
    },
  ];
  chat: [
    {
      readonly playerId: EntityId;
      readonly name: string;
      readonly text: string;
    },
  ];
}

interface RoomManagerEvents {
  error: [error: Error];
  roomCreated: [room: RoomInfo];
}

export class RoomLimitError extends Error {
  constructor() {
    super("Room limit reached.");
    this.name = "RoomLimitError";
  }
}

export const DEFAULT_ROOMS: readonly DefaultRoom[] = [
  {
    id: "ALPHA-07",
    name: "Sector 07",
    maxPlayers: 12,
    arena: {
      width: 960,
      height: 600,
      obstacles: [
        { x: 170, y: 140, radius: 27, vx: -16, vy: 11, hp: 3 },
        { x: 390, y: 430, radius: 37, vx: 12, vy: -9, hp: 3 },
        { x: 690, y: 180, radius: 31, vx: -8, vy: 15, hp: 3 },
        { x: 820, y: 440, radius: 23, vx: 18, vy: 12, hp: 3 },
        { x: 530, y: 100, radius: 20, vx: 0, vy: 0, hp: 3 },
      ],
      pickup: { x: 480, y: 450 },
    },
  },
  {
    id: "BRAVO-12",
    name: "Dust Field",
    maxPlayers: 12,
    arena: {
      width: 960,
      height: 600,
      obstacles: [
        { x: 230, y: 300, radius: 42, vx: -10, vy: 6, hp: 3 },
        { x: 470, y: 155, radius: 25, vx: 14, vy: 12, hp: 3 },
        { x: 720, y: 335, radius: 35, vx: -8, vy: -14, hp: 3 },
        { x: 510, y: 500, radius: 22, vx: 6, vy: -12, hp: 3 },
      ],
      pickup: { x: 480, y: 300 },
    },
  },
];

export class Room extends EventEmitter<RoomEvents> {
  readonly id: string;
  readonly name: string;
  readonly maxPlayers: number;
  readonly arena: ArenaConfig;
  readonly members = new Map<EntityId, RoomMember>();
  readonly simulation: ArenaSimulation;
  readonly logger: MatchLogger;

  constructor({
    id = randomUUID(),
    name,
    maxPlayers = 12,
    arena,
    logDirectory,
    logger,
  }: RoomOptions) {
    super();
    this.id = id;
    this.name = name;
    this.maxPlayers = maxPlayers;
    this.arena = arena;
    this.simulation = new ArenaSimulation(
      { width: arena.width, height: arena.height },
      randomInt(1, 0xffffffff),
      arena,
    );
    this.logger = new MatchLogger(logDirectory, id);
    this.on("error", (error) =>
      logger.error({ err: error, roomId: this.id }, "Room error"),
    );
    for (const type of ["join", "leave", "chat"] as const) {
      this.on(type, (detail) => {
        this.logger.write({ type, roomId: this.id, ...detail });
        logger.info(
          { roomId: this.id, playerId: detail.playerId, event: type },
          "Room event",
        );
      });
    }
    this.logger.on("error", (error) => this.emit("error", error));
  }

  get size(): number {
    return this.members.size;
  }

  get full(): boolean {
    return this.size >= this.maxPlayers;
  }

  add(client: RoomClient, name: string): RoomMember | false {
    if (this.members.has(client.id)) return false;
    if (this.full) throw new RangeError("Room is full.");
    const usedIndices = new Set(
      [...this.members.values()].map((member) => member.index),
    );
    let index = 0;
    while (usedIndices.has(index)) index += 1;
    const member: RoomMember = { id: client.id, name, client, index };
    this.members.set(client.id, member);
    this.simulation.addPlayer(client.id, index);
    this.emit("join", { playerId: client.id, name });
    this.broadcast({
      type: "room",
      action: "join",
      player: { id: client.id, name, index },
    });
    return member;
  }

  remove(clientId: EntityId, reason = "leave"): boolean {
    const member = this.members.get(clientId);
    if (!member) return false;
    this.members.delete(clientId);
    this.simulation.removePlayer(clientId);
    this.emit("leave", { playerId: clientId, name: member.name, reason });
    this.broadcast({
      type: "room",
      action: "leave",
      player: { id: clientId, name: member.name, index: member.index },
    });
    return true;
  }

  chat(
    clientId: EntityId,
    text: string,
  ): Extract<ServerMessage, { type: "chat" }> {
    const member = this.members.get(clientId);
    if (!member) throw new Error("Chat sender is not in this room.");
    const message: Extract<ServerMessage, { type: "chat" }> = {
      type: "chat",
      roomId: this.id,
      playerId: clientId,
      name: member.name,
      text,
      timestamp: Date.now(),
    };
    this.emit("chat", { playerId: clientId, name: member.name, text });
    this.broadcast(message);
    return message;
  }

  setInput(
    clientId: EntityId,
    input: PartialPlayerInput,
    sequence: InputSequence,
  ): boolean {
    const member = this.members.get(clientId);
    if (!member || sequence <= member.client.lastInputSeq) return false;
    member.client.input = input;
    member.client.lastInputSeq = sequence;
    return true;
  }

  step(): SimulationSnapshot {
    const inputs = new Map<
      EntityId,
      {
        input: PartialPlayerInput;
        seq: InputSequence;
      }
    >();
    for (const member of this.members.values()) {
      inputs.set(member.id, {
        input: member.client.input,
        seq: member.client.lastInputSeq,
      });
    }
    this.simulation.step(inputs, SERVER_DT);
    const acknowledgements = new Map<EntityId, InputSequence>();
    for (const member of this.members.values()) {
      acknowledgements.set(member.id, member.client.lastInputSeq);
    }
    return this.simulation.snapshot(acknowledgements);
  }

  broadcast(message: ServerMessage, excludeId?: EntityId): void {
    const encoded = JSON.stringify(message);
    for (const member of this.members.values()) {
      if (member.id === excludeId) continue;
      member.client.send(encoded);
    }
  }

  snapshot(): RoomInfo {
    return {
      id: this.id,
      name: this.name,
      maxPlayers: this.maxPlayers,
      players: this.size,
      arena: this.arena,
    };
  }

  async close(): Promise<void> {
    for (const member of [...this.members.values()]) {
      this.remove(member.id, "shutdown");
    }
    await this.logger.close();
    this.removeAllListeners();
  }
}

export class RoomManager extends EventEmitter<RoomManagerEvents> {
  readonly logDirectory: string;
  readonly logger: RoomLogger;
  readonly maxRooms: number;
  readonly maxPlayersPerRoom: number;
  readonly rooms = new Map<string, Room>();
  readonly defaultRooms: ReadonlyMap<string, DefaultRoom>;
  readonly closingRooms = new Set<Promise<void>>();

  constructor(
    logDirectory: string,
    rooms: readonly DefaultRoom[] = DEFAULT_ROOMS,
    {
      maxRooms = 100,
      maxPlayersPerRoom = 32,
      logger = createLogger("info", "development"),
    }: {
      readonly maxRooms?: number;
      readonly maxPlayersPerRoom?: number;
      readonly logger?: RoomLogger;
    } = {},
  ) {
    super();
    this.logDirectory = logDirectory;
    this.logger = logger;
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
    const defaultRooms = new Map<string, DefaultRoom>();
    for (const room of rooms) defaultRooms.set(room.id, room);
    this.defaultRooms = defaultRooms;
    this.on("error", (error) =>
      logger.error({ err: error }, "Room manager error"),
    );
    for (const room of rooms) {
      this.rooms.set(
        room.id,
        new Room({
          ...room,
          maxPlayers: Math.min(room.maxPlayers, this.maxPlayersPerRoom),
          logDirectory: this.logDirectory,
          logger,
        }),
      );
    }
  }

  get(roomId: string | null | undefined): Room | undefined {
    if (!roomId) return undefined;
    if (!this.rooms.has(roomId)) {
      const defaultRoom = this.defaultRooms.get(roomId);
      if (!defaultRoom) return undefined;
      const room = new Room({
        ...defaultRoom,
        logDirectory: this.logDirectory,
        logger: this.logger,
      });
      this.rooms.set(roomId, room);
    }
    return this.rooms.get(roomId);
  }

  create({
    name,
    maxPlayers = Math.min(12, this.maxPlayersPerRoom),
  }: {
    readonly name: string;
    readonly maxPlayers?: number;
  }): Room {
    const normalizedName = name.trim().slice(0, 40);
    if (!normalizedName) throw new TypeError("Room name is required.");
    if (
      !Number.isInteger(maxPlayers) ||
      maxPlayers < 2 ||
      maxPlayers > this.maxPlayersPerRoom
    ) {
      throw new RangeError(
        `maxPlayers must be an integer between 2 and ${this.maxPlayersPerRoom}.`,
      );
    }
    if (this.rooms.size >= this.maxRooms) {
      throw new RoomLimitError();
    }
    const room = new Room({
      id: randomUUID(),
      name: normalizedName,
      maxPlayers,
      arena: { width: 960, height: 600 },
      logDirectory: this.logDirectory,
      logger: this.logger,
    });
    this.rooms.set(room.id, room);
    this.emit("roomCreated", room.snapshot());
    return room;
  }

  join(roomId: string, client: RoomClient, name: string): RoomMember | false {
    const room = this.get(roomId);
    if (!room) throw new Error("Room not found.");
    return room.add(client, name);
  }

  leave(clientId: EntityId, reason?: string): Room | null {
    for (const room of this.rooms.values()) {
      const roomId = room.id;
      if (!room.remove(clientId, reason)) continue;
      if (room.size === 0) {
        this.rooms.delete(roomId);
        const closing = room
          .close()
          .catch((error: unknown) => {
            this.emit(
              "error",
              error instanceof Error ? error : new Error(String(error)),
            );
          })
          .finally(() => {
            this.closingRooms.delete(closing);
          });
        this.closingRooms.add(closing);
      }
      return room;
    }
    return null;
  }

  list(): RoomInfo[] {
    for (const roomId of this.defaultRooms.keys()) {
      if (!this.rooms.has(roomId)) this.get(roomId);
    }
    return [...this.rooms.values()].map((room) => room.snapshot());
  }

  async close(): Promise<void> {
    await Promise.all([
      ...[...this.rooms.values()].map((room) => room.close()),
      ...this.closingRooms,
    ]);
    this.rooms.clear();
  }
}
