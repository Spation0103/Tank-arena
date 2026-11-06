import { asEntityId, asInputSequence } from "../../shared/types.js";
import type {
  EntityId,
  InputSequence,
  RoomInfo,
  RoomPlayer,
  SimulationStep,
  TankSnapshot,
} from "../../shared/types.js";
import type { ServerMessage, StateMessage } from "../../shared/protocol.js";
import { AssetManifestSchema, loadAll, loadJson } from "./asset-loader.js";
import { AudioSystem } from "./audio.js";
import { createGameEvents } from "./game-events.js";
import { createInput } from "./input.js";
import { createLoop } from "./loop.js";
import type { LoopMode } from "./loop.js";
import { Lobby } from "./lobby.js";
import type { LobbyJoinDetails } from "./lobby.js";
import { bindLobbyDom } from "./lobby-dom.js";
import { createLoadingProgress } from "./loading-progress.js";
import { connect } from "./network.js";
import type {
  ConnectionStatus,
  GameConnection,
  TrafficDirection,
} from "./network.js";
import { ClientPrediction } from "./prediction.js";
import type { PredictedState } from "./prediction.js";
import { SERVER_DT } from "./physics.js";
import { createRenderer } from "./renderer.js";
import { Bullet, Ship } from "./entities.js";
import type { Entity } from "./entities.js";
import { Vector2 } from "./vector2.js";
import { createArenaWorld } from "./world.js";
import type { World } from "./world.js";
import "./style.css";

interface RenderTank extends TankSnapshot {
  readonly id: EntityId;
  readonly color: string;
}

interface SnapshotFrame {
  readonly sampleTime: number;
  readonly tanks: readonly RenderTank[];
}

interface TankState {
  readonly id: EntityId;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  readonly hp: number;
  readonly score: number;
}

const canvas = requiredElement<HTMLCanvasElement>("#arena");
const gameShell = requiredElement<HTMLElement>("#game-shell");
const gameLayout = requiredElement<HTMLElement>("#game-layout");
const assetLoading = requiredElement<HTMLElement>("#asset-loading");
const loadingCanvas = requiredElement<HTMLCanvasElement>("#loading-canvas");
const assetStatus = requiredElement<HTMLElement>("#asset-status");
const retryButton = requiredElement<HTMLButtonElement>("#asset-retry");
const backButton = requiredElement<HTMLButtonElement>("#lobby-back");
const connection = requiredElement<HTMLElement>("#connection");
const connectionLabel = requiredElement<HTMLElement>("#connection-label");
const playerCount = requiredElement<HTMLElement>("#player-count");
const playerList = requiredElement<HTMLUListElement>("#player-list");
const roomLabel = requiredElement<HTMLElement>("#room-id");
const modeSelect = requiredElement<HTMLSelectElement>("#loop-mode");
const experimentResult = requiredElement<HTMLElement>("#experiment-result");
const hpValue = requiredElement<HTMLElement>("#hp-value");
const scoreValue = requiredElement<HTMLElement>("#score-value");
const combatHint = requiredElement<HTMLElement>("#combat-hint");
const chatForm = requiredElement<HTMLFormElement>("#chat-form");
const chatInput = requiredElement<HTMLInputElement>("#chat-message");
const chatLog = requiredElement<HTMLUListElement>("#chat-log");
const netRtt = requiredElement<HTMLElement>("#net-rtt");
const netSnapshotAge = requiredElement<HTMLElement>("#net-snapshot-age");
const netBytes = requiredElement<HTMLElement>("#net-bytes");
const netInputQueue = requiredElement<HTMLElement>("#net-input-queue");
const netCorrection = requiredElement<HTMLElement>("#net-correction");
const networkProtocol = requiredElement<HTMLElement>("#network-protocol");
const stepsMetric = requiredElement<HTMLElement>("#steps-metric");
const framesMetric = requiredElement<HTMLElement>("#frames-metric");
const frameTimeMetric = requiredElement<HTMLElement>("#frame-time-metric");
const blockButton = requiredElement<HTMLButtonElement>("#block-button");

