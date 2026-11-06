import type { GameEventMap } from "./game-events.js";

export class AudioSystem {
  readonly context: AudioContext;
  readonly events: EventTarget;
  readonly onFired: EventListener;
  readonly onHit: EventListener;
  readonly onExploded: EventListener;
  buffers = new Map<string, AudioBuffer>();

  constructor(events: EventTarget) {
    this.context = new AudioContext();
    this.onFired = () => this.play("shot", 0.26);
    this.onHit = () => this.play("hit", 0.42);
    this.onExploded = () => this.play("explosion", 0.55);
    events.addEventListener("fired", this.onFired);
    events.addEventListener("hit", this.onHit);
    events.addEventListener("exploded", this.onExploded);
    this.events = events;
  }

  resume() {
    return this.context.resume();
  }

  setBuffers(buffers: ReadonlyMap<string, unknown>): void {
    const audioBuffers = new Map<string, AudioBuffer>();
    for (const [name, buffer] of buffers) {
      if (buffer instanceof AudioBuffer) audioBuffers.set(name, buffer);
    }
    this.buffers = audioBuffers;
  }

  play(
    name: keyof GameEventMap | "shot" | "hit" | "explosion",
    volume = 0.4,
  ): void {
    const buffer = this.buffers.get(name);
    if (!buffer || this.context.state !== "running") return;
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = buffer;
    gain.gain.value = volume;
    source.connect(gain).connect(this.context.destination);
    source.start();
  }

  destroy(): Promise<void> {
    this.events.removeEventListener("fired", this.onFired);
    this.events.removeEventListener("hit", this.onHit);
    this.events.removeEventListener("exploded", this.onExploded);
    return this.context.close();
  }
}
