import { Connection, PublicKey } from "@solana/web3.js";

const MATCH_V2_ACCOUNT_BYTES = 205;
const MATCH_V2_DISCRIMINATOR = Buffer.from([62, 55, 226, 63, 20, 119, 49, 118]);
const LEGACY_MATCH_ACCOUNT_BYTES = new Set([372, 373, 407]);
const LEGACY_MATCH_DISCRIMINATOR = Buffer.from([236, 63, 169, 38, 15, 56, 196, 162]);
// MagicBlock owns delegated accounts while they execute in the TEE.
const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const MATCH_V2_STATUS_OFFSET = 72;
const MATCH_V2_CAPACITY_OFFSET = 73;
const MATCH_V2_PLAYER_COUNT_OFFSET = 74;
const MATCH_V2_PLAYERS_OFFSET = 76;
const LEGACY_STATUS_OFFSET = 80;
const LEGACY_CAPACITY_OFFSET = 81;
const LEGACY_PLAYER_COUNT_OFFSET = 82;
const LEGACY_PLAYERS_OFFSET = 83;
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
};

export type MatchMembershipReader = {
  isMatchReady(matchAddress: string): Promise<boolean>;
  isConfirmed(input: MatchMembershipRequest): Promise<boolean>;
  isActiveMatch(pitId: string, matchAddress: string): Promise<boolean>;
  readActiveMatch(pitId: string): Promise<string | undefined>;
};

type MatchLayout = {
  statusOffset: number;
  capacityOffset: number;
  playerCountOffset: number;
  playersOffset: number;
};

function matchLayout(data: Buffer): MatchLayout | undefined {
  if (data.length === MATCH_V2_ACCOUNT_BYTES && data.subarray(0, 8).equals(MATCH_V2_DISCRIMINATOR)) {
    return {
      statusOffset: MATCH_V2_STATUS_OFFSET,
      capacityOffset: MATCH_V2_CAPACITY_OFFSET,
      playerCountOffset: MATCH_V2_PLAYER_COUNT_OFFSET,
      playersOffset: MATCH_V2_PLAYERS_OFFSET,
    };
  }
  if (LEGACY_MATCH_ACCOUNT_BYTES.has(data.length) && data.subarray(0, 8).equals(LEGACY_MATCH_DISCRIMINATOR)) {
    return {
      statusOffset: LEGACY_STATUS_OFFSET,
      capacityOffset: LEGACY_CAPACITY_OFFSET,
      playerCountOffset: LEGACY_PLAYER_COUNT_OFFSET,
      playersOffset: LEGACY_PLAYERS_OFFSET,
    };
  }
  return undefined;
}

export function isValidMatchAccount(
  account: { owner: PublicKey; data: Buffer } | null,
  programId: PublicKey,
) {
  if (!account) return false;
  return (account.owner.equals(programId) || account.owner.equals(DELEGATION_PROGRAM_ID))
    && matchLayout(account.data) !== undefined;
}

export function isJoinableMatchAccount(
  account: { owner: PublicKey; data: Buffer } | null,
  programId: PublicKey,
) {
  if (!isValidMatchAccount(account, programId) || !account) return false;
  const layout = matchLayout(account.data);
  if (!layout) return false;
  return account.data[layout.statusOffset] === 0 || account.data[layout.statusOffset] === 1;
}

/** Match membership is authority membership, not a durable onchain seat. */
export function isMatchMember(data: Buffer, walletAddress: PublicKey) {
  const layout = matchLayout(data);
  if (!layout) return false;
  const playerCount = data[layout.playerCountOffset];
  if (playerCount === 0 || playerCount > MAX_PLAYERS) return false;
  return Array.from({ length: playerCount }, (_, index) =>
    new PublicKey(data.subarray(layout.playersOffset + index * 32, layout.playersOffset + (index + 1) * 32)),
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
    // A missing/default active match is a valid onchain state. An RPC failure is
    // not: callers must fail closed rather than retain a previous match address.
    throw new Error("active_match_read_failed");
  }

  async isConfirmed(input: MatchMembershipRequest) {
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
        const layout = matchLayout(account.data);
        if (!layout) return false;
        const playerCount = account.data[layout.playerCountOffset];
        const capacity = account.data[layout.capacityOffset];
        const status = account.data[layout.statusOffset];
        if ((status !== 0 && status !== 1 && status !== 2) || playerCount === 0 || playerCount > MAX_PLAYERS || capacity === 0 || capacity > MAX_PLAYERS || capacity < playerCount) return false;
        if (isMatchMember(account.data, walletAddress)) return true;
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
