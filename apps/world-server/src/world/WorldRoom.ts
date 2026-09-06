import { Room, type Client } from "colyseus";
import { type MovementInput } from "@outcry/shared/domain";
import { readServerEnv } from "@outcry/shared/env";
import { createMatchMembershipReader, type MatchMembershipReader } from "../chain/match-membership";
import { loadWorldGeometry, type WorldGeometry } from "./geometry";
import { PLAYER_HEIGHT, PLAYER_WIDTH, parseMovementInput, simulatePlayer } from "./simulation";
import { PitState, PlayerState, SeatState, WorldState } from "./WorldState";
import {
  parseSeatRequest,
  parseSeatConfirmation,
  parseSeatReconciliation,
  SeatLeaseManager,
  type SeatActionResult,
  type SeatLease,
} from "./seat-leasing";

const TICK_RATE_HZ = 20;
const TICK_DT_MS = 1000 / TICK_RATE_HZ;
const MAX_INPUTS_PER_TICK = 8;
const MAX_PENDING_INPUTS = 32;

export class WorldRoom extends Room<{ state: WorldState }> {
  // ponytail: process-local presence count; use shared storage when the server is horizontally scaled.
  private static readonly activeSessions = new Set<string>();
  private static readonly seatedSessions = new Map<string, { pitId: string; seatIndex: number }>();
  private static readonly knownPitIds = new Set(["wall-street-01", "wall-street-02"]);
  private geometry!: WorldGeometry;
  private seating!: SeatLeaseManager;
  private membershipReader?: MatchMembershipReader;
  private activeMatchAddress = "";
  private readonly pendingInputs = new Map<string, MovementInput[]>();

  async onCreate(options: { worldId?: string } = {}) {
    if (options.worldId && options.worldId !== "wall-street") {
      throw new Error("unknown_world");
    }
    this.geometry = await loadWorldGeometry();
    this.seating = new SeatLeaseManager(this.geometry.pits, this.geometry.seats);
    const env = readServerEnv();
    this.activeMatchAddress = env.OUTCRY_MATCH_ADDRESS ?? "";
    this.membershipReader = createMatchMembershipReader({
      rpcUrl: env.OUTCRY_BASE_RPC,
      programId: env.OUTCRY_PROGRAM_ID,
    });
    this.setState(new WorldState());
    this.initializePitState();
    this.onMessage("input", (client, payload) => this.enqueueInput(client, payload));
    this.onMessage("interact", (client, payload) => void this.interact(client, payload));
    this.onMessage("beginConfirm", (client) => this.beginConfirmation(client));
    this.onMessage("confirmSeat", (client, payload) => void this.confirmSeat(client, payload));
    this.onMessage("reconcileSeat", (client, payload) => void this.reconcileSeat(client, payload));
    this.onMessage("releaseSeat", (client) => this.releaseSeat(client));
    this.setSimulationInterval(() => this.simulate(), TICK_DT_MS);
  }

  onJoin(client: Client, options: { userId?: string } = {}) {
    const player = new PlayerState();
    player.userId = typeof options?.userId === "string" && options.userId.length > 0
      ? options.userId
      : client.sessionId;
    player.x = this.geometry.spawn.x;
    player.y = this.geometry.spawn.y;
    player.facing = "down";
    player.mode = "WALKING";
    player.pitId = "";
    player.seatIndex = -1;
    player.lastProcessedSeq = -1;
    this.state.players.set(client.sessionId, player);
    this.pendingInputs.set(client.sessionId, []);
    WorldRoom.activeSessions.add(client.sessionId);
  }

  onDrop(client: Client) {
    const player = this.state.players.get(client.sessionId);
    const previousMode = player?.mode;
    if (player) player.mode = "RECONNECTING";
    this.allowReconnection(client, 5)
      .then(() => {
        const restored = this.state.players.get(client.sessionId);
        if (restored) restored.mode = previousMode === "SEATED" ? "SEATED" : "WALKING";
      })
      .catch(() => this.removePlayer(client.sessionId));
  }

  onLeave(client: Client) {
    this.removePlayer(client.sessionId);
  }

  private enqueueInput(client: Client, payload: unknown) {
    const input = parseMovementInput(payload);
    const queue = this.pendingInputs.get(client.sessionId);
    if (!input || !queue) return;
    if (queue.length >= MAX_PENDING_INPUTS) queue.shift();
    queue.push(input);
  }

  private simulate() {
    this.expireLeases();
    for (const [sessionId, queue] of this.pendingInputs) {
      const player = this.state.players.get(sessionId);
      if (!player) continue;
      let budget = TICK_DT_MS;
      let processed = 0;
      while (queue.length > 0 && processed < MAX_INPUTS_PER_TICK && budget > 0) {
        const input = queue.shift();
        if (!input) break;
        const dtMs = Math.min(input.dtMs, budget);
        simulatePlayer(player, input, this.geometry, dtMs);
        budget -= dtMs;
        processed += 1;
      }
    }
  }

