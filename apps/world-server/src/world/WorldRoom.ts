import { Room, type Client, type StepContext } from "colyseus";
import { MAX_CHAT_MESSAGE_LENGTH, parseChatMessage } from "@outcry/shared/domain";
import { readServerEnv } from "@outcry/shared/env";
import { WorldMoveInput } from "@outcry/shared/world-input";
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
import { createSeatAssignmentStore, type SeatAssignmentStore } from "./seat-assignments";

const TICK_RATE_HZ = 20;
const ACTIVE_MATCH_REFRESH_MS = 5_000;
const RECONNECTION_GRACE_SECONDS = 30;
const CHAT_COOLDOWN_MS = 700;

export class WorldRoom extends Room<{ state: WorldState; input: WorldMoveInput }> {
  // ponytail: process-local presence count; use shared storage when the server is horizontally scaled.
  private static readonly activeSessions = new Set<string>();
  private static readonly seatedSessions = new Map<string, { pitId: string; seatIndex: number }>();
  private static seatAssignmentMode: "memory" | "redis" = "memory";
  private static readonly knownWorldIds = new Set([
    "wall-street",
    "tokyo-night",
    "shibuya-crossing",
    "kyoto-lanterns",
  ]);
  private static readonly knownPitIds = new Set([
    "wall-street-01",
    "wall-street-02",
    "tokyo-night-01",
    "tokyo-night-02",
    "shibuya-crossing-01",
    "shibuya-crossing-02",
    "kyoto-lanterns-01",
    "kyoto-lanterns-02",
  ]);
  private geometry!: WorldGeometry;
  private seating!: SeatLeaseManager;
  private seatAssignments!: SeatAssignmentStore;
  private membershipReader?: MatchMembershipReader;
  private readonly sessionIdentities = new Map<string, { matchAddress: string; walletAddress: string }>();
  private activeMatchAddress = "";
  private activeMatchReadAt = 0;
  private activeMatchRefresh?: Promise<void>;
  private readonly movementInputs = this.defineInput(WorldMoveInput, {
    seqField: "seq",
    bufferMaxSize: 64,
    idle: ({ latest }) => latest ?? true,
  });
  private readonly lastChatAt = new Map<string, number>();

  async onCreate(options: { worldId?: string } = {}) {
    const worldId = options.worldId ?? "wall-street";
    if (!WorldRoom.knownWorldIds.has(worldId)) {
      throw new Error("unknown_world");
    }
    this.geometry = await loadWorldGeometry(worldId);
    this.seating = new SeatLeaseManager(this.geometry.pits, this.geometry.seats);
    const env = readServerEnv();
    if (process.env.NODE_ENV === "production" && !env.OUTCRY_REDIS_URL) {
      throw new Error("redis_required_in_production");
    }
    this.seatAssignments = createSeatAssignmentStore(env.OUTCRY_REDIS_URL);
    WorldRoom.seatAssignmentMode = env.OUTCRY_REDIS_URL ? "redis" : "memory";
    // The pit PDA is authoritative. A configured address is only used by the
    // browser's bootstrap flow; retaining it here after a release resurrects
    // stale matches for newly connected players.
    this.activeMatchAddress = "";
    this.membershipReader = createMatchMembershipReader({
      rpcUrl: env.OUTCRY_BASE_RPC,
      programId: env.OUTCRY_PROGRAM_ID,
    });
    this.setState(new WorldState());
    await this.refreshActiveMatch(true);
    this.initializePitState();
    this.onMessage("chat", (client, payload) => this.handleChat(client, payload));
    this.onMessage("interact", (client, payload) => void this.interact(client, payload));
    this.onMessage("beginConfirm", (client) => this.beginConfirmation(client));
    this.onMessage("confirmSeat", (client, payload) => void this.confirmSeat(client, payload));
    this.onMessage("reconcileSeat", (client, payload) => void this.reconcileSeat(client, payload));
    this.onMessage("releaseSeat", (client) => void this.releaseSeat(client));
    this.setFixedTimestep((context) => this.simulate(context), TICK_RATE_HZ);
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
    WorldRoom.activeSessions.add(client.sessionId);
  }

  onDrop(client: Client) {
    const player = this.state.players.get(client.sessionId);
    const previousMode = player?.mode;
    if (player) player.mode = "RECONNECTING";
    this.allowReconnection(client, RECONNECTION_GRACE_SECONDS)
      .then(() => {
        const restored = this.state.players.get(client.sessionId);
        if (restored) restored.mode = previousMode === "SEATED" || previousMode === "RESERVING"
          ? previousMode
          : "WALKING";
      })
      .catch(() => this.removePlayer(client.sessionId));
  }

  onLeave(client: Client) {
    this.removePlayer(client.sessionId);
  }