const lobby = new Lobby();
const lobbyUI = bindLobbyDom(lobby, startGame);
let progress: ReturnType<typeof createLoadingProgress> | null = null;
let loadingController: AbortController | null = null;
let audio: AudioSystem | null = null;
let world: World | null = null;
let input: ReturnType<typeof createInput> | null = null;
let renderer: ReturnType<typeof createRenderer> | null = null;
let network: GameConnection | null = null;
let loop: ReturnType<typeof createLoop> | null = null;
let localId: EntityId | null = null;
let currentRoom: RoomInfo | null = null;
let currentName = "";
let assets: Map<string, unknown> | null = null;
let predictor: ClientPrediction | null = null;
let inputAccumulator = 0;
let inputSequence: InputSequence = asInputSequence(0);
let rtt: number | null = null;
let snapshotAge: number | null = null;
let lastSnapshotTick: SimulationStep | null = null;
let correction = 0;
let trafficBytes = 0;
let trafficElapsed = 0;
const snapshotFrames: SnapshotFrame[] = [];
const roster = new Map<EntityId, RoomPlayer>();
const playerByIndex = new Map<number, EntityId>();
const sentInputs = new Map<InputSequence, number>();

async function startGame({ name, room }: LobbyJoinDetails): Promise<void> {
  currentName = name;
  currentRoom = room;
  gameShell.hidden = false;
  gameLayout.hidden = true;
  assetLoading.hidden = false;
  lobbyUI.showLoading();
  retryButton.hidden = true;
  if (!progress) progress = createLoadingProgress(loadingCanvas);
  await loadGameAssets();
}

async function loadGameAssets(): Promise<void> {
  loadingController?.abort();
  loadingController = new AbortController();
  const { signal } = loadingController;
  assetStatus.textContent = "Підготовка аудіо та ассетів…";
  retryButton.hidden = true;
  progress?.draw({ completed: 0, total: 1 });
  try {
    audio ??= new AudioSystem(createGameEvents());
    await audio.resume();
    const manifest = AssetManifestSchema.parse(
      await loadJson("/assets/manifest.json", { signal }),
    );
    progress?.draw({
      completed: 0,
      total: manifest.assets.length,
      status: "loading",
    });
    assets = await loadAll(manifest, {
      signal,
      audioContext: audio.context,
      onProgress(update) {
        progress?.draw(update);
        if (update.status === "loaded") {
          assetStatus.textContent = `Завантажено ${update.key} · ${update.completed}/${update.total}`;
        }
      },
    });
    audio.setBuffers(assets);
    startArena();
  } catch (error: unknown) {
    if (signal.aborted) return;
    showAssetError(error);
  }
}

function showAssetError(error: unknown): void {
  assetStatus.textContent = `Не вдалося завантажити гру: ${errorMessage(error)}`;
  retryButton.hidden = false;
  progress?.draw({ completed: 0, total: 1, status: "error", key: "load" });
}

function startArena(): void {
  const room = currentRoom;
  const sound = audio;
  const loadedAssets = assets;
  if (!room || !sound || !loadedAssets) {
    throw new Error(
      "Cannot start the arena before lobby and assets are ready.",
    );
  }
  world = createArenaWorld(room, sound.events);
  input = createInput();
  localId = null;
  roomLabel.textContent = `ROOM ${room.id}`;
  assetLoading.hidden = true;
  gameLayout.hidden = false;
  renderer = createRenderer(canvas, loadedAssets);
  network = connect({
    roomId: room.id,
    name: currentName,
    onMessage: handleServerMessage,
    onStatus: updateConnection,
    onTraffic(_direction: TrafficDirection, bytes: number) {
      trafficBytes += bytes;
    },
  });
  networkProtocol.textContent = `${network.protocol.toUpperCase()} · ${network.predictionEnabled ? "PREDICT" : "SNAPSHOT"}`;
  loop = createLoop({
    update,
    render,
    onMetrics(metrics) {
      stepsMetric.innerHTML = `${metrics.stepsPerSecond}<small> steps/s</small>`;
      framesMetric.innerHTML = `${metrics.framesPerSecond}<small> frames/s</small>`;
      frameTimeMetric.innerHTML = `${metrics.frameTime}<small> ms</small>`;
    },
  });
  loop.start();
}

function handleServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case "welcome": {
      const currentWorld = requireWorld();
      if (localId && currentWorld.get(localId)) currentWorld.despawn(localId);
      currentWorld.sweep();
      localId = message.playerId;
      currentRoom = message.room;
      playerByIndex.clear();
      roster.clear();
      for (const player of message.players) {
        roster.set(player.id, player);
        playerByIndex.set(player.index, player.id);
      }
      if (message.state) {
        const state: PredictedState = {
          ...message.state,
          color: colorForIndex(message.state.index),
        };
        const ship = currentWorld.spawn(
          new Ship({
            id: localId,
            position: new Vector2(state.x, state.y),
            velocity: new Vector2(state.vx, state.vy),
            angle: state.angle,
            hp: state.hp,
            score: state.score,
            color: state.color,
            local: true,
          }),
        );
        predictor = new ClientPrediction(state);
        inputSequence = asInputSequence(0);
        lastSnapshotTick = null;
        sentInputs.clear();
        syncShip(ship, state);
      }
      updateRoster();
      roomLabel.textContent = `ROOM ${message.roomId}`;
      return;
    }
    case "room":
      if (message.action === "join") {
        roster.set(message.player.id, message.player);
        playerByIndex.set(message.player.index, message.player.id);
      } else {
        roster.delete(message.player.id);
        playerByIndex.delete(message.player.index);
      }
      updateRoster();
      return;
    case "chat":
      appendChat(message);
      return;
    case "state":
      handleSnapshot(message);
      return;
    case "left":
      updateConnection("disconnected");
      return;
    case "shutdown":
      returnToLobby(message.reason);
      return;
    default:
      assertNever(message);
  }
}

function returnToLobby(reason = "Сервер перезапускається."): void {
  loop?.stop();
  input?.destroy();
  input = null;
  network?.close();
  network = null;
  gameShell.hidden = true;
  gameLayout.hidden = true;
  updateConnection("disconnected", { reason });
  lobbyUI.showLobby();
}

function updateConnection(
  nextStatus: ConnectionStatus,
  detail?: { readonly reason?: string },
): void {
  connection.dataset.state = nextStatus;
  const messages: Record<ConnectionStatus, string> = {
    connected: "Сервер онлайн",
    connecting: "З’єднання…",
    "queue-full": "Черга повідомлень переповнена",
    disconnected: detail?.reason
      ? `Перепідключення… (${detail.reason})`
      : "Перепідключення…",
    error: "Помилка з’єднання",
  };
  connectionLabel.textContent = messages[nextStatus];
}

function updateRoster(): void {
  const players = [...roster.values()];
  playerCount.textContent = `${players.length} TANK${players.length === 1 ? "" : "S"}`;
  playerList.replaceChildren();
  if (players.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-roster";
    empty.textContent = "Очікуємо на гравців…";
    playerList.append(empty);
    return;
  }
  for (const player of players) {
    const item = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "player-swatch";
    swatch.style.backgroundColor = colorForIndex(player.index);
    const name = document.createElement("span");
    name.textContent = player.id === localId ? "ВИ" : player.name;
    const role = document.createElement("span");
    role.className = "player-role";
    role.textContent = player.id === localId ? "YOU" : "PLAYER";
    item.append(swatch, name, role);
    playerList.append(item);
  }
}

