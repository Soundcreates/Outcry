import {
  MAX_INPUT_DT_MS,
  type MovementInput,
} from "@outcry/shared/domain";
import { applyMovement, WORLD_PLAYER_HEIGHT, WORLD_PLAYER_WIDTH } from "@outcry/shared/movement";
import type { WorldGeometry } from "./geometry";

export const PLAYER_WIDTH = WORLD_PLAYER_WIDTH;
export const PLAYER_HEIGHT = WORLD_PLAYER_HEIGHT;

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
  input: Pick<MovementInput, "seq" | "left" | "right" | "up" | "down"> & Partial<Pick<MovementInput, "dtMs">>,
  geometry: WorldGeometry,
  dtMs = input.dtMs ?? MAX_INPUT_DT_MS,
) {
  player.lastProcessedSeq = input.seq;
  applyMovement(player, input, geometry, dtMs);
}
