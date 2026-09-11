import { Connection, PublicKey } from "@solana/web3.js";

// Match layouts 372 and 373 predate configurable rounds. The current 407-byte
// layout keeps membership fields at the same offsets as the 373-byte layout.
const MATCH_ACCOUNT_BYTES = new Set([372, 373, 407]);
const MATCH_ACCOUNT_DISCRIMINATOR = Buffer.from([236, 63, 169, 38, 15, 56, 196, 162]);
// MagicBlock owns delegated match accounts while they execute in the TEE.
const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const MATCH_STATUS_OFFSET = 80;
const MATCH_WAITING_STATUS = 0;
const MATCH_STARTED_STATUS = 1;
const MATCH_FINISHED_STATUS = 2;
const MATCH_CAPACITY_OFFSET = 81;
const MATCH_PLAYER_COUNT_OFFSET = 82;
const MATCH_LEGACY_PLAYERS_OFFSET = 83;
const MATCH_LEGACY_SEATS_OFFSET = 211;
const MATCH_CURRENT_PLAYERS_OFFSET = 84;
const MATCH_CURRENT_SEATS_OFFSET = 212;
const MAX_PLAYERS = 4;
const PIT_ACTIVE_MATCH_OFFSET = 73;
const PIT_SEED = Buffer.from("pit");
const ACTIVE_MATCH_READ_ATTEMPTS = 3;
const ACTIVE_MATCH_READ_DELAY_MS = 250;
const MEMBERSHIP_READ_ATTEMPTS = 6;
const MEMBERSHIP_READ_DELAY_MS = 500;

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export type MatchMembershipRequest = {
  matchAddress: string;
  walletAddress: string;
  seatIndex: number;
};

export type MatchMembershipReader = {
  isMatchReady(matchAddress: string): Promise<boolean>;
  isConfirmed(input: MatchMembershipRequest): Promise<boolean>;
  isActiveMatch(pitId: string, matchAddress: string): Promise<boolean>;
  readActiveMatch(pitId: string): Promise<string | undefined>;
};

export function isValidMatchAccount(
  account: { owner: PublicKey; data: Buffer } | null,
  programId: PublicKey,
) {
  if (!account) return false;
  return (account.owner.equals(programId) || account.owner.equals(DELEGATION_PROGRAM_ID))
    && MATCH_ACCOUNT_BYTES.has(account.data.length)
    && account.data.subarray(0, 8).equals(MATCH_ACCOUNT_DISCRIMINATOR);
}

export function isJoinableMatchAccount(
  account: { owner: PublicKey; data: Buffer } | null,
  programId: PublicKey,
) {
  if (!isValidMatchAccount(account, programId) || !account) return false;
  return account.data[MATCH_STATUS_OFFSET] === MATCH_WAITING_STATUS
    || account.data[MATCH_STATUS_OFFSET] === MATCH_STARTED_STATUS;
}

export function isMatchMemberAtSeat(data: Buffer, walletAddress: PublicKey, seatIndex: number) {
  if (seatIndex < 0 || seatIndex >= MAX_PLAYERS || !MATCH_ACCOUNT_BYTES.has(data.length)) return false;
  const playersOffset = data.length === 372 ? MATCH_LEGACY_PLAYERS_OFFSET : MATCH_CURRENT_PLAYERS_OFFSET;
  const seatsOffset = data.length === 372 ? MATCH_LEGACY_SEATS_OFFSET : MATCH_CURRENT_SEATS_OFFSET;
  const seat = new PublicKey(data.subarray(seatsOffset + seatIndex * 32, seatsOffset + (seatIndex + 1) * 32));
  if (!seat.equals(walletAddress)) return false;

  // `players` is append-only by join order; `seats` is indexed by the
  // requested seat. They are intentionally different indexes.
  const playerCount = data.readUInt8(MATCH_PLAYER_COUNT_OFFSET);
  if (playerCount === 0 || playerCount > MAX_PLAYERS) return false;
  return Array.from({ length: playerCount }, (_, index) =>
    new PublicKey(data.subarray(playersOffset + index * 32, playersOffset + (index + 1) * 32)),
  ).some((player) => player.equals(walletAddress));
}