function handleSnapshot(snapshot: StateMessage): void {
  if (lastSnapshotTick !== null && snapshot.tick <= lastSnapshotTick) return;
  lastSnapshotTick = snapshot.tick;
  const receivedAt = performance.now();
  const age = (Date.now() - snapshot.serverTime) >>> 0;
  snapshotAge = age;
  const tanks = snapshot.tanks
    .map((tank): RenderTank | null => {
      const id = tank.id ?? playerByIndex.get(tank.index);
      if (!id) return null;
      return { ...tank, id, color: tank.color ?? colorForIndex(tank.index) };
    })
    .filter((tank): tank is RenderTank => tank !== null);
  const currentIds = new Set(tanks.map((tank) => tank.id));
  const currentWorld = requireWorld();

  for (const tankState of tanks) {
    const found = currentWorld.get(tankState.id);
    const ship =
      found instanceof Ship
        ? found
        : currentWorld.spawn(
            new Ship({
              id: tankState.id,
              position: new Vector2(tankState.x, tankState.y),
              velocity: new Vector2(tankState.vx, tankState.vy),
              angle: tankState.angle,
              hp: tankState.hp,
              score: tankState.score,
              color: tankState.color,
              local: tankState.id === localId,
            }),
          );
    if (tankState.id === localId && predictor && network?.predictionEnabled) {
      const sentAt = sentInputs.get(snapshot.ack);
      if (sentAt !== undefined) rtt = receivedAt - sentAt;
      for (const sequence of sentInputs.keys()) {
        if (sequence <= snapshot.ack) sentInputs.delete(sequence);
      }
      correction = predictor.reconcile(tankState, snapshot.ack);
      syncShip(ship, predictor.state);
    } else {
      syncShip(ship, tankState);
    }
  }

  for (const [id, entity] of currentWorld.entities) {
    switch (entity.kind) {
      case "entity":
      case "bullet":
      case "asteroid":
      case "pickup":
      case "particle":
        break;
      case "ship":
        if (id !== localId && !currentIds.has(id)) {
          currentWorld.despawn(id);
        }
        break;
      default:
        assertNever(entity.kind);
    }
  }

  updateSnapshotBullets(snapshot, tanks);
  snapshotFrames.push({ sampleTime: receivedAt - age, tanks });
  if (snapshotFrames.length > 12) snapshotFrames.shift();
}

function updateSnapshotBullets(
  snapshot: StateMessage,
  tanks: readonly RenderTank[],
): void {
  const currentWorld = requireWorld();
  const alive = new Set<string>();
  const predictedBySequence = new Map<number, EntityId>();
  for (const [entityId, entity] of currentWorld.entities) {
    if (
      entity instanceof Bullet &&
      entity.predicted &&
      entity.ownerId === localId &&
      entity.fireSeq !== undefined
    ) {
      predictedBySequence.set(entity.fireSeq, entityId);
    }
  }
  for (const data of snapshot.bullets) {
    const ownerId = data.ownerId ?? playerByIndex.get(data.ownerIndex);
    if (ownerId !== localId) continue;
    const predictedId = predictedBySequence.get(data.fireSeq);
    if (predictedId) currentWorld.despawn(predictedId);
  }
  currentWorld.sweep();

  for (const data of snapshot.bullets) {
    const ownerId = data.ownerId ?? playerByIndex.get(data.ownerIndex);
    if (!ownerId) continue;
    const ownerIndex = data.ownerIndex;
    const id = asEntityId(`server-bullet-${ownerIndex}-${data.id}`);
    alive.add(id);
    const existing = currentWorld.get(id);
    const bullet =
      existing instanceof Bullet
        ? existing
        : currentWorld.spawnBullet({
            id,
            position: new Vector2(data.x, data.y),
            velocity: new Vector2(data.vx, data.vy),
            ownerId,
            color:
              tanks.find((tank) => tank.id === ownerId)?.color ??
              colorForIndex(ownerIndex),
          });
    if (existing instanceof Bullet) {
      bullet.previousPosition.copy(bullet.position);
      bullet.position.set(data.x, data.y);
      bullet.velocity.set(data.vx, data.vy);
      bullet.color = data.homing ? "#c1e886" : colorForIndex(ownerIndex);
    }
    bullet.fireSeq = data.fireSeq;
    bullet.ownerIndex = ownerIndex;
  }

  for (const [id, entity] of currentWorld.entities) {
    switch (entity.kind) {
      case "entity":
      case "ship":
      case "asteroid":
      case "pickup":
      case "particle":
        break;
      case "bullet":
        if (entity instanceof Bullet) {
          if (
            entity.predicted &&
            entity.ownerId === localId &&
            entity.fireSeq !== undefined &&
            entity.fireSeq <= snapshot.ack
          ) {
            currentWorld.despawn(id);
          } else if (
            !entity.predicted &&
            id.startsWith("server-bullet-") &&
            !alive.has(id)
          ) {
            currentWorld.despawn(id);
          }
        }
        break;
      default:
        assertNever(entity.kind);
    }
  }
}

