import Redis from "ioredis";

export type DurableSeatAssignment = {
  matchAddress: string;
  walletAddress: string;
  pitId: string;
  seatIndex: number;
};

export type SeatAssignmentStore = {
  get(matchAddress: string, walletAddress: string): Promise<DurableSeatAssignment | undefined>;
  set(assignment: DurableSeatAssignment): Promise<void>;
  delete(matchAddress: string, walletAddress: string): Promise<void>;
};

const keyOf = (matchAddress: string, walletAddress: string) => `outcry:seat:${matchAddress}:${walletAddress}`;

class MemorySeatAssignmentStore implements SeatAssignmentStore {
  private readonly assignments = new Map<string, DurableSeatAssignment>();

  async get(matchAddress: string, walletAddress: string) {
    return this.assignments.get(keyOf(matchAddress, walletAddress));
  }

  async set(assignment: DurableSeatAssignment) {
    this.assignments.set(keyOf(assignment.matchAddress, assignment.walletAddress), { ...assignment });
  }

  async delete(matchAddress: string, walletAddress: string) {
    this.assignments.delete(keyOf(matchAddress, walletAddress));
  }
}

class RedisSeatAssignmentStore implements SeatAssignmentStore {
  private readonly fallback = new MemorySeatAssignmentStore();
  private readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.redis.on("error", () => undefined);
  }

  async get(matchAddress: string, walletAddress: string) {
    try {
      const encoded = await this.redis.get(keyOf(matchAddress, walletAddress));
      if (!encoded) return this.fallback.get(matchAddress, walletAddress);
      const parsed = JSON.parse(encoded) as Partial<DurableSeatAssignment>;
      if (parsed.matchAddress !== matchAddress || parsed.walletAddress !== walletAddress || typeof parsed.pitId !== "string" || !Number.isSafeInteger(parsed.seatIndex)) {
        return undefined;
      }
      return parsed as DurableSeatAssignment;
    } catch {
      return this.fallback.get(matchAddress, walletAddress);
    }
  }

  async set(assignment: DurableSeatAssignment) {
    await this.fallback.set(assignment);
    try {
      await this.redis.set(keyOf(assignment.matchAddress, assignment.walletAddress), JSON.stringify(assignment));
    } catch {
      // The in-process copy keeps the current room usable while Redis recovers.
    }
  }

  async delete(matchAddress: string, walletAddress: string) {
    await this.fallback.delete(matchAddress, walletAddress);
    try {
      await this.redis.del(keyOf(matchAddress, walletAddress));
    } catch {
      // Deletion is retried by the next explicit seat lifecycle operation.
    }
  }
}

export function createSeatAssignmentStore(redisUrl?: string): SeatAssignmentStore {
  return redisUrl ? new RedisSeatAssignmentStore(redisUrl) : new MemorySeatAssignmentStore();
}
