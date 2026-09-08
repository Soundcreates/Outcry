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

// MagicBlock's documented Devnet TEE validator for devnet-tee.magicblock.app.
const DEVNET_TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const TEE_FEE_PAYER_TARGET_LAMPORTS = 10_000_000;
const TEE_FEE_PAYER_STORAGE_PREFIX = "outcry:tee-fee-payer:";

export type PrivateInventoryWallet = {
  publicKey: PublicKey | null;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array | { signature: Uint8Array }>;
  signTransaction?: (transaction: Transaction) => Promise<Transaction>;
  signAndSendTransaction?: (transaction: Transaction) => Promise<string | { signature: string }>;
};

export type PrivateQuoteSetupInput = {
  baseRpcUrl: string;
  teeRpcUrl: string;
  matchAddress: PublicKey;
  dealer: PublicKey;
  round: number;
  wallet: PrivateInventoryWallet;
  programId?: PublicKey;
  teeValidator?: PublicKey;
};

type PreparedPrivateQuote = {
  connection: Connection;
  feePayer: Keypair;
  expiresAt: number;
};

const PRIVATE_QUOTE_AUTH_MIN_VALIDITY_MS = 5_000;
const preparedPrivateQuotes = new Map<string, PreparedPrivateQuote>();

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

/**
 * Prepare a small, per-browser-session fee payer for MagicBlock's TEE.
 *
 * A normal wallet is not automatically delegated to the TEE, so using it as
 * the TEE transaction fee payer produces InvalidAccountForFee. The generated
 * keypair is funded and delegated on base Devnet once, then signs only the
 * TEE transaction fee-payer field. The connected wallet remains the program
 * authority and signs the RFQ instruction itself.
 */
export async function ensureTeeFeePayer(input: {
  baseRpcUrl: string;
  teeRpcUrl: string;
  teeConnection: Connection;
  player: PublicKey;
  wallet: PrivateInventoryWallet;
  programId?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  if (!input.wallet.signTransaction) throw new Error("wallet_transaction_signing_unavailable");
  if (!input.wallet.publicKey?.equals(input.player)) throw new Error("tee_fee_payer_wallet_mismatch");

  const feePayer = loadTeeFeePayer(`${TEE_FEE_PAYER_STORAGE_PREFIX}${input.teeRpcUrl}:${programId.toBase58()}`);
  const baseConnection = createBaseRpcConnection(input.baseRpcUrl);
  let account = await baseConnection.getAccountInfo(feePayer.publicKey, "confirmed");

  if (!account) {
    await sendWalletTransaction({
      connection: baseConnection,
      wallet: input.wallet,
      payer: input.player,
      label: "tee_fee_payer_funding",
      instructions: [SystemProgram.transfer({
        fromPubkey: input.player,
        toPubkey: feePayer.publicKey,
        lamports: TEE_FEE_PAYER_TARGET_LAMPORTS,
      })],
    });
    account = await baseConnection.getAccountInfo(feePayer.publicKey, "confirmed");
  } else if (account.owner.equals(SystemProgram.programId) && account.lamports < TEE_FEE_PAYER_TARGET_LAMPORTS) {
    await sendWalletTransaction({
      connection: baseConnection,
      wallet: input.wallet,
      payer: input.player,
      label: "tee_fee_payer_refunding",
      instructions: [SystemProgram.transfer({
        fromPubkey: input.player,
        toPubkey: feePayer.publicKey,
        lamports: TEE_FEE_PAYER_TARGET_LAMPORTS - account.lamports,
      })],
    });
    account = await baseConnection.getAccountInfo(feePayer.publicKey, "confirmed");
  }

  if (!account) throw new Error("tee_fee_payer_funding_failed");
  if (account.owner.equals(SystemProgram.programId)) {
    const transaction = new Transaction().add(
      SystemProgram.assign({ accountPubkey: feePayer.publicKey, programId: DELEGATION_PROGRAM_ID }),
      createDelegateInstruction({
        payer: input.player,
        delegatedAccount: feePayer.publicKey,
        ownerProgram: SystemProgram.programId,
        validator: teeValidatorForRpc(input.teeRpcUrl),
      }),
    );
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
  } else if (!account.owner.equals(DELEGATION_PROGRAM_ID)) {
    throw new Error("tee_fee_payer_account_invalid");
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
  round: number;
  programId?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  const quote = privateQuotePda({ matchAddress: input.matchAddress, round: input.round, dealer: input.dealer, programId });
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: quote, isWritable: true, isSigner: false },
      { pubkey: input.matchAddress, isWritable: false, isSigner: false },
      { pubkey: input.dealer, isWritable: true, isSigner: true },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
    ],
    data: Buffer.from([...INITIALIZE_PRIVATE_QUOTE_DISCRIMINATOR, input.round]),
  });
}