function applyRemoteInterpolation(): void {
  const oldest = snapshotFrames[0];
  const newest = snapshotFrames[snapshotFrames.length - 1];
  if (!oldest || !newest) return;
  const targetTime = performance.now() - 100;
  let older = oldest;
  let newer = newest;
  for (let index = 1; index < snapshotFrames.length; index += 1) {
    const previous = snapshotFrames[index - 1];
    const current = snapshotFrames[index];
    if (previous && current && current.sampleTime >= targetTime) {
      older = previous;
      newer = current;
      break;
    }
  }
  const span = newer.sampleTime - older.sampleTime;
  const alpha =
    span > 0
      ? Math.max(0, Math.min(1, (targetTime - older.sampleTime) / span))
      : 1;
  for (const next of newer.tanks) {
    if (next.id === localId) continue;
    const ship = requireWorld().get(next.id);
    if (!(ship instanceof Ship)) continue;
    let previous = next;
    for (const candidate of older.tanks) {
      if (candidate.id === next.id) {
        previous = candidate;
        break;
      }
    }
    ship.position.set(
      wrap(previous.x + wrappedDelta(next.x - previous.x, 960) * alpha, 960),
      wrap(previous.y + wrappedDelta(next.y - previous.y, 600) * alpha, 600),
    );
    ship.angle =
      previous.angle + shortestAngle(next.angle - previous.angle) * alpha;
  }
}

function syncShip(ship: Ship, state: TankState): void {
  ship.previousPosition.copy(ship.position);
  ship.position.set(state.x, state.y);
  ship.velocity.set(state.vx, state.vy);
  ship.angle = state.angle;
  ship.score = state.score;
  if (state.hp < ship.hp) ship.takeDamage(ship.hp - state.hp);
  else if (state.hp > ship.hp) ship.heal(state.hp - ship.hp);
  ship.dead = state.hp <= 0;
}

function colorForIndex(index: number): string {
  return ["#c1e886", "#e7a96d", "#8bc6d8", "#cf9cdd"][index % 4] ?? "#c1e886";
}

function wrappedDelta(delta: number, size: number): number {
  return ((((delta + size / 2) % size) + size) % size) - size / 2;
}

function wrap(value: number, limit: number): number {
  return ((value % limit) + limit) % limit;
}

function shortestAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function update(dt: number): void {
  const currentWorld = world;
  const currentInput = input;
  if (!currentWorld || !currentInput) return;
  const localShip = localId ? currentWorld.get(localId) : undefined;
  if (localShip instanceof Ship) {
    localShip.fireCooldown = Math.max(0, localShip.fireCooldown - dt);
  }
  inputAccumulator += dt;
  while (inputAccumulator >= SERVER_DT) {
    inputAccumulator -= SERVER_DT;
    const controls = currentInput.read();
    inputSequence = asInputSequence((inputSequence + 1) >>> 0);
    if (predictor) predictor.sequence = inputSequence;
    const ship: Entity | undefined = localId
      ? currentWorld.get(localId)
      : undefined;
    if (ship instanceof Ship && predictor) {
      if (ship.hp > 0) {
        const sequence = network?.predictionEnabled
          ? predictor.step(controls, inputSequence)
          : inputSequence;
        if (network?.predictionEnabled) syncShip(ship, predictor.state);
        if (controls.fire && ship.fireCooldown <= 0) {
          const bullet = ship.fire(currentWorld, { homing: controls.homing });
          if (bullet) {
            bullet.predicted = true;
            bullet.fireSeq = sequence;
          }
        }
      }
    }
    sentInputs.set(inputSequence, performance.now());
    network?.sendInput(inputSequence, controls);
  }
  if (network?.predictionEnabled) predictor?.advance(dt);
  for (const entity of currentWorld.entities.values()) {
    switch (entity.kind) {
      case "entity":
      case "ship":
        break;
      case "asteroid":
      case "pickup":
      case "particle":
        entity.update(dt, currentWorld);
        break;
      case "bullet":
        if (entity instanceof Bullet && entity.predicted) {
          entity.update(dt, currentWorld);
        }
        break;
      default:
        assertNever(entity.kind);
    }
  }
  currentWorld.sweep();
  trafficElapsed += dt;
  if (trafficElapsed >= 0.5) {
    correction = predictor?.correctionMagnitude ?? 0;
    netRtt.textContent = rtt === null ? "—" : `${rtt.toFixed(0)} ms`;
    netSnapshotAge.textContent =
      snapshotAge === null ? "—" : `${snapshotAge.toFixed(0)} ms`;
    netBytes.textContent = `${Math.round(trafficBytes / trafficElapsed)} B/s`;
    netInputQueue.textContent = String(
      network?.predictionEnabled ? (predictor?.pendingCount ?? 0) : 0,
    );
    netCorrection.textContent = `${correction.toFixed(1)} px`;
    trafficBytes = 0;
    trafficElapsed = 0;
  }
  updateCombatHud();
}