  private removePlayer(sessionId: string) {
    for (const released of this.seating.releaseSession(sessionId)) {
      this.syncSeat(this.seating.get(released.pitId, released.seatIndex));
    }
    this.state.players.delete(sessionId);
    this.pendingInputs.delete(sessionId);
    WorldRoom.activeSessions.delete(sessionId);
    WorldRoom.seatedSessions.delete(sessionId);
  }

  static onlineCount() {
    return WorldRoom.activeSessions.size;
  }

  static isActiveSession(sessionId: string) {
    return WorldRoom.activeSessions.has(sessionId);
  }

  static isKnownPitId(pitId: string) {
    return WorldRoom.knownPitIds.has(pitId);
  }

  static canJoinMedia(sessionId: string, pitId: string) {
    return WorldRoom.seatedSessions.get(sessionId)?.pitId === pitId;
  }

  private initializePitState() {
    for (const pit of this.geometry.pits) {
      const state = new PitState();
      state.pitId = pit.pitId;
      state.x = pit.x;
      state.y = pit.y;
      state.width = pit.width;
      state.height = pit.height;
      state.capacity = pit.capacity;
      state.interactionRadius = pit.interactionRadius;
      state.minPlayers = pit.minPlayers;
      state.activeMatchId = pit.pitId === "wall-street-01" ? this.activeMatchAddress : "";
      for (const seat of this.geometry.seats.filter(({ pitId }) => pitId === pit.pitId)) {
        const seatState = new SeatState();
        seatState.pitId = seat.pitId;
        seatState.seatIndex = seat.seatIndex;
        seatState.x = seat.x;
        seatState.y = seat.y;
        seatState.facing = seat.facing;
        seatState.status = "FREE";
        seatState.holderSessionId = "";
        seatState.leaseId = "";
        seatState.leaseExpiresAt = 0;
        state.seats.set(String(seat.seatIndex), seatState);
      }
      this.state.pits.set(pit.pitId, state);
    }
  }

  private async interact(client: Client, payload: unknown) {
    const request = parseSeatRequest(payload);
    const player = this.state.players.get(client.sessionId);
    if (!request || !player || player.mode !== "WALKING") {
      this.sendSeatResult(client, { accepted: false, reason: "player_not_walking" });
      return;
    }
    if (request.pitId === "wall-street-01" && !this.activeMatchAddress) {
      this.sendSeatResult(client, { accepted: false, reason: "chain_match_unavailable" });
      return;
    }
    const result = this.seating.reserve(
      client.sessionId,
      request.pitId,
      request.seatIndex,
      player.x,
      player.y,
    );
    if (result.accepted) this.seatPlayer(client.sessionId, player, result.seat);
    this.sendSeatResult(client, result);
  }

  private async confirmSeat(client: Client, payload: unknown) {
    const confirmation = parseSeatConfirmation(payload);
    if (!confirmation) {
      this.sendSeatResult(client, { accepted: false, reason: "invalid_confirmation" });
      return;
    }
    if (!confirmation.confirmed) {
      this.releaseSeat(client);
      return;
    }

    const seat = this.seating.getForSession(client.sessionId);
    if (!seat || !confirmation.matchAddress || !confirmation.walletAddress || !this.membershipReader) {
      this.releaseSeat(client);
      this.sendSeatResult(client, { accepted: false, reason: "chain_confirmation_unavailable" });
      return;
    }
    if (confirmation.matchAddress !== this.activeMatchAddress || seat.pitId !== "wall-street-01") {
      this.releaseSeat(client);
      this.sendSeatResult(client, { accepted: false, reason: "chain_match_mismatch" });
      return;
    }

    const isMember = await this.membershipReader.isConfirmed({
      matchAddress: confirmation.matchAddress,
      walletAddress: confirmation.walletAddress,
      seatIndex: seat.seatIndex,
    });
    if (!isMember) {
      this.releaseSeat(client);
      this.sendSeatResult(client, { accepted: false, reason: "chain_membership_not_found" });
      return;
    }

    if (seat.status === "RESERVED") this.seating.beginConfirmation(client.sessionId);
    const result = this.seating.confirm(client.sessionId);
    if (result.accepted) {
      const player = this.state.players.get(client.sessionId);
      if (player) player.mode = "SEATED";
      this.syncSeat(result.seat);
    }
    this.sendSeatResult(client, result);
  }

