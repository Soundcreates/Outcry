import { Connection, PublicKey } from "@solana/web3.js";

// Devnet currently contains a legacy Match without the trailing bump byte (372).
// Newer builds allocate 373; all fields used here end before that optional byte.
const MATCH_ACCOUNT_BYTES = new Set([372, 373]);
const MATCH_ACCOUNT_DISCRIMINATOR = Buffer.from([236, 63, 169, 38, 15, 56, 196, 162]);
// MagicBlock owns delegated match accounts while they execute in the TEE.
const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const MATCH_STATUS_OFFSET = 80;
const MATCH_CAPACITY_OFFSET = 81;
const MATCH_PLAYER_COUNT_OFFSET = 82;
const MATCH_LEGACY_PLAYERS_OFFSET = 83;
const MATCH_LEGACY_SEATS_OFFSET = 211;
const MATCH_CURRENT_PLAYERS_OFFSET = 84;
const MATCH_CURRENT_SEATS_OFFSET = 212;
const MAX_PLAYERS = 4;
const MEMBERSHIP_READ_ATTEMPTS = 4;
const MEMBERSHIP_READ_DELAY_MS = 250;

export type MatchMembershipRequest = {
  matchAddress: string;
  walletAddress: string;
  seatIndex: number;
};

export type MatchMembershipReader = {
  isMatchReady(matchAddress: string): Promise<boolean>;
  isConfirmed(input: MatchMembershipRequest): Promise<boolean>;
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

export function isMatchMemberAtSeat(data: Buffer, walletAddress: PublicKey, seatIndex: number) {
  if (seatIndex < 0 || seatIndex >= MAX_PLAYERS || !MATCH_ACCOUNT_BYTES.has(data.length)) return false;
  const playersOffset = data.length === 373 ? MATCH_CURRENT_PLAYERS_OFFSET : MATCH_LEGACY_PLAYERS_OFFSET;
  const seatsOffset = data.length === 373 ? MATCH_CURRENT_SEATS_OFFSET : MATCH_LEGACY_SEATS_OFFSET;
  const player = new PublicKey(data.subarray(playersOffset + seatIndex * 32, playersOffset + (seatIndex + 1) * 32));
  const seat = new PublicKey(data.subarray(seatsOffset + seatIndex * 32, seatsOffset + (seatIndex + 1) * 32));
  return player.equals(walletAddress) && seat.equals(walletAddress);
}

export class SolanaMatchMembershipReader implements MatchMembershipReader {
  private readonly connection: Connection;
  private readonly programId: PublicKey;

  constructor(rpcUrl: string, programId: string) {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.programId = new PublicKey(programId);
  }

  async isMatchReady(matchAddress: string) {
    const account = await this.readValidMatchAccount(matchAddress);
    return Boolean(account);
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
        if ((status !== 0 && status !== 1) || playerCount === 0 || playerCount > MAX_PLAYERS || capacity === 0 || capacity > MAX_PLAYERS || capacity < playerCount) return false;
        if (isMatchMemberAtSeat(account.data, walletAddress, input.seatIndex)) return true;
      }
      if (attempt + 1 < MEMBERSHIP_READ_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, MEMBERSHIP_READ_DELAY_MS));
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
