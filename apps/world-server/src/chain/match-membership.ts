import { Connection, PublicKey } from "@solana/web3.js";

const MATCH_ACCOUNT_BYTES = 372;
const MATCH_ACCOUNT_DISCRIMINATOR = Buffer.from([236, 63, 169, 38, 15, 56, 196, 162]);
const MATCH_STATUS_OFFSET = 80;
const MATCH_CAPACITY_OFFSET = 81;
const MATCH_PLAYER_COUNT_OFFSET = 82;
const MATCH_PLAYERS_OFFSET = 83;
const MATCH_SEATS_OFFSET = 211;
const MAX_PLAYERS = 4;

export type MatchMembershipRequest = {
  matchAddress: string;
  walletAddress: string;
  seatIndex: number;
};

export type MatchMembershipReader = {
  isConfirmed(input: MatchMembershipRequest): Promise<boolean>;
};

export class SolanaMatchMembershipReader implements MatchMembershipReader {
  private readonly connection: Connection;
  private readonly programId: PublicKey;

  constructor(rpcUrl: string, programId: string) {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.programId = new PublicKey(programId);
  }

  async isConfirmed(input: MatchMembershipRequest) {
    if (!Number.isInteger(input.seatIndex) || input.seatIndex < 0 || input.seatIndex >= MAX_PLAYERS) return false;

    let matchAddress: PublicKey;
    let walletAddress: PublicKey;
    try {
      matchAddress = new PublicKey(input.matchAddress);
      walletAddress = new PublicKey(input.walletAddress);
    } catch {
      return false;
    }

    let account;
    try {
      account = await this.connection.getAccountInfo(matchAddress, "confirmed");
    } catch {
      return false;
    }
    if (!account || !account.owner.equals(this.programId) || account.data.length !== MATCH_ACCOUNT_BYTES) return false;
    if (!account.data.subarray(0, 8).equals(MATCH_ACCOUNT_DISCRIMINATOR)) return false;

    const playerCount = account.data.readUInt8(MATCH_PLAYER_COUNT_OFFSET);
    const capacity = account.data.readUInt8(MATCH_CAPACITY_OFFSET);
    const status = account.data.readUInt8(MATCH_STATUS_OFFSET);
    if ((status !== 0 && status !== 1) || playerCount === 0 || playerCount > MAX_PLAYERS || capacity === 0 || capacity > MAX_PLAYERS || capacity < playerCount) return false;

    const player = new PublicKey(account.data.subarray(MATCH_PLAYERS_OFFSET + input.seatIndex * 32, MATCH_PLAYERS_OFFSET + (input.seatIndex + 1) * 32));
    const seat = new PublicKey(account.data.subarray(MATCH_SEATS_OFFSET + input.seatIndex * 32, MATCH_SEATS_OFFSET + (input.seatIndex + 1) * 32));
    return player.equals(walletAddress) && seat.equals(walletAddress);
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