export function createDelegatePrivateQuoteInstruction(input: {
  matchAddress: PublicKey;
  dealer: PublicKey;
  round: number;
  validator: PublicKey;
  programId?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  const quote = privateQuotePda({ matchAddress: input.matchAddress, round: input.round, dealer: input.dealer, programId });
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
      input.round,
      ...input.dealer.toBytes(),
    ]),
  });
}

export function createInitPrivateQuotePermissionInstruction(input: {
  matchAddress: PublicKey;
  dealer: PublicKey;
  round: number;
  programId?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  const quote = privateQuotePda({ matchAddress: input.matchAddress, round: input.round, dealer: input.dealer, programId });
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: input.dealer, isWritable: false, isSigner: true },
      { pubkey: quote, isWritable: true, isSigner: false },
      { pubkey: privatePermissionPda(quote), isWritable: true, isSigner: false },
      { pubkey: PERMISSION_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: EPHEMERAL_VAULT_ID, isWritable: true, isSigner: false },
      { pubkey: MAGIC_PROGRAM_ID, isWritable: false, isSigner: false },
    ],
    data: Buffer.from(INIT_PRIVATE_QUOTE_PERMISSION_DISCRIMINATOR),
  });
}

function privateQuotePreparationKey(input: Pick<PrivateQuoteSetupInput, "teeRpcUrl" | "matchAddress" | "dealer" | "round" | "programId">) {
  return [
    input.teeRpcUrl,
    (input.programId ?? PROGRAM_ID).toBase58(),
    input.matchAddress.toBase58(),
    input.round,
    input.dealer.toBase58(),
  ].join(":");
}

export async function ensurePrivateQuote(input: PrivateQuoteSetupInput) {
  const programId = input.programId ?? PROGRAM_ID;
  if (!input.wallet.publicKey?.equals(input.dealer)) throw new Error("private_quote_wallet_mismatch");
  if (!input.wallet.signMessage) throw new Error("wallet_message_signing_unavailable");
  const quote = privateQuotePda({ matchAddress: input.matchAddress, round: input.round, dealer: input.dealer, programId });
  const baseConnection = createBaseRpcConnection(input.baseRpcUrl);
  const baseQuote = await baseConnection.getAccountInfo(quote, "confirmed");
  const validator = input.teeValidator ?? teeValidatorForRpc(input.teeRpcUrl);

  if (!baseQuote) {
    await sendWalletTransaction({
      connection: baseConnection,
      wallet: input.wallet,
      payer: input.dealer,
      label: "private_quote_setup",
      instructions: [
        createInitializePrivateQuoteInstruction({ matchAddress: input.matchAddress, dealer: input.dealer, round: input.round, programId }),
        createDelegatePrivateQuoteInstruction({ matchAddress: input.matchAddress, dealer: input.dealer, round: input.round, validator, programId }),
      ],
    });
  } else {
    assertPrivateQuoteIdentity(baseQuote.data, input.matchAddress, input.dealer, input.round);
    if (baseQuote.owner.equals(programId)) {
      await sendWalletTransaction({
        connection: baseConnection,
        wallet: input.wallet,
        payer: input.dealer,
        label: "private_quote_delegation",
        instructions: [createDelegatePrivateQuoteInstruction({
          matchAddress: input.matchAddress,
          dealer: input.dealer,
          round: input.round,
          validator,
          programId,
        })],
      });
    } else if (!baseQuote.owner.equals(DELEGATION_PROGRAM_ID)) {
      throw new Error("private_quote_account_invalid");
    }
  }

  let session = await createPrivateConnection({
    teeRpcUrl: input.teeRpcUrl,
    publicKey: input.dealer,
    signMessage: async (message) => signedMessage(input.wallet, message),
  });
  const feePayer = await ensureTeeFeePayer({
    baseRpcUrl: input.baseRpcUrl,
    teeRpcUrl: input.teeRpcUrl,
    teeConnection: session.connection,
    player: input.dealer,
    wallet: input.wallet,
    programId,
  });
  await waitForPrivateQuoteOnTee({
    connection: session.connection,
    quote,
    matchAddress: input.matchAddress,
    dealer: input.dealer,
    round: input.round,
    programId,
  });
  const permission = privatePermissionPda(quote);
  const permissionInfo = await session.connection.getAccountInfo(permission, "confirmed");
  if (!permissionInfo?.lamports) {
    await sendTeeTransaction({
      connection: session.connection,
      wallet: input.wallet,
      feePayer,
      label: "private_quote_permission",
      instructions: [createInitPrivateQuotePermissionInstruction({
        matchAddress: input.matchAddress,
        dealer: input.dealer,
        round: input.round,
        programId,
      })],
    });
    session = await createPrivateConnection({
      teeRpcUrl: input.teeRpcUrl,
      publicKey: input.dealer,
      signMessage: async (message) => signedMessage(input.wallet, message),
    });
  }
  return { connection: session.connection, feePayer, expiresAt: session.expiresAt };
}