  private handleChat(client: Client, payload: unknown) {
    const message = parseChatMessage(payload);
    if (!message || !this.state.players.has(client.sessionId)) return;
    const now = Date.now();
    const lastSentAt = this.lastChatAt.get(client.sessionId) ?? 0;
    if (now - lastSentAt < CHAT_COOLDOWN_MS) return;
    this.lastChatAt.set(client.sessionId, now);
    this.broadcast("chat", {
      sessionId: client.sessionId,
      text: message.text.slice(0, MAX_CHAT_MESSAGE_LENGTH),
    });
  }

  private simulate(context: StepContext) {
    this.expireLeases();
    void this.refreshActiveMatch();
    for (const [sessionId, player] of this.state.players) {
      const input = this.movementInputs.get(sessionId).next();
      if (input) simulatePlayer(player, input, this.geometry, context.dtMs);
    }
  }

  private removePlayer(sessionId: string) {
    for (const released of this.seating.releaseSession(sessionId)) {
      this.syncSeat(this.seating.get(released.pitId, released.seatIndex));
    }
    this.state.players.delete(sessionId);
    this.lastChatAt.delete(sessionId);
    WorldRoom.activeSessions.delete(sessionId);
    WorldRoom.seatedSessions.delete(sessionId);
    void this.clearDurableSeatAssignment(sessionId);
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

  static storageMode() {
    return WorldRoom.seatAssignmentMode;
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
    await this.refreshActiveMatch();
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
    if (result.accepted) this.reservePlayer(player, result.seat);
    this.sendSeatResult(client, result);
  }

  private async refreshActiveMatch(force = false) {
    if (!this.membershipReader || (!force && Date.now() - this.activeMatchReadAt < ACTIVE_MATCH_REFRESH_MS)) return;
    if (this.activeMatchRefresh) return this.activeMatchRefresh;

    this.activeMatchRefresh = this.membershipReader.readActiveMatch("wall-street-01")
      .then((matchAddress) => {
        this.activeMatchReadAt = Date.now();
        this.applyActiveMatch(matchAddress);
      })
      .catch(() => {
        this.activeMatchReadAt = Date.now();
        // Fail closed on a chain outage. The UI must not retain a released
        // match merely because the confirmation read failed.
        this.applyActiveMatch(undefined);
      })
      .finally(() => {
        this.activeMatchRefresh = undefined;
      });
    return this.activeMatchRefresh;
  }

  private applyActiveMatch(matchAddress: string | undefined) {
    const next = matchAddress ?? "";
    if (next === this.activeMatchAddress) return;
    this.activeMatchAddress = next;
    const pit = this.state.pits.get("wall-street-01");
    if (pit) pit.activeMatchId = next;

    // Physical seats may remain occupied, but media and reconnection identity
    // must be re-authorized for the current onchain match.
    for (const [sessionId, identity] of this.sessionIdentities) {
      if (identity.matchAddress === next) continue;
      this.sessionIdentities.delete(sessionId);
      WorldRoom.seatedSessions.delete(sessionId);
      void this.seatAssignments.delete(identity.matchAddress, identity.walletAddress);
    }
  }

  private async confirmSeat(client: Client, payload: unknown) {
    const confirmation = parseSeatConfirmation(payload);
    if (!confirmation) {
      this.sendSeatResult(client, { accepted: false, reason: "invalid_confirmation" });
      return;
    }
    if (!confirmation.confirmed) {
      await this.releaseSeat(client);
      return;
    }

    const seat = this.seating.getForSession(client.sessionId);
    if (!seat || !confirmation.matchAddress || !confirmation.walletAddress || !this.membershipReader) {
      this.releaseSeat(client);
      this.sendSeatResult(client, { accepted: false, reason: "chain_confirmation_unavailable" });
      return;
    }
    const matchChanged = confirmation.matchAddress !== this.activeMatchAddress;
    // Always validate the pit PDA. The cached address can lag after the host
    // releases a match and creates the next one.
    const activeOnchainMatch = seat.pitId === "wall-street-01"
      ? await this.membershipReader.isActiveMatch(seat.pitId, confirmation.matchAddress)
      : true;
    if (seat.pitId !== "wall-street-01" || !activeOnchainMatch) {
      this.releaseSeat(client);
      this.sendSeatResult(client, { accepted: false, reason: "chain_match_mismatch" });
      return;
    }

    const isMember = await this.membershipReader.isConfirmed({
      matchAddress: confirmation.matchAddress,
      walletAddress: confirmation.walletAddress,
    });
    if (!isMember) {
      this.releaseSeat(client);
      this.sendSeatResult(client, { accepted: false, reason: "chain_membership_not_found" });
      return;
    }

    if (matchChanged) {
      this.applyActiveMatch(confirmation.matchAddress);
    }

    if (seat.status === "RESERVED") this.seating.beginConfirmation(client.sessionId);
    const result = this.seating.confirm(client.sessionId);
    if (result.accepted) {
      const player = this.state.players.get(client.sessionId);
      if (player) {
        this.sessionIdentities.set(client.sessionId, {
          matchAddress: confirmation.matchAddress,
          walletAddress: confirmation.walletAddress,
        });
        void this.seatAssignments.set({
          matchAddress: confirmation.matchAddress,
          walletAddress: confirmation.walletAddress,
          pitId: result.seat.pitId,
          seatIndex: result.seat.seatIndex,
        });
        this.seatPlayer(client.sessionId, player, result.seat);
      }
    }
    this.sendSeatResult(client, result);
  }

  private async reconcileSeat(client: Client, payload: unknown) {
    const identity = parseSeatReconciliation(payload);
    const player = this.state.players.get(client.sessionId);
    const currentSeat = this.seating.getForSession(client.sessionId);
    const canRebindPendingSeat = Boolean(
      currentSeat &&
      (currentSeat.status === "RESERVED" || currentSeat.status === "CONFIRMING") &&
      player?.mode === "RESERVING",
    );
    if (!identity || !player || (player.mode !== "WALKING" && !canRebindPendingSeat)) {
      this.sendSeatResult(client, { accepted: false, reason: "invalid_reconciliation" });
      return;
    }
    const pit = this.geometry.pits.find(({ pitId }) => pitId === "wall-street-01");
    if (!pit || !this.membershipReader) {
      this.sendSeatResult(client, { accepted: false, reason: "chain_reconciliation_unavailable" });
      return;
    }
    const activeOnchainMatch = await this.membershipReader.isActiveMatch(pit.pitId, identity.matchAddress);
    if (!activeOnchainMatch) {
      this.sendSeatResult(client, { accepted: false, reason: "chain_reconciliation_unavailable" });
      return;
    }
    if (identity.matchAddress !== this.activeMatchAddress) {
      this.applyActiveMatch(identity.matchAddress);
    }
    if (canRebindPendingSeat && currentSeat) {
      const releasedSeats = this.seating.releaseSession(client.sessionId);
      for (const released of releasedSeats) this.syncSeat(this.seating.get(released.pitId, released.seatIndex));
      this.clearSeatPlayer(player, currentSeat, client.sessionId);
    }

    const isMember = await this.membershipReader.isConfirmed({
      matchAddress: identity.matchAddress,
      walletAddress: identity.walletAddress,
    });
    if (!isMember) return;
    const assignment = await this.seatAssignments.get(identity.matchAddress, identity.walletAddress);
    // A wallet can be a Match member without having a physical world seat.
    // Reconciliation restores only the separately persisted world assignment.
    if (!assignment || assignment.pitId !== pit.pitId) return;

    const result = this.seating.restoreConfirmed(client.sessionId, pit.pitId, assignment.seatIndex);
    if (result.accepted) {
      this.sessionIdentities.set(client.sessionId, identity);
      this.seatPlayer(client.sessionId, player, result.seat);
    }
    this.sendSeatResult(client, result);
  }

  private beginConfirmation(client: Client) {
    const result = this.seating.beginConfirmation(client.sessionId);
    if (result.accepted) this.syncSeat(result.seat);
    this.sendSeatResult(client, result);
  }

  private async releaseSeat(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    const releasedSeats = this.seating.releaseSession(client.sessionId);
    for (const released of releasedSeats) {
      this.syncSeat(this.seating.get(released.pitId, released.seatIndex));
    }
    this.clearSeatPlayer(player, releasedSeats[0], client.sessionId);
    await this.clearDurableSeatAssignment(client.sessionId);
    this.sendSeatResult(client, { accepted: true, action: "released" });
  }

  private async clearDurableSeatAssignment(sessionId: string) {
    const identity = this.sessionIdentities.get(sessionId);
    this.sessionIdentities.delete(sessionId);
    if (identity) await this.seatAssignments.delete(identity.matchAddress, identity.walletAddress);
  }

  private seatPlayer(sessionId: string, player: PlayerState, seat: SeatLease) {
    this.positionPlayerAtSeat(player, seat);
    player.mode = "SEATED";
    WorldRoom.seatedSessions.set(sessionId, { pitId: seat.pitId, seatIndex: seat.seatIndex });
    this.syncSeat(seat);
  }

  private reservePlayer(player: PlayerState, seat: SeatLease) {
    this.positionPlayerAtSeat(player, seat);
    player.mode = "RESERVING";
    this.syncSeat(seat);
  }

  private positionPlayerAtSeat(player: PlayerState, seat: SeatLease) {
    player.x = seat.x;
    player.y = seat.y;
    player.facing = seat.facing;
    player.pitId = seat.pitId;
    player.seatIndex = seat.seatIndex;
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