  private async reconcileSeat(client: Client, payload: unknown) {
    const identity = parseSeatReconciliation(payload);
    const player = this.state.players.get(client.sessionId);
    const currentSeat = this.seating.getForSession(client.sessionId);
    const canRebindReservedSeat = Boolean(currentSeat && currentSeat.status === "RESERVED" && player?.mode === "SEATED");
    if (!identity || !player || (player.mode !== "WALKING" && !canRebindReservedSeat)) {
      this.sendSeatResult(client, { accepted: false, reason: "invalid_reconciliation" });
      return;
    }
    const pit = this.geometry.pits.find(({ pitId }) => pitId === "wall-street-01");
    if (
      !pit ||
      identity.matchAddress !== this.activeMatchAddress ||
      !this.membershipReader
    ) {
      this.sendSeatResult(client, { accepted: false, reason: "chain_reconciliation_unavailable" });
      return;
    }
    if (canRebindReservedSeat && currentSeat) {
      const releasedSeats = this.seating.releaseSession(client.sessionId);
      for (const released of releasedSeats) this.syncSeat(this.seating.get(released.pitId, released.seatIndex));
      this.clearSeatPlayer(player, currentSeat, client.sessionId);
    }

    const seatIndex = (await Promise.all(
      Array.from({ length: pit.capacity }, (_, index) => this.membershipReader!.isConfirmed({
        matchAddress: identity.matchAddress,
        walletAddress: identity.walletAddress,
        seatIndex: index,
      }).then((confirmed) => confirmed ? index : undefined)),
    )).find((index): index is number => index !== undefined);
    // Reconciliation is best-effort on world entry. A wallet that has not
    // joined this Match yet has no seat to restore; it can still walk to a
    // free seat and use the explicit wallet-join flow.
    if (seatIndex === undefined) return;

    const result = this.seating.restoreConfirmed(client.sessionId, pit.pitId, seatIndex);
    if (result.accepted) this.seatPlayer(client.sessionId, player, result.seat);
    this.sendSeatResult(client, result);
  }

  private beginConfirmation(client: Client) {
    const result = this.seating.beginConfirmation(client.sessionId);
    if (result.accepted) this.syncSeat(result.seat);
    this.sendSeatResult(client, result);
  }

  private releaseSeat(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    const releasedSeats = this.seating.releaseSession(client.sessionId);
    for (const released of releasedSeats) {
      this.syncSeat(this.seating.get(released.pitId, released.seatIndex));
    }
    this.clearSeatPlayer(player, releasedSeats[0], client.sessionId);
    this.sendSeatResult(client, { accepted: true, action: "released" });
  }

  private seatPlayer(sessionId: string, player: PlayerState, seat: SeatLease) {
    player.x = seat.x;
    player.y = seat.y;
    player.facing = seat.facing;
    player.mode = "SEATED";
    player.pitId = seat.pitId;
    player.seatIndex = seat.seatIndex;
    WorldRoom.seatedSessions.set(sessionId, { pitId: seat.pitId, seatIndex: seat.seatIndex });
    this.syncSeat(seat);
  }

  private clearSeatPlayer(player: PlayerState, seat?: SeatLease, sessionId?: string) {
    const exit = seat ? this.findSeatExit(seat) : undefined;
    if (exit) {
      player.x = exit.x;
      player.y = exit.y;
    }
    player.mode = "WALKING";
    player.pitId = "";
    player.seatIndex = -1;
    if (sessionId) WorldRoom.seatedSessions.delete(sessionId);
  }

  private findSeatExit(seat: SeatLease) {
    const clearance = Math.max(PLAYER_WIDTH, PLAYER_HEIGHT) / 2 + 10;
    const direction = seat.facing.toLowerCase();
    const offsets = direction === "south"
      ? [{ x: 0, y: -clearance }, { x: -clearance, y: 0 }, { x: clearance, y: 0 }]
      : direction === "north"
        ? [{ x: 0, y: clearance }, { x: -clearance, y: 0 }, { x: clearance, y: 0 }]
        : direction === "east"
          ? [{ x: -clearance, y: 0 }, { x: 0, y: -clearance }, { x: 0, y: clearance }]
          : [{ x: clearance, y: 0 }, { x: 0, y: -clearance }, { x: 0, y: clearance }];

    return offsets
      .map(({ x, y }) => ({ x: seat.x + x, y: seat.y + y }))
      .find(({ x, y }) => !this.geometry.collides(
        x - PLAYER_WIDTH / 2,
        y - PLAYER_HEIGHT / 2,
        PLAYER_WIDTH,
        PLAYER_HEIGHT,
      ));
  }

  private expireLeases() {
    for (const expired of this.seating.expire()) {
      const player = this.state.players.get(expired.holderSessionId);
      if (player && player.pitId === expired.pitId && player.seatIndex === expired.seatIndex) {
        this.clearSeatPlayer(player, expired, expired.holderSessionId);
      }
      this.syncSeat(this.seating.get(expired.pitId, expired.seatIndex));
    }
  }

  private syncSeat(seat: SeatLease | undefined) {
    if (!seat) return;
    const pit = this.state.pits.get(seat.pitId);
    const state = pit?.seats.get(String(seat.seatIndex));
    if (!state) return;
    state.status = seat.status;
    state.holderSessionId = seat.holderSessionId;
    state.leaseId = seat.leaseId;
    state.leaseExpiresAt = seat.leaseExpiresAt;
  }

  private sendSeatResult(client: Client, result: SeatActionResult | { accepted: true; action: "released" }) {
    client.send("seat", result);
  }
}
