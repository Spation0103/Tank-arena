import { LobbyJoinDetailsSchema } from "./lobby.js";
import type { Lobby, LobbyJoinDetails } from "./lobby.js";
import type { RoomInfo } from "../../shared/types.js";

type JoinHandler = (detail: LobbyJoinDetails) => void;

export function bindLobbyDom(
  lobby: Lobby,
  onJoin: JoinHandler,
): {
  showLoading(): void;
  showLobby(): void;
  destroy(): void;
} {
  const root = requiredElement<HTMLElement>("#lobby");
  const form = requiredElement<HTMLFormElement>("#lobby-form");
  const select = requiredElement<HTMLSelectElement>("#room-select");
  const status = requiredElement<HTMLElement>("#lobby-status");
  const joinButton = requiredElement<HTMLButtonElement>("#join-button");
  const playerName = requiredElement<HTMLInputElement>("#player-name");

  function renderRooms(rooms: readonly RoomInfo[]): void {
    const selected = select.value;
    select.replaceChildren();
    for (const room of rooms) {
      const option = document.createElement("option");
      option.value = room.id;
      option.disabled = room.players >= room.maxPlayers;
      option.textContent = `${room.name} · ${room.players}/${room.maxPlayers}`;
      select.append(option);
    }
    if (rooms.some((room) => room.id === selected)) select.value = selected;
    joinButton.disabled = rooms.length === 0;
    status.textContent = rooms.length
      ? "Оберіть кімнату й приєднайтесь."
      : "Кімнат поки немає.";
  }

  const onRooms = (_event: Event) => renderRooms(lobby.rooms);
  const onError = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    const message =
      detail instanceof Error ? detail.message : "Невідома помилка";
    status.textContent = `Не вдалося оновити лобі: ${message}`;
  };
  const onJoinRequest = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    const parsed = LobbyJoinDetailsSchema.safeParse(detail);
    if (parsed.success) onJoin(parsed.data);
  };
  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    lobby.join({ name: playerName.value, roomId: select.value });
  };

  lobby.addEventListener("rooms", onRooms);
  lobby.addEventListener("error", onError);
  lobby.addEventListener("join", onJoinRequest);
  form.addEventListener("submit", onSubmit);
  root.hidden = false;
  lobby.start();

  return {
    showLoading() {
      root.hidden = true;
    },
    showLobby() {
      root.hidden = false;
      lobby.start();
    },
    destroy() {
      lobby.stop();
      lobby.removeEventListener("rooms", onRooms);
      lobby.removeEventListener("error", onError);
      lobby.removeEventListener("join", onJoinRequest);
      form.removeEventListener("submit", onSubmit);
    },
  };
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing lobby element: ${selector}`);
  return element;
}