/**
 * Performs the wallet-visible MagicBlock setup before an RFQ opens. The TEE
 * bearer token is deliberately memory-only; a page reload requires setup to
 * be revalidated rather than reusing credentials from browser storage.
 */
export async function preparePrivateQuote(input: PrivateQuoteSetupInput) {
  const prepared = await ensurePrivateQuote(input);
  if (prepared.expiresAt - Date.now() <= PRIVATE_QUOTE_AUTH_MIN_VALIDITY_MS) {
    throw new Error("private_quote_auth_expiring");
  }
  preparedPrivateQuotes.set(privateQuotePreparationKey(input), prepared);
  return prepared;
}

export function getPreparedPrivateQuote(input: Pick<PrivateQuoteSetupInput, "teeRpcUrl" | "matchAddress" | "dealer" | "round" | "programId">) {
  const key = privateQuotePreparationKey(input);
  const prepared = preparedPrivateQuotes.get(key);
  if (!prepared || prepared.expiresAt - Date.now() <= PRIVATE_QUOTE_AUTH_MIN_VALIDITY_MS) {
    preparedPrivateQuotes.delete(key);
    throw new Error("private_quote_not_prepared");
  }
  return prepared;
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
  programId?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  const inventory = privateInventoryPda({ matchAddress: input.matchAddress, player: input.player, programId });
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: input.player, isWritable: false, isSigner: true },
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
  wallet: PrivateInventoryWallet;
  programId?: PublicKey;
  teeValidator?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  if (!input.wallet.publicKey?.equals(input.player)) throw new Error("private_inventory_wallet_mismatch");
  if (!input.wallet.signMessage) throw new Error("wallet_message_signing_unavailable");
  const inventory = privateInventoryPda({ matchAddress: input.matchAddress, player: input.player, programId });
  const baseConnection = createBaseRpcConnection(input.baseRpcUrl);
  const baseInventory = await baseConnection.getAccountInfo(inventory, "confirmed");
  let delegatedNow = false;

  if (!baseInventory) {
    await sendWalletTransaction({
      connection: baseConnection,
      wallet: input.wallet,
      payer: input.player,
      label: "private_inventory_setup",
      instructions: [
        createInitializePrivateInventoryInstruction({ matchAddress: input.matchAddress, player: input.player, programId }),
        createDelegatePrivateInventoryInstruction({
          matchAddress: input.matchAddress,
          player: input.player,
          validator: input.teeValidator ?? teeValidatorForRpc(input.teeRpcUrl),
          programId,
        }),
      ],
    });
    delegatedNow = true;
  } else {
    assertPrivateInventoryIdentity(baseInventory.data, input.matchAddress, input.player);
    if (baseInventory.owner.equals(programId)) {
      await sendWalletTransaction({
        connection: baseConnection,
        wallet: input.wallet,
        payer: input.player,
        label: "private_inventory_delegation",
        instructions: [createDelegatePrivateInventoryInstruction({
          matchAddress: input.matchAddress,
          player: input.player,
          validator: input.teeValidator ?? teeValidatorForRpc(input.teeRpcUrl),
          programId,
        })],
      });
      delegatedNow = true;
    } else if (!baseInventory.owner.equals(DELEGATION_PROGRAM_ID)) {
      throw new Error("private_inventory_account_invalid");
    }
  }

  let session = await createPrivateConnection({
    teeRpcUrl: input.teeRpcUrl,
    publicKey: input.player,
    signMessage: async (message) => signedMessage(input.wallet, message),
  });
  let teeFeePayer: Keypair | undefined;
  const initializePermission = async () => {
    teeFeePayer ??= await ensureTeeFeePayer({
      baseRpcUrl: input.baseRpcUrl,
      teeRpcUrl: input.teeRpcUrl,
      teeConnection: session.connection,
      player: input.player,
      wallet: input.wallet,
      programId,
    });
    await initializePrivateInventoryPermission({
      connection: session.connection,
      wallet: input.wallet,
      feePayer: teeFeePayer,
      matchAddress: input.matchAddress,
      player: input.player,
      programId,
    });
  };
  if (delegatedNow) {
    await initializePermission();
    session = await createPrivateConnection({
      teeRpcUrl: input.teeRpcUrl,
      publicKey: input.player,
      signMessage: async (message) => signedMessage(input.wallet, message),
    });
  }

  try {
    return await readOwnPrivateInventory({ connection: session.connection, matchAddress: input.matchAddress, player: input.player, programId });
  } catch (reason) {
    if (delegatedNow || !(reason instanceof Error) || reason.message !== "private_inventory_unavailable") throw reason;
    await initializePermission();
    const refreshed = await createPrivateConnection({
      teeRpcUrl: input.teeRpcUrl,
      publicKey: input.player,
      signMessage: async (message) => signedMessage(input.wallet, message),
    });
    return readOwnPrivateInventory({ connection: refreshed.connection, matchAddress: input.matchAddress, player: input.player, programId });
  }
}

