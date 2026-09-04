export type WorldId = string;
export type PitId = string;
export type MatchId = string;
export type SeatIndex = 0 | 1 | 2 | 3;

export type AppMode = "WORLD" | "SEAT_CONFIRM" | "PIT";
export type PlayerMode = "WALKING" | "RECONNECTING" | "SEATED";
export type Facing = "down" | "left" | "right" | "up";
export type SeatStatus = "FREE" | "RESERVED" | "CONFIRMING" | "CONFIRMED" | "IN_MATCH";

export type MovementInput = {
  seq: number;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  dtMs: number;
};

export const MAX_WORLD_SPEED = 150;
export const MAX_INPUT_DT_MS = 50;

export const SEAT_INDICES: readonly SeatIndex[] = [0, 1, 2, 3];
