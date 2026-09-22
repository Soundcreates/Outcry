import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  getAuthToken,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  createDelegateInstruction,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
  permissionPdaFromAccount,
  verifyTeeRpcIntegrity,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import { createBaseRpcConnection } from "./baseRpc";
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
const INITIALIZE_PRIVATE_INVENTORY_DISCRIMINATOR = instructionDiscriminator("initialize_private_inventory");
const DELEGATE_PRIVATE_INVENTORY_DISCRIMINATOR = instructionDiscriminator("delegate_private_inventory");
const INIT_PRIVATE_INVENTORY_PERMISSION_DISCRIMINATOR = instructionDiscriminator("init_private_inventory_permission");
const INITIALIZE_PRIVATE_QUOTE_DISCRIMINATOR = instructionDiscriminator("initialize_private_quote");
const DELEGATE_PRIVATE_QUOTE_DISCRIMINATOR = instructionDiscriminator("delegate_private_quote");
const INIT_PRIVATE_QUOTE_PERMISSION_DISCRIMINATOR = instructionDiscriminator("init_private_quote_permission");
const DELEGATE_RUNTIME_DISCRIMINATOR = instructionDiscriminator("delegate_runtime");

// MagicBlock's documented Devnet TEE validator for devnet-tee.magicblock.app.
const DEVNET_TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const TEE_FEE_PAYER_TARGET_LAMPORTS = 10_000_000;
const TEE_FEE_PAYER_STORAGE_PREFIX = "outcry:tee-fee-payer:";
const EPHEMERAL_PERMISSION_DISCRIMINATOR = 1;
const EPHEMERAL_PERMISSION_HEADER_SIZE = 35;
const EPHEMERAL_PERMISSION_MEMBER_SIZE = 33;
const EPHEMERAL_PERMISSION_MIN_SIZE = 101;

export type PrivateInventoryWallet = {
  publicKey: PublicKey | null;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array | { signature: Uint8Array }>;
  signTransaction?: (transaction: Transaction) => Promise<Transaction>;
  signAndSendTransaction?: (transaction: Transaction) => Promise<string | { signature: string }>;
};

