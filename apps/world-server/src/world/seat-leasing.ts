import type { SeatStatus } from "@outcry/shared/domain";
import type { PitDefinition, SeatDefinition } from "./geometry";

export const SEAT_LEASE_TTL_MS = 10_000;

export type SeatLease = {
  pitId: string;
  seatIndex: number;
  x: number;
  y: number;
  facing: string;
  status: SeatStatus;
  holderSessionId: string;
  leaseId: string;
  leaseExpiresAt: number;
};

export type SeatActionResult =
  | { accepted: true; action: "reserved" | "confirming" | "confirmed"; seat: SeatLease }
  | { accepted: false; reason: string };

const keyOf = (pitId: string, seatIndex: number) => `${pitId}:${seatIndex}`;

export function parseSeatRequest(payload: unknown): { pitId: string; seatIndex: number } | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "pitId" && key !== "seatIndex")) return null;
  if (
    typeof value.pitId !== "string" ||
    value.pitId.length === 0 ||
    !Number.isSafeInteger(value.seatIndex) ||
    (value.seatIndex as number) < 0
  ) return null;
  return { pitId: value.pitId, seatIndex: value.seatIndex as number };
}

export function parseSeatConfirmation(payload: unknown): { confirmed: boolean } | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  return Object.keys(value).length === 1 && typeof value.confirmed === "boolean"
    ? { confirmed: value.confirmed }
    : null;
}

export class SeatLeaseManager {
  private readonly pits = new Map<string, PitDefinition>();
  private readonly seats = new Map<string, SeatLease>();
  private readonly sessionSeats = new Map<string, string>();
  private leaseSequence = 0;

  constructor(
    pits: readonly PitDefinition[],
    seats: readonly SeatDefinition[],
    private readonly now: () => number = Date.now,
    private readonly ttlMs = SEAT_LEASE_TTL_MS,
  ) {
    for (const pit of pits) this.pits.set(pit.pitId, pit);
    for (const seat of seats) {
      this.seats.set(keyOf(seat.pitId, seat.seatIndex), {
        ...seat,
        status: "FREE",
        holderSessionId: "",
        leaseId: "",
        leaseExpiresAt: 0,
      });
    }
  }

  reserve(sessionId: string, pitId: string, seatIndex: number, x: number, y: number): SeatActionResult {
    this.expire();
    const pit = this.pits.get(pitId);
    const key = keyOf(pitId, seatIndex);
    const seat = this.seats.get(key);
    if (!pit || !seat) return { accepted: false, reason: "unknown_seat" };
    if (this.sessionSeats.has(sessionId)) return { accepted: false, reason: "player_already_seated" };
    if (seat.status !== "FREE") return { accepted: false, reason: "seat_unavailable" };
    if (Math.hypot(x - seat.x, y - seat.y) > pit.interactionRadius) {
      return { accepted: false, reason: "too_far_from_seat" };
    }

    seat.status = "RESERVED";
    seat.holderSessionId = sessionId;
    seat.leaseId = `${sessionId}:${++this.leaseSequence}`;
    seat.leaseExpiresAt = this.now() + this.ttlMs;
    this.sessionSeats.set(sessionId, key);
    return { accepted: true, action: "reserved", seat: { ...seat } };
  }

  beginConfirmation(sessionId: string): SeatActionResult {
    const seat = this.seatFor(sessionId);
    if (!seat) return { accepted: false, reason: "no_active_seat" };
    if (seat.status !== "RESERVED") return { accepted: false, reason: "invalid_confirmation_state" };
    seat.status = "CONFIRMING";
    return { accepted: true, action: "confirming", seat: { ...seat } };
  }

  confirm(sessionId: string): SeatActionResult {
    this.expire();
    const seat = this.seatFor(sessionId);
    if (!seat) return { accepted: false, reason: "no_active_seat" };
    if (seat.status !== "CONFIRMING") return { accepted: false, reason: "invalid_confirmation_state" };
    seat.status = "CONFIRMED";
    seat.leaseExpiresAt = 0;
    return { accepted: true, action: "confirmed", seat: { ...seat } };
  }

  releaseSession(sessionId: string): SeatLease[] {
    const key = this.sessionSeats.get(sessionId);
    if (!key) return [];
    const seat = this.seats.get(key);
    this.sessionSeats.delete(sessionId);
    if (!seat) return [];
    const released = { ...seat };
    seat.status = "FREE";
    seat.holderSessionId = "";
    seat.leaseId = "";
    seat.leaseExpiresAt = 0;
    return [released];
  }

  expire(): SeatLease[] {
    const expired: SeatLease[] = [];
    const timestamp = this.now();
    for (const [key, seat] of this.seats) {
      if (
        (seat.status === "RESERVED" || seat.status === "CONFIRMING") &&
        seat.leaseExpiresAt > 0 &&
        seat.leaseExpiresAt <= timestamp
      ) {
        expired.push({ ...seat });
        this.seats.delete(key);
        this.sessionSeats.delete(seat.holderSessionId);
        this.seats.set(key, {
          ...seat,
          status: "FREE",
          holderSessionId: "",
          leaseId: "",
          leaseExpiresAt: 0,
        });
      }
    }
    return expired;
  }

  get(pitId: string, seatIndex: number) {
    const seat = this.seats.get(keyOf(pitId, seatIndex));
    return seat ? { ...seat } : undefined;
  }

  private seatFor(sessionId: string) {
    const key = this.sessionSeats.get(sessionId);
    return key ? this.seats.get(key) : undefined;
  }
}
