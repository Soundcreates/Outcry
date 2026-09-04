import { schema, t, type SchemaType } from "@colyseus/schema";

export const PlayerState = schema(
  {
    userId: t.string(),
    x: t.number(),
    y: t.number(),
    facing: t.string(),
    mode: t.string(),
    pitId: t.string(),
    seatIndex: t.number(),
    lastProcessedSeq: t.number(),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const SeatState = schema(
  {
    pitId: t.string(),
    seatIndex: t.number(),
    x: t.number(),
    y: t.number(),
    facing: t.string(),
    status: t.string(),
    holderSessionId: t.string(),
    leaseId: t.string(),
    leaseExpiresAt: t.number(),
  },
  "SeatState",
);
export type SeatState = SchemaType<typeof SeatState>;

export const PitState = schema(
  {
    pitId: t.string(),
    x: t.number(),
    y: t.number(),
    width: t.number(),
    height: t.number(),
    capacity: t.number(),
    interactionRadius: t.number(),
    minPlayers: t.number(),
    activeMatchId: t.string(),
    seats: t.map(SeatState),
  },
  "PitState",
);
export type PitState = SchemaType<typeof PitState>;

export const WorldState = schema(
  { players: t.map(PlayerState), pits: t.map(PitState) },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