function instructionDiscriminator(name: string) {
  const instruction = outcryIdl.instructions.find((value) => value.name === name);
  if (!instruction) throw new Error(`outcry_idl_missing_${name}`);
  return Uint8Array.from(instruction.discriminator);
}

export function teeValidatorForRpc(teeRpcUrl: string) {
  if (new URL(teeRpcUrl).hostname === "devnet-tee.magicblock.app") return DEVNET_TEE_VALIDATOR;
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

function assertPrivateQuoteIdentity(data: Uint8Array, matchAddress: PublicKey, dealer: PublicKey, round: number) {
  if (data.length < 91 || !sameBytes(data.slice(0, 8), PRIVATE_QUOTE_DISCRIMINATOR)
    || !new PublicKey(data.slice(8, 40)).equals(matchAddress)
    || data[40] !== round
    || !new PublicKey(data.slice(41, 73)).equals(dealer)) {
    throw new Error("private_quote_account_invalid");
  }
}

async function waitForPrivateQuoteOnTee(input: {
  connection: Connection;
  quote: PublicKey;
  matchAddress: PublicKey;
  dealer: PublicKey;
  round: number;
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

async function initializePrivateInventoryPermission(input: {
  connection: Connection;
  wallet: PrivateInventoryWallet;
  feePayer: Keypair;
  matchAddress: PublicKey;
  player: PublicKey;
  programId: PublicKey;
}) {
  await sendTeeTransaction({
    connection: input.connection,
    wallet: input.wallet,
    feePayer: input.feePayer,
    label: "private_inventory_permission",
    instructions: [createInitPrivateInventoryPermissionInstruction(input)],
  });
}

export async function sendTeeTransaction(input: {
  connection: Connection;
  wallet: PrivateInventoryWallet;
  feePayer: Keypair;
  label: string;
  instructions: TransactionInstruction[];
}) {
  if (!input.wallet.signTransaction) throw new Error("wallet_transaction_signing_unavailable");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const transaction = new Transaction().add(...input.instructions);
    transaction.feePayer = input.feePayer.publicKey;
    const blockhash = await input.connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhash.blockhash;
    transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
    transaction.partialSign(input.feePayer);
    const simulation = await input.connection.simulateTransaction(transaction);
    if (simulation.value.err) {
      throw new Error(`${input.label}_simulation_failed: err=${JSON.stringify(simulation.value.err)} units=${simulation.value.unitsConsumed ?? "unknown"} logs=${JSON.stringify(simulation.value.logs ?? [])}`);
    }
    try {
      const signed = await input.wallet.signTransaction(transaction);
      const signature = await input.connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 5 });
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
}) {
  if (input.requireSignTransaction && !input.wallet.signTransaction) throw new Error("wallet_transaction_signing_unavailable");
  if (!input.wallet.signTransaction && !input.wallet.signAndSendTransaction) throw new Error("wallet_transaction_signing_unavailable");
  const transaction = new Transaction().add(...input.instructions);
  transaction.feePayer = input.payer;
  const blockhash = await input.connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
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
