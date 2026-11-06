import { delay } from "./async-utils.js";
import { loadJson } from "./asset-loader.js";
import { RoomInfoSchema } from "../../shared/protocol.js";
import type { RoomInfo } from "../../shared/types.js";
import { z } from "zod";

const ROOMS_URL =
  import.meta.env.VITE_ROOMS_URL ?? new URL("/api/rooms", location.origin).href;
const POLL_INTERVAL = 3000;

const RoomListSchema = z.array(RoomInfoSchema);
export const LobbyJoinDetailsSchema = z.object({
  name: z.string(),
  room: RoomInfoSchema,
});
export interface LobbyJoinDetails {
  readonly name: string;
  readonly room: RoomInfo;
}

interface LobbyEventMap {
  readonly rooms: readonly RoomInfo[];
  readonly error: unknown;
  readonly join: LobbyJoinDetails;
}

type LobbyUpdate =
  | { readonly type: "rooms"; readonly rooms: RoomInfo[] }
  | { readonly type: "error"; readonly error: unknown };

export class Lobby extends EventTarget {
  #controller: AbortController | null = null;
  #visible = false;
  #rooms: RoomInfo[] = [];

  get rooms() {
    return this.#rooms;
  }

  start() {
    if (this.#visible) return;
    this.#visible = true;
    const controller = new AbortController();
    this.#controller = controller;
    void this.#poll(controller.signal);
  }

  stop() {
    this.#visible = false;
    this.#controller?.abort();
    this.#controller = null;
  }

  join({
    name,
    roomId,
  }: {
    readonly name: string;
    readonly roomId: string;
  }): boolean {
    const normalizedName = name.trim().slice(0, 16);
    const room = this.#rooms.find((candidate) => candidate.id === roomId);
    if (!normalizedName) {
      this.#dispatch("error", new Error("Введіть ім’я гравця."));
      return false;
    }
    if (!room || room.players >= room.maxPlayers) {
      this.#dispatch("error", new Error("Кімната недоступна або заповнена."));
      return false;
    }
    this.stop();
    this.#dispatch("join", { name: normalizedName, room });
    return true;
  }

  async *updates(signal: AbortSignal): AsyncGenerator<LobbyUpdate> {
    while (!signal.aborted && this.#visible) {
      if (document.hidden) {
        await delay(POLL_INTERVAL, signal);
        continue;
      }
      try {
        const timeout = AbortSignal.timeout(2500);
        const requestSignal = AbortSignal.any([signal, timeout]);
        const rooms = RoomListSchema.parse(
          await loadJson(ROOMS_URL, { signal: requestSignal }),
        );
        yield { type: "rooms", rooms };
      } catch (error: unknown) {
        if (signal.aborted) return;
        yield { type: "error", error };
      }
      await delay(POLL_INTERVAL, signal);
    }
  }

  async #poll(signal: AbortSignal): Promise<void> {
    try {
      for await (const update of this.updates(signal)) {
        if (update.type === "rooms") {
          this.#rooms = update.rooms;
          this.#dispatch("rooms", update.rooms);
        } else {
          this.#dispatch("error", update.error);
        }
      }
    } catch (error: unknown) {
      if (!signal.aborted) this.#dispatch("error", error);
    }
  }

  #dispatch<K extends keyof LobbyEventMap>(
    type: K,
    detail: LobbyEventMap[K],
  ): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
