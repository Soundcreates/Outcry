export type WorldId = string;
export type PitId = string;
export type MatchId = string;
export type SeatIndex = 0 | 1 | 2 | 3;

export type AppMode = "WORLD" | "SEAT_CONFIRM" | "PIT";

export const SEAT_INDICES: readonly SeatIndex[] = [0, 1, 2, 3];
