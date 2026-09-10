import type { SeatStatus } from "@outcry/shared/domain";
import type { PitDefinition, SeatDefinition } from "./geometry";

// Wallet confirmation can take longer than a normal interaction request.
// Keep the reservation long enough for one wallet attempt; failed attempts
// still release immediately through WorldRoom.confirmSeat.
export const SEAT_LEASE_TTL_MS = 60_000;

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
  | { accepted: true; action: "reserved" | "confirming" | "confirmed" | "restored"; seat: SeatLease }
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

export type SeatConfirmation = {
  confirmed: boolean;
  matchAddress?: string;
  walletAddress?: string;
};

export function parseSeatConfirmation(payload: unknown): SeatConfirmation | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (typeof value.confirmed !== "boolean") return null;
  if (Object.keys(value).length === 1) return { confirmed: value.confirmed };
  if (
    value.confirmed &&
    Object.keys(value).length === 3 &&
    typeof value.matchAddress === "string" &&
    value.matchAddress.length > 0 &&
    typeof value.walletAddress === "string" &&
    value.walletAddress.length > 0
  ) {
    return {
      confirmed: true,
      matchAddress: value.matchAddress,
      walletAddress: value.walletAddress,
    };
  }
  return null;
}

export function parseSeatReconciliation(payload: unknown): { matchAddress: string; walletAddress: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (
    Object.keys(value).length !== 2 ||
    typeof value.matchAddress !== "string" ||
    value.matchAddress.length === 0 ||
    typeof value.walletAddress !== "string" ||
    value.walletAddress.length === 0
  ) return null;
  return { matchAddress: value.matchAddress, walletAddress: value.walletAddress };
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
    if (seat.status !== "RESERVED" && seat.status !== "CONFIRMING") {
      return { accepted: false, reason: "invalid_confirmation_state" };
    }
    seat.status = "CONFIRMING";
    seat.leaseExpiresAt = this.now() + this.ttlMs;
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

  restoreConfirmed(sessionId: string, pitId: string, seatIndex: number): SeatActionResult {
    const pit = this.pits.get(pitId);
    const seat = this.seats.get(keyOf(pitId, seatIndex));
    if (!pit || !seat) return { accepted: false, reason: "unknown_seat" };
    if (this.sessionSeats.has(sessionId)) return { accepted: false, reason: "player_already_seated" };
    if (seat.status !== "FREE") return { accepted: false, reason: "seat_unavailable" };

    seat.status = "CONFIRMED";
    seat.holderSessionId = sessionId;
    seat.leaseId = `${sessionId}:restored:${++this.leaseSequence}`;
    seat.leaseExpiresAt = 0;
    this.sessionSeats.set(sessionId, keyOf(pitId, seatIndex));
    return { accepted: true, action: "restored", seat: { ...seat } };
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

  getForSession(sessionId: string) {
    const key = this.sessionSeats.get(sessionId);
    const seat = key ? this.seats.get(key) : undefined;
    return seat ? { ...seat } : undefined;
  }

  private seatFor(sessionId: string) {
    const key = this.sessionSeats.get(sessionId);
    return key ? this.seats.get(key) : undefined;
  }
}