function updateCombatHud(): void {
  const ship = localId ? world?.get(localId) : undefined;
  if (ship instanceof Ship) {
    hpValue.textContent = `${ship.hp} / 3`;
    scoreValue.textContent = String(ship.score);
    combatHint.textContent = "SPACE — ВОГОНЬ  ·  SHIFT + SPACE — HOMING";
  } else {
    hpValue.textContent = "— / 3";
    const respawn = localId ? world?.respawns.get(localId) : undefined;
    scoreValue.textContent = String(respawn?.score ?? 0);
    combatHint.textContent = respawn
      ? `РЕСПАУН ЗА ${respawn.remaining.toFixed(1)} S`
      : "ОЧІКУЄМО НА СЕРВЕР";
  }
}

function render(alpha: number): void {
  applyRemoteInterpolation();
  const currentWorld = world;
  const currentRenderer = renderer;
  if (!currentWorld || !currentRenderer) return;
  const ship = localId ? currentWorld.get(localId) : undefined;
  if (ship instanceof Ship && predictor && network?.predictionEnabled) {
    const state = predictor.visualState;
    ship.position.set(state.x, state.y);
    ship.angle = state.angle;
  }
  currentRenderer.draw(currentWorld.entities.values(), localId, alpha);
}

modeSelect.addEventListener("change", () => {
  const mode = parseLoopMode(modeSelect.value);
  loop?.setMode(mode);
  const messages: Record<LoopMode, string> = {
    raf: "requestAnimationFrame синхронізує рендер із оновленням екрана.",
    interval:
      "setInterval не синхронізований із екраном: порівняй frames/s і frame time.",
    variable: "Змінний dt: один довгий кадр робить один великий крок фізики.",
  };
  experimentResult.textContent = messages[mode];
});

blockButton.addEventListener("click", () => {
  loop?.blockNextFrame();
  experimentResult.textContent =
    "Наступний кадр блокує головний потік на 80 ms — приблизно 4,8 бюджети кадру по 16,67 ms.";
});

chatForm.addEventListener("submit", (event: SubmitEvent) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !network) return;
  network.send({ type: "chat", text });
  chatInput.value = "";
});

function appendChat(message: Extract<ServerMessage, { type: "chat" }>): void {
  if (chatLog.querySelector(".chat-empty")) chatLog.replaceChildren();
  const item = document.createElement("li");
  const name = document.createElement("span");
  name.className = "chat-name";
  name.textContent = `${message.name}: `;
  const text = document.createTextNode(message.text);
  item.append(name, text);
  chatLog.append(item);
  while (chatLog.childElementCount > 80) {
    const oldest = chatLog.firstElementChild;
    if (oldest) chatLog.removeChild(oldest);
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

retryButton.addEventListener("click", () => void loadGameAssets());
backButton.addEventListener("click", () => {
  loadingController?.abort();
  gameShell.hidden = true;
  lobbyUI.showLobby();
});
window.addEventListener("beforeunload", () => {
  loadingController?.abort();
  lobbyUI.destroy();
  input?.destroy();
  renderer?.destroy();
  network?.close();
  progress?.destroy();
  if (audio) void audio.destroy();
});

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
    console.warn("Could not register the Tank Arena service worker:", error);
  });
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing page element: ${selector}`);
  return element;
}

function requireWorld(): World {
  if (!world) throw new Error("Game world has not been initialized.");
  return world;
}

function parseLoopMode(value: string): LoopMode {
  switch (value) {
    case "raf":
    case "interval":
    case "variable":
      return value;
    default:
      throw new RangeError(`Unknown loop mode: ${value}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled game message or entity: ${JSON.stringify(value)}`);
}
