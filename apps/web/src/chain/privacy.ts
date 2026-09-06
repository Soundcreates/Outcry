import {
  getAuthToken,
  permissionPdaFromAccount,
  verifyTeeRpcIntegrity,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import outcryIdl from "./idl/outcry.json";

export const PRIVATE_EXECUTOR = "PER_EXECUTOR" as const;
export type PrivateAccountKind = "quote" | "inventory";
export type PrivatePrincipal = PublicKey | typeof PRIVATE_EXECUTOR;
export type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

export type PrivateAccountRef = {
  account: PublicKey;
  owner: PublicKey;
  kind: PrivateAccountKind;
};

export type PrivateInventorySnapshot = {
  matchAddress: string;
  playerAddress: string;
  solPositionLots: bigint;
  cashE6: bigint;
  realizedPnlE6: bigint;
  filledNotionalE6: bigint;
};

export type PrivateQuoteSnapshot = {
  matchAddress: string;
  round: number;
  dealerAddress: string;
  priceE6: bigint;
  submittedAt: bigint;
  locked: boolean;
};

const PROGRAM_ID = new PublicKey(outcryIdl.address);
const PRIVATE_INVENTORY_DISCRIMINATOR = Uint8Array.from(outcryIdl.accounts.find((account) => account.name === "PrivateInventory")?.discriminator ?? []);
const PRIVATE_QUOTE_DISCRIMINATOR = Uint8Array.from(outcryIdl.accounts.find((account) => account.name === "PrivateQuote")?.discriminator ?? []);

export function privateQuotePda(input: {
  matchAddress: PublicKey;
  round: number;
  dealer: PublicKey;
  programId: PublicKey;
}) {
  return findPrivatePda(
    [utf8Seed("quote"), input.matchAddress.toBuffer(), roundSeed(input.round), input.dealer.toBuffer()],
    input.programId,
  );
}

export function privateInventoryPda(input: {
  matchAddress: PublicKey;
  player: PublicKey;
  programId: PublicKey;
}) {
  return findPrivatePda(
    [utf8Seed("inventory"), input.matchAddress.toBuffer(), input.player.toBuffer()],
    input.programId,
  );
}

export function privatePermissionPda(account: PublicKey) {
  return permissionPdaFromAccount(account);
}

export function canReadPrivateAccount(account: PrivateAccountRef, principal: PrivatePrincipal) {
  return principal === PRIVATE_EXECUTOR || principal.equals(account.owner);
}

export function assertPrivateReadAccess(account: PrivateAccountRef, principal: PrivatePrincipal) {
  if (!canReadPrivateAccount(account, principal)) {
    throw new Error("private_account_access_denied");
  }
}

export async function createPrivateConnection(input: {
  teeRpcUrl: string;
  publicKey: PublicKey;
  signMessage: SignMessage;
  verifyIntegrity?: (rpcUrl: string) => Promise<void>;
  authenticate?: (
    rpcUrl: string,
    publicKey: PublicKey,
    signMessage: SignMessage,
  ) => Promise<{ token: string; expiresAt: number }>;
}) {
  const endpoint = new URL(input.teeRpcUrl);
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("invalid_tee_rpc_url");
  }

  try {
    await (input.verifyIntegrity ?? verifyTeeRpcIntegrity)(input.teeRpcUrl);
  } catch {
    throw new Error("tee_integrity_failed");
  }

  let auth: { token: string; expiresAt: number };
  try {
    auth = await (input.authenticate ?? getAuthToken)(
      input.teeRpcUrl,
      input.publicKey,
      input.signMessage,
    );
  } catch {
    throw new Error("tee_auth_failed");
  }
  if (!auth.token || !Number.isFinite(auth.expiresAt)) {
    throw new Error("tee_auth_failed");
  }

  endpoint.searchParams.set("token", auth.token);
  return {
    connection: new Connection(endpoint.toString(), "confirmed"),
    expiresAt: auth.expiresAt,
    publicKey: input.publicKey,
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readI64(data: Uint8Array, offset: number) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(offset, true);
}

function readI128(data: Uint8Array, offset: number) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const value = view.getBigUint64(offset, true) | (view.getBigUint64(offset + 8, true) << 64n);
  return value >= (1n << 127n) ? value - (1n << 128n) : value;
}

function readU128(data: Uint8Array, offset: number) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, true) | (view.getBigUint64(offset + 8, true) << 64n);
}

function assertPrivateAccount(input: {
  data: Uint8Array;
  owner: PublicKey;
  programId: PublicKey;
  discriminator: Uint8Array;
  length: number;
  label: string;
}) {
  if (!input.owner.equals(input.programId) || input.data.length < input.length || !sameBytes(input.data.slice(0, 8), input.discriminator)) {
    throw new Error(`${input.label}_account_invalid`);
  }
}

export async function readOwnPrivateInventory(input: {
  connection: Connection;
  matchAddress: PublicKey;
  player: PublicKey;
  programId?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  const account = privateInventoryPda({ matchAddress: input.matchAddress, player: input.player, programId });
  const info = await input.connection.getAccountInfo(account, "confirmed");
  if (!info) throw new Error("private_inventory_unavailable");
  assertPrivateAccount({ data: info.data, owner: info.owner, programId, discriminator: PRIVATE_INVENTORY_DISCRIMINATOR, length: 129, label: "private_inventory" });
  if (!new PublicKey(info.data.slice(8, 40)).equals(input.matchAddress) || !new PublicKey(info.data.slice(40, 72)).equals(input.player)) {
    throw new Error("private_inventory_identity_mismatch");
  }
  return {
    matchAddress: input.matchAddress.toBase58(),
    playerAddress: input.player.toBase58(),
    solPositionLots: readI64(info.data, 72),
    cashE6: readI128(info.data, 80),
    realizedPnlE6: readI128(info.data, 96),
    filledNotionalE6: readU128(info.data, 112),
  } satisfies PrivateInventorySnapshot;
}

export async function readOwnPrivateQuote(input: {
  connection: Connection;
  matchAddress: PublicKey;
  round: number;
  dealer: PublicKey;
  programId?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  const account = privateQuotePda({ matchAddress: input.matchAddress, round: input.round, dealer: input.dealer, programId });
  const info = await input.connection.getAccountInfo(account, "confirmed");
  if (!info) throw new Error("private_quote_unavailable");
  assertPrivateAccount({ data: info.data, owner: info.owner, programId, discriminator: PRIVATE_QUOTE_DISCRIMINATOR, length: 91, label: "private_quote" });
  if (!new PublicKey(info.data.slice(8, 40)).equals(input.matchAddress) || info.data[40] !== input.round || !new PublicKey(info.data.slice(41, 73)).equals(input.dealer)) {
    throw new Error("private_quote_identity_mismatch");
  }
  return {
    matchAddress: input.matchAddress.toBase58(),
    round: input.round,
    dealerAddress: input.dealer.toBase58(),
    priceE6: readI64(info.data, 73),
    submittedAt: readI64(info.data, 81),
    locked: info.data[89] === 1,
  } satisfies PrivateQuoteSnapshot;
}

function findPrivatePda(seeds: Uint8Array[], programId: PublicKey) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function utf8Seed(value: string) {
  return new TextEncoder().encode(value);
}

function roundSeed(round: number) {
  if (!Number.isInteger(round) || round < 0 || round > 255) {
    throw new Error("invalid_private_round");
  }
  return Uint8Array.of(round);
}
