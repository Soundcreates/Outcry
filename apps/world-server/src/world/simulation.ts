import {
  MAX_INPUT_DT_MS,
  MAX_WORLD_SPEED,
  type MovementInput,
} from "@outcry/shared/domain";
import type { WorldGeometry } from "./geometry";

export const PLAYER_WIDTH = 18;
export const PLAYER_HEIGHT = 24;

export type SimulatedPlayer = {
  x: number;
  y: number;
  facing: string;
  lastProcessedSeq: number;
  mode?: string;
};

const INPUT_KEYS = ["seq", "left", "right", "up", "down", "dtMs"];

export function parseMovementInput(payload: unknown): MovementInput | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (Object.keys(value).some((key) => !INPUT_KEYS.includes(key))) return null;
  if (
    !Number.isSafeInteger(value.seq) ||
    (value.seq as number) < 0 ||
    typeof value.left !== "boolean" ||
    typeof value.right !== "boolean" ||
    typeof value.up !== "boolean" ||
    typeof value.down !== "boolean" ||
    typeof value.dtMs !== "number" ||
    !Number.isFinite(value.dtMs) ||
    value.dtMs < 0
  ) return null;

  return value as MovementInput;
}

export function simulatePlayer(
  player: SimulatedPlayer,
  input: MovementInput,
  geometry: WorldGeometry,
  dtMs = Math.min(input.dtMs, MAX_INPUT_DT_MS),
) {
  player.lastProcessedSeq = input.seq;
  if (player.mode && player.mode !== "WALKING") return;
  let dx = Number(input.right) - Number(input.left);
  let dy = Number(input.down) - Number(input.up);
  const length = Math.hypot(dx, dy);
  if (length === 0) return;

  dx /= length;
  dy /= length;
  player.facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : (dy < 0 ? "up" : "down");
  const distance = MAX_WORLD_SPEED * Math.min(Math.max(dtMs, 0), MAX_INPUT_DT_MS) / 1000;
  const nextX = player.x + dx * distance;
  const nextY = player.y + dy * distance;

  if (!geometry.collides(nextX - PLAYER_WIDTH / 2, player.y - PLAYER_HEIGHT / 2, PLAYER_WIDTH, PLAYER_HEIGHT)) {
    player.x = nextX;
  }
  if (!geometry.collides(player.x - PLAYER_WIDTH / 2, nextY - PLAYER_HEIGHT / 2, PLAYER_WIDTH, PLAYER_HEIGHT)) {
    player.y = nextY;
  }
}
