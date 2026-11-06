import { sanitizeInput } from "./physics.js";

type InputAction = "forward" | "backward" | "left" | "right" | "fire";

const KEY_MAP: Readonly<Record<string, InputAction | undefined>> = {
  KeyW: "forward",
  ArrowUp: "forward",
  KeyS: "backward",
  ArrowDown: "backward",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
  Space: "fire",
};

export function createInput(target: Window = window): {
  read(): ReturnType<typeof sanitizeInput>;
  destroy(): void;
} {
  const pressed = new Set<string>();
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
      pressed.add(event.code);
    }
    if (KEY_MAP[event.code]) {
      event.preventDefault();
      pressed.add(event.code);
    }
  };
  const onKeyUp = (event: KeyboardEvent) => pressed.delete(event.code);
  const onBlur = () => pressed.clear();

  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);
  target.addEventListener("blur", onBlur);

  return {
    read() {
      return sanitizeInput({
        forward: [...pressed].some((code) => KEY_MAP[code] === "forward"),
        backward: [...pressed].some((code) => KEY_MAP[code] === "backward"),
        left: [...pressed].some((code) => KEY_MAP[code] === "left"),
        right: [...pressed].some((code) => KEY_MAP[code] === "right"),
        fire: [...pressed].some((code) => KEY_MAP[code] === "fire"),
        homing:
          [...pressed].some((code) => KEY_MAP[code] === "fire") &&
          [...pressed].some((code) => code.startsWith("Shift")),
      });
    },
    destroy() {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
      target.removeEventListener("blur", onBlur);
      pressed.clear();
    },
  };
}