export class SolanaMatchMembershipReader implements MatchMembershipReader {
  private readonly connection: Connection;
  private readonly programId: PublicKey;

  constructor(rpcUrl: string, programId: string) {
    this.connection = new Connection(rpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: true });
    this.programId = new PublicKey(programId);
  }

  async isMatchReady(matchAddress: string) {
    const account = await this.readValidMatchAccount(matchAddress);
    return isJoinableMatchAccount(account, this.programId);
  }

  async isActiveMatch(pitId: string, matchAddress: string) {
    const active = await this.readActiveMatch(pitId);
    return active === matchAddress;
  }

  async readActiveMatch(pitId: string) {
    const encoded = Buffer.from(pitId, "utf8");
    if (encoded.length === 0 || encoded.length > 32) return undefined;
    const pitIdBytes = Buffer.alloc(32);
    encoded.copy(pitIdBytes);
    const [pitAddress] = PublicKey.findProgramAddressSync([PIT_SEED, pitIdBytes], this.programId);
    for (let attempt = 0; attempt < ACTIVE_MATCH_READ_ATTEMPTS; attempt += 1) {
      try {
        const account = await this.connection.getAccountInfo(pitAddress, "confirmed");
        if (!account || !account.owner.equals(this.programId) || account.data.length < PIT_ACTIVE_MATCH_OFFSET + 32) return undefined;
        const active = new PublicKey(account.data.subarray(PIT_ACTIVE_MATCH_OFFSET, PIT_ACTIVE_MATCH_OFFSET + 32));
        if (active.equals(PublicKey.default)) return undefined;
        return active.toBase58();
      } catch {
        if (attempt + 1 < ACTIVE_MATCH_READ_ATTEMPTS) await delay(ACTIVE_MATCH_READ_DELAY_MS);
      }
    }
    return undefined;
  }

  async isConfirmed(input: MatchMembershipRequest) {
    if (!Number.isInteger(input.seatIndex) || input.seatIndex < 0 || input.seatIndex >= MAX_PLAYERS) return false;

    let walletAddress: PublicKey;
    try {
      new PublicKey(input.matchAddress);
      walletAddress = new PublicKey(input.walletAddress);
    } catch {
      return false;
    }

    // ponytail: bounded retry covers RPC commitment propagation; use account subscriptions if this becomes a high-throughput service.
    for (let attempt = 0; attempt < MEMBERSHIP_READ_ATTEMPTS; attempt += 1) {
      const account = await this.readValidMatchAccount(input.matchAddress);
      if (account) {
        const playerCount = account.data.readUInt8(MATCH_PLAYER_COUNT_OFFSET);
        const capacity = account.data.readUInt8(MATCH_CAPACITY_OFFSET);
        const status = account.data.readUInt8(MATCH_STATUS_OFFSET);
        if ((status !== MATCH_WAITING_STATUS && status !== MATCH_STARTED_STATUS && status !== MATCH_FINISHED_STATUS) || playerCount === 0 || playerCount > MAX_PLAYERS || capacity === 0 || capacity > MAX_PLAYERS || capacity < playerCount) return false;
        if (isMatchMemberAtSeat(account.data, walletAddress, input.seatIndex)) return true;
      }
      if (attempt + 1 < MEMBERSHIP_READ_ATTEMPTS) await delay(MEMBERSHIP_READ_DELAY_MS);
    }
    return false;
  }

  private async readValidMatchAccount(matchAddress: string) {
    let address: PublicKey;
    try {
      address = new PublicKey(matchAddress);
    } catch {
      return null;
    }

    try {
      const account = await this.connection.getAccountInfo(address, "confirmed");
      return isValidMatchAccount(account, this.programId) ? account : null;
    } catch {
      return null;
    }
  }
}

export function createMatchMembershipReader(input: {
  rpcUrl: string;
  programId?: string;
}): MatchMembershipReader | undefined {
  if (!input.programId) return undefined;
  try {
    return new SolanaMatchMembershipReader(input.rpcUrl, input.programId);
  } catch {
    return undefined;
  }
}
