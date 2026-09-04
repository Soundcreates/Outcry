import {
  getAuthToken,
  permissionPdaFromAccount,
  verifyTeeRpcIntegrity,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { Connection, PublicKey } from "@solana/web3.js";

export const PRIVATE_EXECUTOR = "PER_EXECUTOR" as const;
export type PrivateAccountKind = "quote" | "inventory";
export type PrivatePrincipal = PublicKey | typeof PRIVATE_EXECUTOR;
export type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

export type PrivateAccountRef = {
  account: PublicKey;
  owner: PublicKey;
  kind: PrivateAccountKind;
};

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