export function privateQuotePda(input: {
  matchAddress: PublicKey;
  round?: number;
  dealer: PublicKey;
  programId: PublicKey;
}) {
  return findPrivatePda(
    [utf8Seed("quote"), input.matchAddress.toBuffer(), input.dealer.toBuffer()],
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

export function createDelegateRuntimeInstruction(input: {
  matchAddress: PublicKey;
  payer: PublicKey;
  validator: PublicKey;
  programId?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  const runtime = findPrivatePda([utf8Seed("runtime"), input.matchAddress.toBuffer()], programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: input.payer, isWritable: false, isSigner: true },
      { pubkey: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(runtime, programId), isWritable: true, isSigner: false },
      { pubkey: delegationRecordPdaFromDelegatedAccount(runtime), isWritable: true, isSigner: false },
      { pubkey: delegationMetadataPdaFromDelegatedAccount(runtime), isWritable: true, isSigner: false },
      { pubkey: runtime, isWritable: true, isSigner: false },
      { pubkey: input.validator, isWritable: false, isSigner: false },
      { pubkey: programId, isWritable: false, isSigner: false },
      { pubkey: DELEGATION_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
    ],
    data: Buffer.from([...DELEGATE_RUNTIME_DISCRIMINATOR, ...input.matchAddress.toBytes()]),
  });
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

/**
 * Prepare a small, per-browser-session fee payer for MagicBlock's TEE.
 *
 * A normal wallet is not automatically delegated to the TEE, so using it as
 * the TEE transaction fee payer produces InvalidAccountForFee. The generated
 * keypair is funded and delegated on base Devnet once, then signs only the
 * TEE transaction fee-payer field. The connected wallet remains setup-only.
 */
export async function ensureTeeFeePayer(input: {
  baseRpcUrl: string;
  teeRpcUrl: string;
  teeConnection: Connection;
  player: PublicKey;
  wallet: PrivateInventoryWallet;
  programId?: PublicKey;
  validator?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  if (!input.wallet.signTransaction) throw new Error("wallet_transaction_signing_unavailable");
  if (!input.wallet.publicKey?.equals(input.player)) throw new Error("tee_fee_payer_wallet_mismatch");

  const feePayer = getOrCreateTeeFeePayer(input.teeRpcUrl, programId);
  const baseConnection = createBaseRpcConnection(input.baseRpcUrl);
  const account = await baseConnection.getAccountInfo(feePayer.publicKey, "confirmed");
  const setupInstructions = createTeeFeePayerSetupInstructions({
    player: input.player,
    feePayer: feePayer.publicKey,
    validator: input.validator ?? teeValidatorForRpc(input.teeRpcUrl),
    currentAccount: account,
  });

  if (setupInstructions.length > 0) {
    const transaction = new Transaction().add(...setupInstructions);
    transaction.feePayer = input.player;
    const blockhash = await baseConnection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhash.blockhash;
    transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
    const simulation = await baseConnection.simulateTransaction(transaction);
    if (simulation.value.err) {
      const relevantLog = simulation.value.logs?.find((log) => /Error|failed|constraint|missing|insufficient/i.test(log));
      throw new Error(`tee_fee_payer_delegation_simulation_failed: ${relevantLog ?? JSON.stringify(simulation.value.err)}`);
    }
    transaction.partialSign(feePayer);
    const signed = await input.wallet.signTransaction(transaction);
    const signature = await baseConnection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 5 });
    const confirmation = await baseConnection.confirmTransaction({
      signature,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    }, "confirmed");
    if (confirmation.value.err) throw new Error(`tee_fee_payer_delegation_failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const teeAccount = await input.teeConnection.getAccountInfo(feePayer.publicKey, "confirmed");
    if (teeAccount) return feePayer;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("tee_fee_payer_unavailable");
}

function loadTeeFeePayer(storageKey: string) {
  if (typeof window === "undefined") throw new Error("tee_fee_payer_browser_required");
  try {
    const stored = window.sessionStorage.getItem(storageKey);
    if (stored) {
      const secretKey = JSON.parse(stored);
      if (Array.isArray(secretKey) && secretKey.length === 64) return Keypair.fromSecretKey(Uint8Array.from(secretKey));
    }
  } catch {
    // A stale or unavailable session entry is safely replaced below.
  }
  const feePayer = Keypair.generate();
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(Array.from(feePayer.secretKey)));
  } catch {
    throw new Error("tee_fee_payer_storage_unavailable");
  }
  return feePayer;
}

function teeFeePayerStorageKey(teeRpcUrl: string, programId: PublicKey) {
  return `${TEE_FEE_PAYER_STORAGE_PREFIX}${teeRpcUrl}:${programId.toBase58()}`;
}

export function getOrCreateTeeFeePayer(teeRpcUrl: string, programId = PROGRAM_ID) {
  return loadTeeFeePayer(teeFeePayerStorageKey(teeRpcUrl, programId));
}

export function createTeeFeePayerSetupInstructions(input: {
  player: PublicKey;
  feePayer: PublicKey;
  validator: PublicKey;
  currentAccount: { owner: PublicKey; lamports: number } | null;
}) {
  const account = input.currentAccount;
  if (account && account.owner.equals(DELEGATION_PROGRAM_ID)) return [];
  if (account && !account.owner.equals(SystemProgram.programId)) {
    throw new Error("tee_fee_payer_account_invalid");
  }

  const instructions: TransactionInstruction[] = [];
  const requiredLamports = account
    ? Math.max(0, TEE_FEE_PAYER_TARGET_LAMPORTS - account.lamports)
    : TEE_FEE_PAYER_TARGET_LAMPORTS;
  if (requiredLamports > 0) {
    instructions.push(SystemProgram.transfer({
      fromPubkey: input.player,
      toPubkey: input.feePayer,
      lamports: requiredLamports,
    }));
  }
  instructions.push(
    SystemProgram.assign({ accountPubkey: input.feePayer, programId: DELEGATION_PROGRAM_ID }),
    createDelegateInstruction({
      payer: input.player,
      delegatedAccount: input.feePayer,
      ownerProgram: SystemProgram.programId,
      validator: input.validator,
    }),
  );
  return instructions;
}

export function teeFeePayerForRpc(teeRpcUrl: string, programId = PROGRAM_ID) {
  if (typeof window === "undefined") return undefined;
  try {
    const stored = window.sessionStorage.getItem(teeFeePayerStorageKey(teeRpcUrl, programId));
    if (!stored) return undefined;
    const secretKey = JSON.parse(stored);
    return Array.isArray(secretKey) && secretKey.length === 64
      ? Keypair.fromSecretKey(Uint8Array.from(secretKey))
      : undefined;
  } catch {
    return undefined;
  }
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
  // Delegated MagicBlock accounts are owned by the delegation program until they
  // are committed and undelegated; the original program remains the only other
  // valid owner for this private reader.
  const validOwner = input.owner.equals(input.programId) || input.owner.equals(DELEGATION_PROGRAM_ID);
  if (!validOwner || input.data.length < input.length || !sameBytes(input.data.slice(0, 8), input.discriminator)) {
    throw new Error(`${input.label}_account_invalid`);
  }
}

export function isValidPrivatePermission(
  info: { owner: PublicKey; data: Uint8Array } | null | undefined,
  permissionedAccount: PublicKey,
) {
  if (!info?.owner.equals(PERMISSION_PROGRAM_ID)) return false;
  const data = info.data;
  if (data.length < EPHEMERAL_PERMISSION_MIN_SIZE
    || data[0] !== EPHEMERAL_PERMISSION_DISCRIMINATOR
    || data[34] !== 1
    || (data.length - EPHEMERAL_PERMISSION_HEADER_SIZE) % EPHEMERAL_PERMISSION_MEMBER_SIZE !== 0) {
    return false;
  }
  return new PublicKey(data.slice(2, 34)).equals(permissionedAccount);
}

export function createInitializePrivateInventoryInstruction(input: {
  matchAddress: PublicKey;
  player: PublicKey;
  programId?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  const inventory = privateInventoryPda({ matchAddress: input.matchAddress, player: input.player, programId });
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: inventory, isWritable: true, isSigner: false },
      { pubkey: input.matchAddress, isWritable: false, isSigner: false },
      { pubkey: input.player, isWritable: true, isSigner: true },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
    ],
    data: Buffer.from(INITIALIZE_PRIVATE_INVENTORY_DISCRIMINATOR),
  });
}

export function createInitializePrivateQuoteInstruction(input: {
  matchAddress: PublicKey;
  dealer: PublicKey;
  round?: number;
  programId?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  const quote = privateQuotePda({ matchAddress: input.matchAddress, dealer: input.dealer, programId });
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: quote, isWritable: true, isSigner: false },
      { pubkey: input.matchAddress, isWritable: false, isSigner: false },
      { pubkey: input.dealer, isWritable: true, isSigner: true },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
    ],
    data: Buffer.from(INITIALIZE_PRIVATE_QUOTE_DISCRIMINATOR),
  });
}

export function createDelegatePrivateQuoteInstruction(input: {
  matchAddress: PublicKey;
  dealer: PublicKey;
  round?: number;
  validator: PublicKey;
  programId?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  const quote = privateQuotePda({ matchAddress: input.matchAddress, dealer: input.dealer, programId });
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: input.dealer, isWritable: false, isSigner: true },
      { pubkey: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(quote, programId), isWritable: true, isSigner: false },
      { pubkey: delegationRecordPdaFromDelegatedAccount(quote), isWritable: true, isSigner: false },
      { pubkey: delegationMetadataPdaFromDelegatedAccount(quote), isWritable: true, isSigner: false },
      { pubkey: quote, isWritable: true, isSigner: false },
      { pubkey: input.validator, isWritable: false, isSigner: false },
      { pubkey: programId, isWritable: false, isSigner: false },
      { pubkey: DELEGATION_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
    ],
    data: Buffer.from([
      ...DELEGATE_PRIVATE_QUOTE_DISCRIMINATOR,
      ...input.matchAddress.toBytes(),
      ...input.dealer.toBytes(),
    ]),
  });
}

export function createInitPrivateQuotePermissionInstruction(input: {
  matchAddress: PublicKey;
  dealer: PublicKey;
  sessionKey: PublicKey;
  sessionGrantAddress: PublicKey;
  programId?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  const quote = privateQuotePda({ matchAddress: input.matchAddress, dealer: input.dealer, programId });
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: input.matchAddress, isWritable: false, isSigner: false },
      { pubkey: input.dealer, isWritable: false, isSigner: false },
      { pubkey: input.sessionKey, isWritable: false, isSigner: true },
      { pubkey: input.sessionGrantAddress, isWritable: false, isSigner: false },
      { pubkey: quote, isWritable: true, isSigner: false },
      { pubkey: privatePermissionPda(quote), isWritable: true, isSigner: false },
      { pubkey: PERMISSION_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: EPHEMERAL_VAULT_ID, isWritable: true, isSigner: false },
      { pubkey: MAGIC_PROGRAM_ID, isWritable: false, isSigner: false },
    ],
    data: Buffer.from(INIT_PRIVATE_QUOTE_PERMISSION_DISCRIMINATOR),
  });
}

/**
 * Completes the one-time private-state setup after the wallet creates the
 * reusable quote and inventory accounts. All permission mutations are signed
 * by the authorized session key; the wallet only pays the base delegation
 * transaction and any first-use TEE fee-payer funding.
 */
export async function ensurePrivateState(input: {
  baseRpcUrl: string;
  teeRpcUrl: string;
  matchAddress: PublicKey;
  player: PublicKey;
  sessionKeypair: Keypair;
  sessionGrantAddress: PublicKey;
  wallet: PrivateInventoryWallet;
  programId?: PublicKey;
  teeValidator?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  if (!input.wallet.publicKey?.equals(input.player)) throw new Error("private_state_wallet_mismatch");
  if (!input.wallet.signTransaction) throw new Error("wallet_transaction_signing_unavailable");
  if (!input.wallet.signMessage) throw new Error("wallet_message_signing_unavailable");

  const quote = privateQuotePda({ matchAddress: input.matchAddress, dealer: input.player, programId });
  const inventory = privateInventoryPda({ matchAddress: input.matchAddress, player: input.player, programId });
  const baseConnection = createBaseRpcConnection(input.baseRpcUrl);
  const feePayer = getOrCreateTeeFeePayer(input.teeRpcUrl, programId);
  const [quoteInfo, inventoryInfo, feePayerInfo] = await Promise.all([
    baseConnection.getAccountInfo(quote, "confirmed"),
    baseConnection.getAccountInfo(inventory, "confirmed"),
    baseConnection.getAccountInfo(feePayer.publicKey, "confirmed"),
  ]);
  if (!quoteInfo || !inventoryInfo) throw new Error("private_state_accounts_missing");
  assertPrivateQuoteIdentity(quoteInfo.data, input.matchAddress, input.player);
  assertPrivateInventoryIdentity(inventoryInfo.data, input.matchAddress, input.player);
  const validator = input.teeValidator ?? teeValidatorForRpc(input.teeRpcUrl);
  const delegationInstructions: TransactionInstruction[] = [];
  if (quoteInfo.owner.equals(programId)) {
    delegationInstructions.push(createDelegatePrivateQuoteInstruction({
      matchAddress: input.matchAddress,
      dealer: input.player,
      validator,
      programId,
    }));
  } else if (!quoteInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
    throw new Error("private_quote_account_invalid");
  }
  if (inventoryInfo.owner.equals(programId)) {
    delegationInstructions.push(createDelegatePrivateInventoryInstruction({
      matchAddress: input.matchAddress,
      player: input.player,
      validator,
      programId,
    }));
  } else if (!inventoryInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
    throw new Error("private_inventory_account_invalid");
  }
  const feePayerSetupInstructions = createTeeFeePayerSetupInstructions({
    player: input.player,
    feePayer: feePayer.publicKey,
    validator: input.teeValidator ?? validator,
    currentAccount: feePayerInfo,
  });
  const walletSetupInstructions = [...delegationInstructions, ...feePayerSetupInstructions];
  if (walletSetupInstructions.length > 0) {
    await sendWalletTransaction({
      connection: baseConnection,
      wallet: input.wallet,
      payer: input.player,
      label: "private_state_delegation",
      instructions: walletSetupInstructions,
      additionalSigners: feePayerSetupInstructions.length > 0 ? [feePayer] : [],
    });
  }

  let session = await createPrivateConnection({
    teeRpcUrl: input.teeRpcUrl,
    publicKey: input.sessionKeypair.publicKey,
    signMessage: async (message) => nacl.sign.detached(message, input.sessionKeypair.secretKey),
  });
  // A private account is intentionally hidden from TEE reads until its
  // EphemeralPermission exists and includes the current session signer. Do
  // not wait for the account before creating/updating that permission: this
  // made retries with a rotated/new session key fail forever with a generic
  // `*_tee_unavailable` error.
  const [quotePermission, inventoryPermission] = await Promise.all([
    session.connection.getAccountInfo(privatePermissionPda(quote), "confirmed"),
    session.connection.getAccountInfo(privatePermissionPda(inventory), "confirmed"),
  ]);
  if (quotePermission && !isValidPrivatePermission(quotePermission, quote)) {
    throw new Error("private_quote_permission_invalid");
  }
  if (inventoryPermission && !isValidPrivatePermission(inventoryPermission, inventory)) {
    throw new Error("private_inventory_permission_invalid");
  }

  // The program-side handlers are idempotent: they create a missing
  // permission and update an existing one. Always run both so a fresh session
  // signer is added to an existing match's member list.
  await Promise.all([
    !quotePermission
      ? waitForPrivateQuoteOnTee({ connection: session.connection, quote, matchAddress: input.matchAddress, dealer: input.player, programId })
      : Promise.resolve(),
    !inventoryPermission
      ? waitForPrivateInventoryOnTee({ connection: session.connection, inventory, matchAddress: input.matchAddress, player: input.player, programId })
      : Promise.resolve(),
  ]);

  await sendTeeSessionTransaction({
    connection: session.connection,
    sessionKeypair: input.sessionKeypair,
    feePayer,
    label: "private_state_permissions",
    instructions: [
      createInitPrivateQuotePermissionInstruction({
        matchAddress: input.matchAddress,
        dealer: input.player,
        sessionKey: input.sessionKeypair.publicKey,
        sessionGrantAddress: input.sessionGrantAddress,
        programId,
      }),
      createInitPrivateInventoryPermissionInstruction({
        matchAddress: input.matchAddress,
        player: input.player,
        sessionKey: input.sessionKeypair.publicKey,
        sessionGrantAddress: input.sessionGrantAddress,
        programId,
      }),
    ],
  });
  session = await createPrivateConnection({
    teeRpcUrl: input.teeRpcUrl,
    publicKey: input.sessionKeypair.publicKey,
    signMessage: async (message) => nacl.sign.detached(message, input.sessionKeypair.secretKey),
  });
  await Promise.all([
    waitForPrivateQuoteOnTee({ connection: session.connection, quote, matchAddress: input.matchAddress, dealer: input.player, programId }),
    waitForPrivateInventoryOnTee({ connection: session.connection, inventory, matchAddress: input.matchAddress, player: input.player, programId }),
  ]);
  return { connection: session.connection, feePayer, expiresAt: session.expiresAt };
}

export function createDelegatePrivateInventoryInstruction(input: {
  matchAddress: PublicKey;
  player: PublicKey;
  validator: PublicKey;
  programId?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  const inventory = privateInventoryPda({ matchAddress: input.matchAddress, player: input.player, programId });
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: input.player, isWritable: false, isSigner: true },
      { pubkey: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(inventory, programId), isWritable: true, isSigner: false },
      { pubkey: delegationRecordPdaFromDelegatedAccount(inventory), isWritable: true, isSigner: false },
      { pubkey: delegationMetadataPdaFromDelegatedAccount(inventory), isWritable: true, isSigner: false },
      { pubkey: inventory, isWritable: true, isSigner: false },
      { pubkey: input.validator, isWritable: false, isSigner: false },
      { pubkey: programId, isWritable: false, isSigner: false },
      { pubkey: DELEGATION_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
    ],
    data: Buffer.from([
      ...DELEGATE_PRIVATE_INVENTORY_DISCRIMINATOR,
      ...input.matchAddress.toBytes(),
      ...input.player.toBytes(),
    ]),
  });
}

export function createInitPrivateInventoryPermissionInstruction(input: {
  matchAddress: PublicKey;
  player: PublicKey;
  sessionKey: PublicKey;
  sessionGrantAddress: PublicKey;
  programId?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  const inventory = privateInventoryPda({ matchAddress: input.matchAddress, player: input.player, programId });
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: input.matchAddress, isWritable: false, isSigner: false },
      { pubkey: input.player, isWritable: false, isSigner: false },
      { pubkey: input.sessionKey, isWritable: false, isSigner: true },
      { pubkey: input.sessionGrantAddress, isWritable: false, isSigner: false },
      { pubkey: inventory, isWritable: true, isSigner: false },
      { pubkey: privatePermissionPda(inventory), isWritable: true, isSigner: false },
      { pubkey: PERMISSION_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: EPHEMERAL_VAULT_ID, isWritable: true, isSigner: false },
      { pubkey: MAGIC_PROGRAM_ID, isWritable: false, isSigner: false },
    ],
    data: Buffer.from(INIT_PRIVATE_INVENTORY_PERMISSION_DISCRIMINATOR),
  });
}

export async function unlockPrivateInventory(input: {
  baseRpcUrl: string;
  teeRpcUrl: string;
  matchAddress: PublicKey;
  player: PublicKey;
  sessionKeypair: Keypair;
  programId?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  const inventory = privateInventoryPda({ matchAddress: input.matchAddress, player: input.player, programId });
  const baseInventory = await createBaseRpcConnection(input.baseRpcUrl).getAccountInfo(inventory, "confirmed");
  if (!baseInventory) throw new Error("private_inventory_must_be_initialized_during_setup");
  assertPrivateInventoryIdentity(baseInventory.data, input.matchAddress, input.player);
  if (!baseInventory.owner.equals(programId) && !baseInventory.owner.equals(DELEGATION_PROGRAM_ID)) throw new Error("private_inventory_account_invalid");
  const session = await createPrivateConnection({
    teeRpcUrl: input.teeRpcUrl,
    publicKey: input.sessionKeypair.publicKey,
    signMessage: async (message) => nacl.sign.detached(message, input.sessionKeypair.secretKey),
  });
  return readOwnPrivateInventory({ connection: session.connection, matchAddress: input.matchAddress, player: input.player, programId });
}

function instructionDiscriminator(name: string) {
  const instruction = outcryIdl.instructions.find((value) => value.name === name);
  if (!instruction) throw new Error(`outcry_idl_missing_${name}`);
  return Uint8Array.from(instruction.discriminator);
}

export function teeValidatorForRpc(teeRpcUrl: string) {
  const hostname = new URL(teeRpcUrl).hostname;
  if (hostname === "devnet-tee.magicblock.app" || hostname === "devnet-tee-as.magicblock.app") return DEVNET_TEE_VALIDATOR;
  throw new Error("tee_validator_unconfigured");
}

function signedMessage(wallet: PrivateInventoryWallet, message: Uint8Array) {
  if (!wallet.signMessage) throw new Error("wallet_message_signing_unavailable");
  return wallet.signMessage(message).then((signed) => signed instanceof Uint8Array ? signed : signed.signature);
}

function assertPrivateInventoryIdentity(data: Uint8Array, matchAddress: PublicKey, player: PublicKey) {
  if (data.length < 129 || !sameBytes(data.slice(0, 8), PRIVATE_INVENTORY_DISCRIMINATOR)
    || !new PublicKey(data.slice(8, 40)).equals(matchAddress)
    || !new PublicKey(data.slice(40, 72)).equals(player)) {
    throw new Error("private_inventory_account_invalid");
  }
}

function assertPrivateQuoteIdentity(data: Uint8Array, matchAddress: PublicKey, dealer: PublicKey, expectedRound?: number) {
  if (data.length < 91 || !sameBytes(data.slice(0, 8), PRIVATE_QUOTE_DISCRIMINATOR)
    || !new PublicKey(data.slice(8, 40)).equals(matchAddress)
    || (expectedRound !== undefined && data[40] !== expectedRound)
    || !new PublicKey(data.slice(41, 73)).equals(dealer)) {
    throw new Error("private_quote_account_invalid");
  }
}

async function waitForPrivateQuoteOnTee(input: {
  connection: Connection;
  quote: PublicKey;
  matchAddress: PublicKey;
  dealer: PublicKey;
  round?: number;
  programId: PublicKey;
}) {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const info = await input.connection.getAccountInfo(input.quote, "confirmed");
    if (info) {
      try {
        assertPrivateAccount({
          data: info.data,
          owner: info.owner,
          programId: input.programId,
          discriminator: PRIVATE_QUOTE_DISCRIMINATOR,
          length: 91,
          label: "private_quote",
        });
        assertPrivateQuoteIdentity(info.data, input.matchAddress, input.dealer, input.round);
        return;
      } catch (reason) {
        lastError = reason instanceof Error ? reason : new Error("private_quote_account_invalid");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`private_quote_tee_unavailable${lastError ? `: ${lastError.message}` : ""}`);
}

async function waitForPrivateInventoryOnTee(input: {
  connection: Connection;
  inventory: PublicKey;
  matchAddress: PublicKey;
  player: PublicKey;
  programId: PublicKey;
}) {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const info = await input.connection.getAccountInfo(input.inventory, "confirmed");
    if (info) {
      try {
        assertPrivateAccount({
          data: info.data,
          owner: info.owner,
          programId: input.programId,
          discriminator: PRIVATE_INVENTORY_DISCRIMINATOR,
          length: 129,
          label: "private_inventory",
        });
        assertPrivateInventoryIdentity(info.data, input.matchAddress, input.player);
        return;
      } catch (reason) {
        lastError = reason instanceof Error ? reason : new Error("private_inventory_account_invalid");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`private_inventory_tee_unavailable${lastError ? `: ${lastError.message}` : ""}`);
}

export async function sendTeeSessionTransaction(input: {
  connection: Connection;
  sessionKeypair: Keypair;
  feePayer: Keypair;
  label: string;
  instructions: TransactionInstruction[];
}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const transaction = new Transaction().add(...input.instructions);
    transaction.feePayer = input.feePayer.publicKey;
    const blockhash = await input.connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhash.blockhash;
    transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
    transaction.partialSign(input.feePayer);
    transaction.partialSign(input.sessionKeypair);
    const simulation = await input.connection.simulateTransaction(transaction);
    if (simulation.value.err) {
      throw new Error(`${input.label}_simulation_failed: err=${JSON.stringify(simulation.value.err)} units=${simulation.value.unitsConsumed ?? "unknown"} logs=${JSON.stringify(simulation.value.logs ?? [])}`);
    }
    try {
      const signature = await input.connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 5 });
      for (let poll = 0; poll < 60; poll += 1) {
        const status = (await input.connection.getSignatureStatuses([signature])).value[0];
        if (status?.err || status?.confirmationStatus) {
          if (status.err) throw new Error(`${input.label}_transaction_failed: ${JSON.stringify(status.err)}`);
          return signature;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("tee_signature_expired");
    } catch (reason) {
      if (!(reason instanceof Error) || !/expired|block height exceeded|blockhash not found/i.test(reason.message) || attempt === 2) throw reason;
    }
  }
  throw new Error(`${input.label}_expired_retry_exhausted`);
}

async function sendWalletTransaction(input: {
  connection: Connection;
  wallet: PrivateInventoryWallet;
  payer: PublicKey;
  label: string;
  instructions: TransactionInstruction[];
  requireSignTransaction?: boolean;
  additionalSigners?: Keypair[];
}) {
  if (input.requireSignTransaction && !input.wallet.signTransaction) throw new Error("wallet_transaction_signing_unavailable");
  if (input.additionalSigners?.length && !input.wallet.signTransaction) throw new Error("wallet_transaction_signing_unavailable");
  if (!input.wallet.signTransaction && !input.wallet.signAndSendTransaction) throw new Error("wallet_transaction_signing_unavailable");
  const transaction = new Transaction().add(...input.instructions);
  transaction.feePayer = input.payer;
  const blockhash = await input.connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
  if (input.additionalSigners?.length) transaction.partialSign(...input.additionalSigners);
  const simulation = await input.connection.simulateTransaction(transaction);
  if (simulation.value.err) {
    const relevantLog = simulation.value.logs?.find((log) => /Error|failed|constraint|missing|insufficient/i.test(log));
    throw new Error(`${input.label}_simulation_failed: ${relevantLog ?? JSON.stringify(simulation.value.err)}`);
  }
  let signature: string;
  if (input.wallet.signTransaction) {
    const signed = await input.wallet.signTransaction(transaction);
    signature = await input.connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 5 });
  } else {
    const sent = await input.wallet.signAndSendTransaction!(transaction);
    signature = typeof sent === "string" ? sent : sent.signature;
  }
  const confirmation = await input.connection.confirmTransaction({
    signature,
    blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  }, "confirmed");
  if (confirmation.value.err) throw new Error(`${input.label}_transaction_failed: ${JSON.stringify(confirmation.value.err)}`);
  return signature;
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
  round?: number;
  dealer: PublicKey;
  programId?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  const account = privateQuotePda({ matchAddress: input.matchAddress, dealer: input.dealer, programId });
  const info = await input.connection.getAccountInfo(account, "confirmed");
  if (!info) throw new Error("private_quote_unavailable");
  assertPrivateAccount({ data: info.data, owner: info.owner, programId, discriminator: PRIVATE_QUOTE_DISCRIMINATOR, length: 91, label: "private_quote" });
  assertPrivateQuoteIdentity(info.data, input.matchAddress, input.dealer, input.round);
  if (!new PublicKey(info.data.slice(8, 40)).equals(input.matchAddress) || !new PublicKey(info.data.slice(41, 73)).equals(input.dealer)) {
    throw new Error("private_quote_identity_mismatch");
  }
  return {
    matchAddress: input.matchAddress.toBase58(),
    round: info.data[40],
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
