export type WorldId = string;
export type PitId = string;
export type MatchId = string;
export type SeatIndex = 0 | 1 | 2 | 3;

export type AppMode = "WORLD" | "SEAT_CONFIRM" | "PIT";
export type PlayerMode = "WALKING" | "RECONNECTING" | "RESERVING" | "SEATED";
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

export const MAX_CHAT_MESSAGE_LENGTH = 80;

export type ChatMessage = {
  text: string;
};

export function parseChatMessage(payload: unknown): ChatMessage | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (Object.keys(value).length !== 1 || typeof value.text !== "string") return null;
  const text = value.text.replace(/\s+/g, " ").trim();
  if (text.length === 0 || text.length > MAX_CHAT_MESSAGE_LENGTH) return null;
  return { text };
}

export const MAX_WORLD_SPEED = 150;
export const MAX_INPUT_DT_MS = 50;

export const SEAT_INDICES: readonly SeatIndex[] = [0, 1, 2, 3];
