import {
  DELEGATION_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
  magicFeeVaultPdaFromValidator,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import outcryIdl from "./idl/outcry.json";
import { createBaseRpcConnection } from "./baseRpc";
import { createPrivateConnection, ensureTeeFeePayer, getPreparedPrivateQuote, preparePrivateQuote, privateInventoryPda, privateQuotePda, teeValidatorForRpc } from "./privacy";
import { postPythPriceAndConsume, PythSubmissionError } from "./pyth";
import { CURRENT_MATCH_BYTES, decodePublicMatchAccount, ORACLE_FEED_ID, ORACLE_FEED_ID_HEX, escrowPda, oraclePda, resultPda, roundPda } from "./matchState";
import type { TradeIntent } from "../match/tradeIntent";

const OPEN_RFQ_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "open_rfq")?.discriminator ?? []);
const INITIALIZE_ORACLE_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "initialize_oracle")?.discriminator ?? []);
const INITIALIZE_ORACLE_UNPRICED_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "initialize_oracle_unpriced")?.discriminator ?? []);
const INITIALIZE_MATCH_RESULT_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "initialize_match_result")?.discriminator ?? []);
const INITIALIZE_ESCROW_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "initialize_escrow")?.discriminator ?? []);
const PREPARE_RFQ_ROUND_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "prepare_rfq_round")?.discriminator ?? []);
const DELEGATE_ROUND_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "delegate_round")?.discriminator ?? []);
const UPDATE_ORACLE_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "update_oracle")?.discriminator ?? []);
const START_MATCH_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "start_match")?.discriminator ?? []);
const MIGRATE_LEGACY_MATCH_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "migrate_legacy_match")?.discriminator ?? []);
const SETTLE_MATCH_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "settle_match")?.discriminator ?? []);
const FINALIZE_SCORES_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "finalize_scores")?.discriminator ?? []);
const SUBMIT_QUOTE_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "submit_quote")?.discriminator ?? []);
const AUTHORIZE_SESSION_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "authorize_session")?.discriminator ?? []);
const SUBMIT_QUOTE_SESSION_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "submit_quote_session")?.discriminator ?? []);
const RESOLVE_ROUND_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "resolve_round")?.discriminator ?? []);
const SKIP_EMPTY_ROUND_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "skip_empty_round")?.discriminator ?? []);
const UNDELEGATE_ROUND_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "undelegate_round")?.discriminator ?? []);
const UNDELEGATE_PRIVATE_QUOTE_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "undelegate_private_quote")?.discriminator ?? []);
const UNDELEGATE_PRIVATE_INVENTORY_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "undelegate_private_inventory")?.discriminator ?? []);
const UNDELEGATE_ORACLE_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "undelegate_oracle")?.discriminator ?? []);
const NEXT_ROUND_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "next_round")?.discriminator ?? []);
const PROGRAM_ID = new PublicKey(outcryIdl.address);
export const DEFAULT_QUOTE_WINDOW_SECONDS = 30;
export const DEFAULT_MATCH_PAYOUT_LAMPORTS = 1_000_000;
const QUOTE_SESSION_ACTION = 2;
const QUOTE_SESSION_DURATION_SECONDS = 15 * 60;
const QUOTE_SESSION_SAFETY_MS = 5_000;

type PreparedQuoteSession = {
  signer: Keypair;
  expiresAt: number;
};

// Deliberately memory-only: reloading the page requires a fresh, scoped grant.
const preparedQuoteSessions = new Map<string, PreparedQuoteSession>();

type AccountInfoConnection = Pick<Connection, "getMultipleAccountsInfo">;

export type RfqProgress = (status: string) => void;

export class RfqSubmissionError extends Error {
  constructor(
    public readonly stage: "wallet" | "state" | "price" | "simulation" | "confirmation" | "tee",
    public readonly code: string,
    detail?: string,
    public readonly diagnostics?: PythSubmissionError["diagnostics"],
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "RfqSubmissionError";
  }
}

function rfqFailure(stage: RfqSubmissionError["stage"], code: string, reason?: unknown) {
  if (reason instanceof RfqSubmissionError) return reason;
  const detail = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  console.error(`[outcry][rfq][${stage}]`, reason);
  return new RfqSubmissionError(
    stage,
    code,
    detail,
    reason instanceof PythSubmissionError ? reason.diagnostics : undefined,
  );
}

function integerBytes(value: number | bigint, signed = false) {
  const data = new Uint8Array(8);
  new DataView(data.buffer)[signed ? "setBigInt64" : "setBigUint64"](0, BigInt(value), true);
  return data;
}

function quoteSessionKey(input: { baseRpcUrl: string; matchAddress: string; dealer: PublicKey; programId: PublicKey }) {
  return [input.baseRpcUrl, input.programId.toBase58(), input.matchAddress, input.dealer.toBase58()].join(":");
}

export function sessionGrantPda(input: {
  matchAddress: string;
  authorityAddress: string;
  sessionKey: PublicKey;
  programId?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  return PublicKey.findProgramAddressSync([
    Buffer.from("session"),
    new PublicKey(input.matchAddress).toBuffer(),
    new PublicKey(input.authorityAddress).toBuffer(),
    input.sessionKey.toBuffer(),
  ], programId)[0];
}

function getPreparedQuoteSession(input: { baseRpcUrl: string; matchAddress: string; dealer: PublicKey; programId: PublicKey }) {
  const key = quoteSessionKey(input);
  const session = preparedQuoteSessions.get(key);
  if (!session || session.expiresAt - Date.now() <= QUOTE_SESSION_SAFETY_MS) {
    preparedQuoteSessions.delete(key);
    throw new Error("private_quote_session_not_prepared");
  }
  return session;
}

async function prepareQuoteSession(input: {
  baseConnection: Connection;
  wallet: {
    signTransaction?: (transaction: Transaction) => Promise<Transaction>;
    signAndSendTransaction?: (transaction: Transaction) => Promise<string | { signature: string }>;
  };
  baseRpcUrl: string;
  matchAddress: string;
  dealer: PublicKey;
  programId: PublicKey;
}) {
  const key = quoteSessionKey(input);
  const existing = preparedQuoteSessions.get(key);
  if (existing && existing.expiresAt - Date.now() > QUOTE_SESSION_SAFETY_MS) return existing;

  const signer = Keypair.generate();
  await sendWalletTransaction({
    connection: input.baseConnection,
    wallet: input.wallet,
    payer: input.dealer,
    label: "private_quote_session_authorization",
    instructions: [createAuthorizeQuoteSessionInstruction({
      matchAddress: input.matchAddress,
      authorityAddress: input.dealer.toBase58(),
      sessionKey: signer.publicKey,
      programId: input.programId,
    })],
  });
  const session = {
    signer,
    expiresAt: Date.now() + QUOTE_SESSION_DURATION_SECONDS * 1_000 - QUOTE_SESSION_SAFETY_MS,
  };
  preparedQuoteSessions.set(key, session);
  return session;
}

async function sendTeeTransaction(input: {
  connection: Connection;
  wallet?: { signTransaction?: (transaction: Transaction) => Promise<Transaction> };
  feePayer: Keypair;
  additionalSigners?: Keypair[];
  instructions: TransactionInstruction[];
  label: string;
}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const transaction = new Transaction().add(...input.instructions);
    transaction.feePayer = input.feePayer.publicKey;
    const blockhash = await input.connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhash.blockhash;
    transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
    transaction.partialSign(input.feePayer, ...(input.additionalSigners ?? []));

    const simulation = await input.connection.simulateTransaction(transaction);
    if (simulation.value.err) {
      const diagnostics = {
        label: input.label,
        err: simulation.value.err,
        logs: simulation.value.logs ?? [],
        unitsConsumed: simulation.value.unitsConsumed ?? null,
      };
      console.error("[outcry][tee][simulation]", diagnostics);
      const relevantLog = diagnostics.logs.find((log) => /AnchorError|Error Code|failed|custom program error/i.test(log));
      throw new Error(`${input.label}_simulation_failed: ${relevantLog ?? JSON.stringify(diagnostics.err)}`);
    }

    try {
      const signed = input.wallet?.signTransaction
        ? await input.wallet.signTransaction(transaction)
        : transaction;
      const signature = await input.connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 5 });
      const status = await waitForTeeSignature(input.connection, signature);
      if (status.err) {
        const transactionDetails = await input.connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        }).catch(() => null);
        const diagnostics = {
          label: input.label,
          signature,
          err: status.err,
          logs: transactionDetails?.meta?.logMessages ?? [],
          unitsConsumed: transactionDetails?.meta?.computeUnitsConsumed ?? null,
        };
        console.error("[outcry][tee][confirmation]", diagnostics);
        const relevantLog = diagnostics.logs.find((log) => /AnchorError|Error Code|failed|custom program error/i.test(log));
        throw new Error(`${input.label}_transaction_failed: ${relevantLog ?? JSON.stringify(status.err)}`);
      }
      return signature;
    } catch (reason) {
      if (!(reason instanceof Error) || !/expired|block height exceeded|blockhash not found/i.test(reason.message)) throw reason;
      if (attempt === 2) throw new Error(`${input.label}_expired_retry_exhausted`);
    }
  }

  throw new Error(`${input.label}_expired_retry_exhausted`);
}

async function waitForTeeSignature(connection: Connection, signature: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (status?.err || status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return status ?? { err: null };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("tee_signature_expired");
}

async function sendWalletTransaction(input: {
  connection: Connection;
  wallet: {
    signTransaction?: (transaction: Transaction) => Promise<Transaction>;
    signAndSendTransaction?: (transaction: Transaction) => Promise<string | { signature: string }>;
  };
  payer: PublicKey;
  instructions: TransactionInstruction[];
  label: string;
}) {
  if (!input.wallet.signTransaction && !input.wallet.signAndSendTransaction) throw new Error("wallet_transaction_signing_unavailable");
  const transaction = new Transaction().add(...input.instructions);
  transaction.feePayer = input.payer;
  const blockhash = await input.connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
  const simulation = await input.connection.simulateTransaction(transaction);
  if (simulation.value.err) {
    const relevantLog = simulation.value.logs?.find((log) => /AnchorError|Error Code|failed|custom program error/i.test(log));
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

function delegatedAccountKeys(account: PublicKey, programId: PublicKey, validator: PublicKey) {
  return [
    { pubkey: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(account, programId), isWritable: true, isSigner: false },
    { pubkey: delegationRecordPdaFromDelegatedAccount(account), isWritable: true, isSigner: false },
    { pubkey: delegationMetadataPdaFromDelegatedAccount(account), isWritable: true, isSigner: false },
    { pubkey: account, isWritable: true, isSigner: false },
    { pubkey: validator, isWritable: false, isSigner: false },
    { pubkey: programId, isWritable: false, isSigner: false },
    { pubkey: DELEGATION_PROGRAM_ID, isWritable: false, isSigner: false },
    { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
  ];
}

export async function waitForRfqExecutionState(input: {
  baseConnection: AccountInfoConnection;
  teeConnection: AccountInfoConnection;
  accounts: Record<string, PublicKey>;
  attempts?: number;
  retryMs?: number;
}) {
  const entries = Object.entries(input.accounts);
  const attempts = input.attempts ?? 20;
  const retryMs = input.retryMs ?? 500;
  let unavailable = entries.map(([label]) => label);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const addresses = entries.map(([, address]) => address);
    const [baseInfos, teeInfos] = await Promise.all([
      input.baseConnection.getMultipleAccountsInfo(addresses, "confirmed"),
      input.teeConnection.getMultipleAccountsInfo(addresses, "confirmed"),
    ]);
    unavailable = entries.flatMap(([label], index) => {
      if (!baseInfos[index]?.owner.equals(DELEGATION_PROGRAM_ID)) return [`${label}_not_delegated`];
      return teeInfos[index] ? [] : [`${label}_unavailable`];
    });
    if (unavailable.length === 0) return;
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, retryMs));
  }

  throw new Error(`rfq_state_not_ready:${unavailable.join(",")}`);
}

export function createStartMatchInstruction(input: {
  matchAddress: string;
  hostAddress: string;
  roundCount?: number;
  programId?: string;
}) {
  const roundCount = input.roundCount ?? 3;
  if (!Number.isInteger(roundCount) || roundCount < 1 || roundCount > 8) throw new Error("invalid_round_count");
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(input.matchAddress), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.hostAddress), isWritable: false, isSigner: true },
    ],
    data: Uint8Array.from([...START_MATCH_DISCRIMINATOR, roundCount]) as unknown as Buffer,
  });
}

export function createInitializeMatchResultInstruction(input: {
  matchAddress: string;
  authorityAddress: string;
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(input.matchAddress), isWritable: true, isSigner: false },
      { pubkey: resultPda(input.matchAddress, programId), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.authorityAddress), isWritable: true, isSigner: true },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
    ],
    data: Buffer.from(INITIALIZE_MATCH_RESULT_DISCRIMINATOR),
  });
}

export function createInitializeEscrowInstruction(input: {
  matchAddress: string;
  authorityAddress: string;
  payoutLamports?: number;
  programId?: string;
}) {
  const payoutLamports = input.payoutLamports ?? DEFAULT_MATCH_PAYOUT_LAMPORTS;
  if (!Number.isSafeInteger(payoutLamports) || payoutLamports <= 0) throw new Error("invalid_escrow_payout");
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(input.matchAddress), isWritable: true, isSigner: false },
      { pubkey: escrowPda(input.matchAddress, programId), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.authorityAddress), isWritable: true, isSigner: true },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
    ],
    data: Uint8Array.from([...INITIALIZE_ESCROW_DISCRIMINATOR, ...integerBytes(payoutLamports)]) as unknown as Buffer,
  });
}

export function createMigrateLegacyMatchInstruction(input: {
  matchAddress: string;
  hostAddress: string;
  roundCount?: number;
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(input.matchAddress), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.hostAddress), isWritable: true, isSigner: true },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
    ],
    data: Uint8Array.from(MIGRATE_LEGACY_MATCH_DISCRIMINATOR) as unknown as Buffer,
  });
}

export async function startMatchOnchain(input: {
  rpcUrl: string;
  matchAddress: string;
  hostAddress: string;
  roundCount?: number;
  programId?: string;
}) {
  const wallet = window.solana;
  if (!wallet) throw new Error("solana_wallet_not_found");
  const connected = wallet.publicKey ? { publicKey: wallet.publicKey } : await wallet.connect();
  const authority = new PublicKey(connected.publicKey);
  if (authority.toBase58() !== input.hostAddress) throw new Error("host_wallet_mismatch");
  const connection = createBaseRpcConnection(input.rpcUrl);
  const matchInfo = await connection.getAccountInfo(new PublicKey(input.matchAddress), "confirmed");
  if (!matchInfo) throw new Error("match_account_unavailable");
  const transaction = new Transaction();
  if (matchInfo.data.length < CURRENT_MATCH_BYTES) {
    transaction.add(createMigrateLegacyMatchInstruction({ ...input, hostAddress: authority.toBase58() }));
  }
  transaction.add(createStartMatchInstruction({ ...input, hostAddress: authority.toBase58() }));
  transaction.add(createInitializeEscrowInstruction({
    matchAddress: input.matchAddress,
    authorityAddress: authority.toBase58(),
    programId: input.programId,
  }));
  transaction.add(createPrepareRfqRoundInstruction({
    matchAddress: input.matchAddress,
    takerAddress: authority.toBase58(),
    round: 0,
    programId: input.programId,
  }));
  transaction.add(createInitializeMatchResultInstruction({
    matchAddress: input.matchAddress,
    authorityAddress: authority.toBase58(),
    programId: input.programId,
  }));
  transaction.feePayer = authority;
  const blockhash = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) {
    const relevantLog = simulation.value.logs?.find((log) => /Error|failed|constraint|invalid|insufficient/i.test(log));
    throw new Error(`start_match_simulation_failed: ${relevantLog ?? JSON.stringify(simulation.value.err)}`);
  }
  const sent = await wallet.signAndSendTransaction(transaction);
  const signature = typeof sent === "string" ? sent : sent.signature;
  await connection.confirmTransaction({ signature, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight }, "confirmed");
  return { walletAddress: authority.toBase58(), signature };
}

export async function prepareRfqRoundOnchain(input: {
  rpcUrl: string;
  matchAddress: string;
  takerAddress: string;
  round: number;
  programId?: string;
}) {
  const wallet = window.solana;
  if (!wallet) throw new Error("solana_wallet_not_found");
  const connected = wallet.publicKey ? { publicKey: wallet.publicKey } : await wallet.connect();
  const taker = new PublicKey(connected.publicKey);
  if (taker.toBase58() !== input.takerAddress) throw new Error("round_taker_wallet_mismatch");

  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  const connection = createBaseRpcConnection(input.rpcUrl);
  const matchInfo = await connection.getAccountInfo(new PublicKey(input.matchAddress), "confirmed");
  if (!matchInfo?.owner.equals(programId)) throw new Error("match_account_unavailable");
  const snapshot = decodePublicMatchAccount(input.matchAddress, matchInfo.data);
  if (snapshot.status !== "STARTED" || snapshot.currentRound !== input.round || snapshot.taker !== taker.toBase58()) {
    throw new Error("round_preparation_not_current_taker");
  }

  const roundAddress = roundPda(input.matchAddress, input.round, programId);
  const existing = await connection.getAccountInfo(roundAddress, "confirmed");
  if (existing) {
    if (existing.owner.equals(programId) && existing.data.length >= 100 && existing.data[99] === 2) {
      return { walletAddress: taker.toBase58(), alreadyPrepared: true };
    }
    throw new Error("round_preparation_unavailable");
  }

  const signature = await sendWalletTransaction({
    connection,
    wallet,
    payer: taker,
    instructions: [createPrepareRfqRoundInstruction({
      matchAddress: input.matchAddress,
      takerAddress: taker.toBase58(),
      round: input.round,
      programId: programId.toBase58(),
    })],
    label: "prepare_rfq_round",
  });
  return { walletAddress: taker.toBase58(), signature, alreadyPrepared: false };
}

export function createInitializeOracleInstruction(input: {
  authorityAddress: string;
  priceUpdateAddress: string;
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  const authority = new PublicKey(input.authorityAddress);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: oraclePda(programId), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.priceUpdateAddress), isWritable: false, isSigner: false },
      { pubkey: authority, isWritable: true, isSigner: true },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
    ],
    data: Uint8Array.from([...INITIALIZE_ORACLE_DISCRIMINATOR, ...ORACLE_FEED_ID]) as unknown as Buffer,
  });
}

export function createInitializeOracleUnpricedInstruction(input: {
  authorityAddress: string;
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  const authority = new PublicKey(input.authorityAddress);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: oraclePda(programId), isWritable: true, isSigner: false },
      { pubkey: authority, isWritable: true, isSigner: true },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
    ],
    data: Uint8Array.from([...INITIALIZE_ORACLE_UNPRICED_DISCRIMINATOR, ...ORACLE_FEED_ID]) as unknown as Buffer,
  });
}

export function createPrepareRfqRoundInstruction(input: {
  matchAddress: string;
  takerAddress: string;
  round: number;
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(input.matchAddress), isWritable: false, isSigner: false },
      { pubkey: roundPda(input.matchAddress, input.round, programId), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.takerAddress), isWritable: true, isSigner: true },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
    ],
    data: Buffer.from(PREPARE_RFQ_ROUND_DISCRIMINATOR),
  });
}

export function createDelegateRoundInstruction(input: {
  matchAddress: string;
  round: number;
  authorityAddress: string;
  validator: PublicKey;
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  const round = roundPda(input.matchAddress, input.round, programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(input.authorityAddress), isWritable: false, isSigner: true },
      ...delegatedAccountKeys(round, programId, input.validator),
    ],
    data: Buffer.from([...DELEGATE_ROUND_DISCRIMINATOR, ...new PublicKey(input.matchAddress).toBytes(), input.round]),
  });
}

export function createUpdateOracleInstruction(input: {
  authorityAddress: string;
  priceUpdateAddress: string;
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: oraclePda(programId), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.priceUpdateAddress), isWritable: false, isSigner: false },
      { pubkey: new PublicKey(input.authorityAddress), isWritable: false, isSigner: true },
    ],
    data: Buffer.from(UPDATE_ORACLE_DISCRIMINATOR),
  });
}

export function createOpenRfqInstruction(input: {
  matchAddress: string;
  playerAddress: string;
  programId?: string;
  round: number;
  side: TradeIntent["side"];
  quantity: TradeIntent["quantity"];
  quoteWindowSeconds?: number;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  const match = new PublicKey(input.matchAddress);
  const player = new PublicKey(input.playerAddress);
  const quoteWindowSeconds = input.quoteWindowSeconds ?? DEFAULT_QUOTE_WINDOW_SECONDS;
  if (!Number.isInteger(quoteWindowSeconds) || quoteWindowSeconds < 1 || quoteWindowSeconds > 30) throw new Error("invalid_quote_window");
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: match, isWritable: false, isSigner: false },
      { pubkey: roundPda(input.matchAddress, input.round, programId), isWritable: true, isSigner: false },
      { pubkey: oraclePda(programId), isWritable: false, isSigner: false },
      { pubkey: player, isWritable: false, isSigner: true },
    ],
    data: Uint8Array.from([
      ...OPEN_RFQ_DISCRIMINATOR,
      input.side === "BUY" ? 0 : 1,
      ...integerBytes(input.quantity),
      ...integerBytes(quoteWindowSeconds, true),
    ]) as unknown as Buffer,
  });
}

export type OpenRfqInput = {
  rpcUrl?: string;
  baseRpcUrl?: string;
  teeRpcUrl?: string;
  matchAddress: string;
  hostAddress?: string;
  programId?: string;
  round: number;
  intent: TradeIntent;
  priceUpdates: string[];
  onProgress?: RfqProgress;
};

export async function openRfqOnchain(input: OpenRfqInput) {
  try {
    return await openRfqOnchainInner(input);
  } catch (reason) {
    if (reason instanceof RfqSubmissionError) throw reason;
    if (reason instanceof PythSubmissionError) {
      const stage = reason.stage === "simulation"
        ? "simulation"
        : reason.stage === "confirmation"
          ? "confirmation"
          : reason.stage === "wallet"
            ? "wallet"
            : "price";
      throw rfqFailure(stage, `rfq_pyth_${reason.stage}_failed`, reason);
    }
    const message = reason instanceof Error ? reason.message : "";
    if (/simulation_failed/i.test(message)) throw rfqFailure("simulation", "rfq_simulation_failed", reason);
    if (/tee_|undelegate_oracle/i.test(message)) throw rfqFailure("tee", "rfq_tee_recovery_failed", reason);
    if (/429|too many requests|rate limit/i.test(message)) throw rfqFailure("state", "rfq_base_rpc_rate_limited", reason);
    throw rfqFailure("state", "rfq_setup_failed", reason);
  }
}

async function openRfqOnchainInner(input: OpenRfqInput) {
  input.onProgress?.("Checking RFQ state on Base…");
  const wallet = window.solana;
  if (!wallet) throw new Error("solana_wallet_not_found");
  if (!wallet.signTransaction) throw new Error("wallet_transaction_signing_unavailable");
  const connected = wallet.publicKey ? { publicKey: wallet.publicKey } : await wallet.connect();
  const player = new PublicKey(connected.publicKey);
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  const baseRpcUrl = input.baseRpcUrl ?? input.rpcUrl ?? "https://api.devnet.solana.com";
  const teeRpcUrl = input.teeRpcUrl ?? "https://devnet-tee.magicblock.app";
  const baseConnection = createBaseRpcConnection(baseRpcUrl);
  const match = new PublicKey(input.matchAddress);
  const matchInfo = await baseConnection.getAccountInfo(match, "confirmed");
  if (!matchInfo) throw new Error("match_account_unavailable");
  if (!matchInfo.owner.equals(programId)) throw new Error("match_account_must_be_on_base");

  const matchSnapshot = decodePublicMatchAccount(input.matchAddress, matchInfo.data);
  if (matchSnapshot.status !== "STARTED") throw new Error("match_not_started");
  if (matchSnapshot.currentRound !== input.round) throw new Error("round_state_mismatch");
  const host = new PublicKey(input.hostAddress ?? matchSnapshot.host ?? matchSnapshot.players[0]);
  const taker = new PublicKey(matchSnapshot.taker ?? matchSnapshot.players[input.round % matchSnapshot.playerCount]);
  if (!taker.equals(player)) throw new Error("taker_wallet_mismatch");

  const validator = teeValidatorForRpc(teeRpcUrl);
  const oracleAddress = oraclePda(programId);
  const roundAddress = roundPda(input.matchAddress, input.round, programId);
  const [roundInfo, initialOracleInfo] = await Promise.all([
    baseConnection.getAccountInfo(roundAddress, "confirmed"),
    baseConnection.getAccountInfo(oracleAddress, "confirmed"),
  ]);
  let oracleInfo = initialOracleInfo;
  const baseInstructions: TransactionInstruction[] = [];

  if (!roundInfo || !roundInfo.owner.equals(programId) || roundInfo.data.length < 100 || roundInfo.data[99] !== 2) {
    throw new Error("rfq_round_not_prepared");
  }

  if (!oracleInfo) {
    if (!host.equals(player)) throw new Error("oracle_initialization_required_host");
    baseInstructions.push(createInitializeOracleUnpricedInstruction({
      authorityAddress: host.toBase58(),
      programId: programId.toBase58(),
    }));
  } else if (oracleInfo.owner.equals(programId)) {
    if (oracleInfo.data.length < 89) throw new Error("oracle_account_invalid");
  } else if (!oracleInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
    throw new Error("oracle_account_invalid_owner");
  } else {
    input.onProgress?.("Restoring the RFQ oracle to Base…");
    if (!wallet.signMessage) throw new Error("wallet_message_signing_unavailable");
    const session = await createPrivateConnection({
      teeRpcUrl,
      publicKey: player,
      signMessage: async (message) => {
        const signed = await wallet.signMessage!(message);
        return signed instanceof Uint8Array ? signed : signed.signature;
      },
    });
    const feePayer = await ensureTeeFeePayer({
      baseRpcUrl,
      teeRpcUrl,
      teeConnection: session.connection,
      player,
      wallet,
      programId,
    });
    await sendTeeTransaction({
      connection: session.connection,
      feePayer,
      instructions: [createUndelegateOracleInstruction({
        oracleAddress,
        payer: feePayer.publicKey,
        magicFeeVaultAddress: magicFeeVaultPdaFromValidator(validator).toBase58(),
        programId: programId.toBase58(),
      })],
      label: "undelegate_oracle",
    });
    await waitForBaseProgramAccount(baseConnection, oracleAddress, programId);
    oracleInfo = await baseConnection.getAccountInfo(oracleAddress, "confirmed");
    if (!oracleInfo || !oracleInfo.owner.equals(programId) || oracleInfo.data.length < 89) {
      throw new Error("oracle_restore_not_confirmed");
    }
  }

  const posted = await postPythPriceAndConsume({
    connection: baseConnection,
    wallet,
    feedId: ORACLE_FEED_ID_HEX,
    priceUpdates: input.priceUpdates,
    onProgress: input.onProgress,
    createConsumerInstructions: (priceUpdate) => [
      ...baseInstructions,
      createUpdateOracleInstruction({
        authorityAddress: player.toBase58(),
        priceUpdateAddress: priceUpdate.toBase58(),
        programId: programId.toBase58(),
      }),
      createOpenRfqInstruction({
        matchAddress: input.matchAddress,
        playerAddress: player.toBase58(),
        programId: programId.toBase58(),
        round: input.round,
        side: input.intent.side,
        quantity: input.intent.quantity,
      }),
      createDelegateRoundInstruction({
        matchAddress: input.matchAddress,
        round: input.round,
        authorityAddress: player.toBase58(),
        validator,
        programId: programId.toBase58(),
      }),
    ],
  });

  return { walletAddress: player.toBase58(), signature: posted.signature, baseSignature: posted.signature };
}

export function createSettleMatchInstruction(input: {
  matchAddress: string;
  resultAddress: string;
  winnerAddress: string;
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  const match = new PublicKey(input.matchAddress);
  const result = new PublicKey(input.resultAddress);
  if (!result.equals(resultPda(input.matchAddress, programId))) throw new Error("invalid_result_pda");
  const winner = new PublicKey(input.winnerAddress);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: match, isWritable: false, isSigner: false },
      { pubkey: result, isWritable: true, isSigner: false },
      { pubkey: escrowPda(input.matchAddress, programId), isWritable: true, isSigner: false },
      { pubkey: winner, isWritable: true, isSigner: true },
    ],
    data: Uint8Array.from(SETTLE_MATCH_DISCRIMINATOR) as unknown as Buffer,
  });
}

export function createFinalizeScoresInstruction(input: {
  matchAddress: string;
  resultAddress: string;
  authorityAddress: string;
  remainingAccounts?: TransactionInstruction["keys"];
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  if (!new PublicKey(input.resultAddress).equals(resultPda(input.matchAddress, programId))) throw new Error("invalid_result_pda");
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(input.matchAddress), isWritable: false, isSigner: false },
      { pubkey: new PublicKey(input.resultAddress), isWritable: true, isSigner: false },
      { pubkey: oraclePda(programId), isWritable: false, isSigner: false },
      { pubkey: new PublicKey(input.authorityAddress), isWritable: false, isSigner: true },
      ...(input.remainingAccounts ?? []),
    ],
    data: Buffer.from(FINALIZE_SCORES_DISCRIMINATOR),
  });
}

export async function settleMatchOnchain(input: {
  rpcUrl: string;
  matchAddress: string;
  resultAddress: string;
  winnerAddress: string;
  programId?: string;
}) {
  const wallet = window.solana;
  if (!wallet) throw new Error("solana_wallet_not_found");
  const connected = wallet.publicKey ? { publicKey: wallet.publicKey } : await wallet.connect();
  const winner = new PublicKey(connected.publicKey);
  if (winner.toBase58() !== input.winnerAddress) throw new Error("settlement_wallet_mismatch");
  const programId = input.programId ?? PROGRAM_ID.toBase58();
  const connection = createBaseRpcConnection(input.rpcUrl);
  const escrow = escrowPda(input.matchAddress, new PublicKey(programId));
  const escrowInfo = await connection.getAccountInfo(escrow, "confirmed");
  if (!escrowInfo) throw new Error("settlement_escrow_missing_release_required");
  const transaction = new Transaction().add(createSettleMatchInstruction({ ...input, programId }));
  transaction.feePayer = winner;
  const blockhash = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) {
    const relevantLog = simulation.value.logs?.find((log) => /Error|failed|constraint|insufficient|escrow/i.test(log));
    throw new Error(`settle_match_simulation_failed: ${relevantLog ?? JSON.stringify(simulation.value.err)}`);
  }
  const sent = await wallet.signAndSendTransaction(transaction);
  const signature = typeof sent === "string" ? sent : sent.signature;
  await connection.confirmTransaction({ signature, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight }, "confirmed");
  return { walletAddress: winner.toBase58(), signature };
}

export function createSubmitQuoteInstruction(input: {
  matchAddress: string;
  dealerAddress: string;
  round: number;
  priceE6: number | bigint;
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  const match = new PublicKey(input.matchAddress);
  const dealer = new PublicKey(input.dealerAddress);
  const priceE6 = BigInt(input.priceE6);
  if (priceE6 <= 0n || priceE6 > 9_223_372_036_854_775_807n) throw new Error("invalid_quote_price");
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: match, isWritable: false, isSigner: false },
      { pubkey: roundPda(input.matchAddress, input.round, programId), isWritable: true, isSigner: false },
      { pubkey: privateQuotePda({ matchAddress: match, round: input.round, dealer, programId }), isWritable: true, isSigner: false },
      { pubkey: dealer, isWritable: false, isSigner: true },
    ],
    data: Uint8Array.from([
      ...SUBMIT_QUOTE_DISCRIMINATOR,
      ...integerBytes(priceE6, true),
    ]) as unknown as Buffer,
  });
}

export function createAuthorizeQuoteSessionInstruction(input: {
  matchAddress: string;
  authorityAddress: string;
  sessionKey: PublicKey;
  programId?: PublicKey;
}) {
  const programId = input.programId ?? PROGRAM_ID;
  const authority = new PublicKey(input.authorityAddress);
  const sessionGrant = sessionGrantPda({
    matchAddress: input.matchAddress,
    authorityAddress: authority.toBase58(),
    sessionKey: input.sessionKey,
    programId,
  });
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(input.matchAddress), isWritable: false, isSigner: false },
      { pubkey: sessionGrant, isWritable: true, isSigner: false },
      { pubkey: authority, isWritable: true, isSigner: true },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
    ],
    data: Uint8Array.from([
      ...AUTHORIZE_SESSION_DISCRIMINATOR,
      ...input.sessionKey.toBytes(),
      ...integerBytes(QUOTE_SESSION_DURATION_SECONDS, true),
      QUOTE_SESSION_ACTION,
    ]) as unknown as Buffer,
  });
}

export function createSubmitQuoteSessionInstruction(input: {
  matchAddress: string;
  dealerAddress: string;
  round: number;
  priceE6: number | bigint;
  sessionKey: PublicKey;
  programId?: string | PublicKey;
}) {
  const programId = input.programId instanceof PublicKey
    ? input.programId
    : new PublicKey(input.programId ?? PROGRAM_ID);
  const dealer = new PublicKey(input.dealerAddress);
  const priceE6 = BigInt(input.priceE6);
  if (priceE6 <= 0n || priceE6 > 9_223_372_036_854_775_807n) throw new Error("invalid_quote_price");
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(input.matchAddress), isWritable: false, isSigner: false },
      { pubkey: roundPda(input.matchAddress, input.round, programId), isWritable: true, isSigner: false },
      { pubkey: dealer, isWritable: false, isSigner: false },
      { pubkey: privateQuotePda({ matchAddress: new PublicKey(input.matchAddress), round: input.round, dealer, programId }), isWritable: true, isSigner: false },
      { pubkey: input.sessionKey, isWritable: false, isSigner: true },
      { pubkey: sessionGrantPda({ matchAddress: input.matchAddress, authorityAddress: dealer.toBase58(), sessionKey: input.sessionKey, programId }), isWritable: false, isSigner: false },
    ],
    data: Uint8Array.from([
      ...SUBMIT_QUOTE_SESSION_DISCRIMINATOR,
      ...integerBytes(priceE6, true),
    ]) as unknown as Buffer,
  });
}

export async function submitPrivateQuoteOnchain(input: {
  baseRpcUrl: string;
  teeRpcUrl: string;
  matchAddress: string;
  dealerAddress: string;
  round: number;
  priceE6: number | bigint;
  programId?: string;
}) {
  const wallet = window.solana;
  if (!wallet) throw new Error("solana_wallet_not_found");
  const connected = wallet.publicKey ? { publicKey: wallet.publicKey } : await wallet.connect();
  const dealer = new PublicKey(connected.publicKey);
  if (dealer.toBase58() !== input.dealerAddress) throw new Error("quote_wallet_mismatch");
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  const { connection, feePayer } = getPreparedPrivateQuote({
    teeRpcUrl: input.teeRpcUrl,
    matchAddress: new PublicKey(input.matchAddress),
    dealer,
    round: input.round,
    programId,
  });
  const session = getPreparedQuoteSession({
    baseRpcUrl: input.baseRpcUrl,
    matchAddress: input.matchAddress,
    dealer,
    programId,
  });
  const signature = await sendTeeTransaction({
    connection,
    feePayer,
    additionalSigners: [session.signer],
    instructions: [createSubmitQuoteSessionInstruction({
      ...input,
      dealerAddress: dealer.toBase58(),
      sessionKey: session.signer.publicKey,
      programId,
    })],
    label: "submit_quote_session",
  });
  return { walletAddress: dealer.toBase58(), signature };
}

export async function preparePrivateQuoteOnchain(input: {
  baseRpcUrl: string;
  teeRpcUrl: string;
  matchAddress: string;
  dealerAddress: string;
  round: number;
  programId?: string;
}) {
  const wallet = window.solana;
  if (!wallet?.signTransaction) throw new Error("wallet_transaction_signing_unavailable");
  const connected = wallet.publicKey ? { publicKey: wallet.publicKey } : await wallet.connect();
  const dealer = new PublicKey(connected.publicKey);
  if (dealer.toBase58() !== input.dealerAddress) throw new Error("quote_wallet_mismatch");

  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  const baseConnection = createBaseRpcConnection(input.baseRpcUrl);
  const roundInfo = await baseConnection.getAccountInfo(roundPda(input.matchAddress, input.round, programId), "confirmed");
  if (!roundInfo?.owner.equals(programId) || roundInfo.data.length < 100 || roundInfo.data[99] !== 2) {
    throw new Error("private_quote_preparation_requires_prepared_round");
  }
  await preparePrivateQuote({
    baseRpcUrl: input.baseRpcUrl,
    teeRpcUrl: input.teeRpcUrl,
    matchAddress: new PublicKey(input.matchAddress),
    dealer,
    round: input.round,
    wallet,
    programId,
  });
  await prepareQuoteSession({
    baseConnection,
    wallet,
    baseRpcUrl: input.baseRpcUrl,
    matchAddress: input.matchAddress,
    dealer,
    programId,
  });
  return { walletAddress: dealer.toBase58() };
}

export function createResolveRoundInstruction(input: {
  matchAddress: string;
  round: number;
  takerAddress: string;
  resolverAddress: string;
  remainingAccounts?: TransactionInstruction["keys"];
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(input.matchAddress), isWritable: false, isSigner: false },
      { pubkey: roundPda(input.matchAddress, input.round, programId), isWritable: true, isSigner: false },
      { pubkey: privateInventoryPda({ matchAddress: new PublicKey(input.matchAddress), player: new PublicKey(input.takerAddress), programId }), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.resolverAddress), isWritable: false, isSigner: true },
      ...(input.remainingAccounts ?? []),
    ],
    data: Buffer.from(RESOLVE_ROUND_DISCRIMINATOR),
  });
}

export function createSkipEmptyRoundInstruction(input: {
  matchAddress: string;
  round: number;
  authorityAddress: string;
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(input.matchAddress), isWritable: false, isSigner: false },
      { pubkey: roundPda(input.matchAddress, input.round, programId), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.authorityAddress), isWritable: false, isSigner: true },
    ],
    data: Buffer.from(SKIP_EMPTY_ROUND_DISCRIMINATOR),
  });
}

export function createUndelegateRoundInstruction(input: {
  roundAddress: PublicKey;
  payer: PublicKey;
  magicFeeVaultAddress: string;
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: input.payer, isWritable: true, isSigner: true },
      { pubkey: input.roundAddress, isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.magicFeeVaultAddress), isWritable: true, isSigner: false },
      { pubkey: MAGIC_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: MAGIC_CONTEXT_ID, isWritable: true, isSigner: false },
    ],
    data: Buffer.from(UNDELEGATE_ROUND_DISCRIMINATOR),
  });
}

export function createUndelegatePrivateQuoteInstruction(input: {
  quoteAddress: PublicKey;
  payer: PublicKey;
  magicFeeVaultAddress: string;
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: input.payer, isWritable: true, isSigner: true },
      { pubkey: input.quoteAddress, isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.magicFeeVaultAddress), isWritable: true, isSigner: false },
      { pubkey: MAGIC_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: MAGIC_CONTEXT_ID, isWritable: true, isSigner: false },
    ],
    data: Buffer.from(UNDELEGATE_PRIVATE_QUOTE_DISCRIMINATOR),
  });
}

export function createUndelegatePrivateInventoryInstruction(input: {
  inventoryAddress: PublicKey;
  payer: PublicKey;
  magicFeeVaultAddress: string;
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: input.payer, isWritable: true, isSigner: true },
      { pubkey: input.inventoryAddress, isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.magicFeeVaultAddress), isWritable: true, isSigner: false },
      { pubkey: MAGIC_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: MAGIC_CONTEXT_ID, isWritable: true, isSigner: false },
    ],
    data: Buffer.from(UNDELEGATE_PRIVATE_INVENTORY_DISCRIMINATOR),
  });
}

export function createUndelegateOracleInstruction(input: {
  oracleAddress: PublicKey;
  payer: PublicKey;
  magicFeeVaultAddress: string;
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: input.payer, isWritable: true, isSigner: true },
      { pubkey: input.oracleAddress, isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.magicFeeVaultAddress), isWritable: true, isSigner: false },
      { pubkey: MAGIC_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: MAGIC_CONTEXT_ID, isWritable: true, isSigner: false },
    ],
    data: Buffer.from(UNDELEGATE_ORACLE_DISCRIMINATOR),
  });
}

export function createNextRoundInstruction(input: {
  matchAddress: string;
  round: number;
  authorityAddress: string;
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(input.matchAddress), isWritable: true, isSigner: false },
      { pubkey: roundPda(input.matchAddress, input.round, programId), isWritable: false, isSigner: false },
      { pubkey: new PublicKey(input.authorityAddress), isWritable: false, isSigner: true },
    ],
    data: Buffer.from(NEXT_ROUND_DISCRIMINATOR),
  });
}

async function waitForBaseProgramAccount(connection: Connection, address: PublicKey, programId: PublicKey) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const info = await connection.getAccountInfo(address, "confirmed");
    if (info?.owner.equals(programId)) return;
    if (attempt + 1 < 20) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("round_undelegation_not_confirmed");
}

async function waitForDelegatedAccounts(connection: Connection, accounts: Record<string, PublicKey>) {
  const entries = Object.entries(accounts);
  let unavailable: string[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const infos = await connection.getMultipleAccountsInfo(entries.map(([, address]) => address), "confirmed");
    unavailable = entries.flatMap(([label], index) => infos[index]?.owner.equals(DELEGATION_PROGRAM_ID) ? [] : [`${label}_not_delegated`]);
    if (unavailable.length === 0) return;
    if (attempt + 1 < 20) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`rfq_state_not_ready:${unavailable.join(",")}`);
}

export async function resolveRoundOnchain(input: {
  baseRpcUrl: string;
  teeRpcUrl: string;
  matchAddress: string;
  round: number;
  resolverAddress: string;
  snapshot: ReturnType<typeof decodePublicMatchAccount>;
  priceUpdates?: string[];
  programId?: string;
}) {
  const wallet = window.solana;
  if (!wallet?.signTransaction) throw new Error("wallet_transaction_signing_unavailable");
  if (!wallet.signMessage) throw new Error("wallet_message_signing_unavailable");
  const connected = wallet.publicKey ? { publicKey: wallet.publicKey } : await wallet.connect();
  const resolver = new PublicKey(connected.publicKey);
  if (!resolver.equals(new PublicKey(input.resolverAddress))) throw new Error("resolver_wallet_mismatch");
  if (input.snapshot.host !== resolver.toBase58()) throw new Error("resolver_must_be_host");
  if (input.snapshot.stateSource !== "tee") throw new Error("live_tee_round_state_unavailable");
  if (input.snapshot.status !== "STARTED" || input.snapshot.roundStatus !== "OPEN") throw new Error("round_not_open");
  if (input.snapshot.currentRound !== input.round || !input.snapshot.taker) throw new Error("round_state_mismatch");
  if (input.snapshot.quoteCount === 0) throw new Error("empty_round_requires_skip");
  if (input.snapshot.quoteCount < input.snapshot.dealerCount && (!input.snapshot.deadlineAt || Date.now() < input.snapshot.deadlineAt)) {
    throw new Error("quotes_not_complete");
  }

  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  const match = new PublicKey(input.matchAddress);
  const taker = new PublicKey(input.snapshot.taker);
  const dealerAddresses = input.snapshot.players
    .map((player) => new PublicKey(player))
    .filter((player) => !player.equals(taker));
  const quoteAddresses = dealerAddresses.map((dealer) => privateQuotePda({ matchAddress: match, round: input.round, dealer, programId }));
  const inventoryAddresses = input.snapshot.players.map((player) => privateInventoryPda({ matchAddress: match, player: new PublicKey(player), programId }));
  const roundAddress = roundPda(input.matchAddress, input.round, programId);
  const baseConnection = createBaseRpcConnection(input.baseRpcUrl);
  const takerInventory = inventoryAddresses[input.snapshot.players.indexOf(taker.toBase58())];
  if (!takerInventory) throw new Error("taker_inventory_unavailable");
  const quoteInfos = await baseConnection.getMultipleAccountsInfo(quoteAddresses, "confirmed");
  const delegatedQuoteAddresses = quoteAddresses.filter((_, index) => quoteInfos[index]?.owner.equals(DELEGATION_PROGRAM_ID));
  if (delegatedQuoteAddresses.length < input.snapshot.quoteCount) throw new Error("sealed_quote_state_unavailable");

  // Inventory state is still needed to settle the unknown winning dealer inside the TEE.
  // Quote accounts are optional: unlocked prepared quotes are valid inputs but are ignored onchain.
  await waitForDelegatedAccounts(baseConnection, {
    round: roundAddress,
    taker_inventory: takerInventory,
    ...Object.fromEntries(inventoryAddresses.map((address, index) => [`inventory_${index}`, address])),
  });

  const session = await createPrivateConnection({
    teeRpcUrl: input.teeRpcUrl,
    publicKey: resolver,
    signMessage: async (message) => {
      const signed = await wallet.signMessage!(message);
      return signed instanceof Uint8Array ? signed : signed.signature;
    },
  });
  const feePayer = await ensureTeeFeePayer({
    baseRpcUrl: input.baseRpcUrl,
    teeRpcUrl: input.teeRpcUrl,
    teeConnection: session.connection,
    player: resolver,
    wallet,
    programId,
  });
  const magicFeeVaultAddress = magicFeeVaultPdaFromValidator(teeValidatorForRpc(input.teeRpcUrl)).toBase58();

  const remainingAccounts = [
    ...delegatedQuoteAddresses.map((pubkey) => ({ pubkey, isWritable: false, isSigner: false })),
    ...inventoryAddresses.filter((address) => !address.equals(takerInventory)).map((pubkey) => ({ pubkey, isWritable: true, isSigner: false })),
  ];
  await sendTeeTransaction({
    connection: session.connection,
    wallet,
    feePayer,
    instructions: [createResolveRoundInstruction({
      matchAddress: input.matchAddress,
      round: input.round,
      takerAddress: taker.toBase58(),
      resolverAddress: resolver.toBase58(),
      remainingAccounts,
      programId: programId.toBase58(),
    })],
    label: "resolve_round",
  });
  await sendTeeTransaction({
    connection: session.connection,
    feePayer,
    instructions: [createUndelegateRoundInstruction({ roundAddress, payer: feePayer.publicKey, magicFeeVaultAddress, programId: programId.toBase58() })],
    label: "undelegate_round",
  });
  await sendTeeTransaction({
    connection: session.connection,
    feePayer,
    instructions: delegatedQuoteAddresses.map((quoteAddress) => createUndelegatePrivateQuoteInstruction({
      quoteAddress,
      payer: feePayer.publicKey,
      magicFeeVaultAddress,
      programId: programId.toBase58(),
    })),
    label: "undelegate_quotes",
  });
  await waitForBaseProgramAccount(baseConnection, roundAddress, programId);
  await Promise.all(delegatedQuoteAddresses.map((quoteAddress) => waitForBaseProgramAccount(baseConnection, quoteAddress, programId)));
  const nextRoundSignature = await sendWalletTransaction({
    connection: baseConnection,
    wallet,
    payer: resolver,
    instructions: [createNextRoundInstruction({
      matchAddress: input.matchAddress,
      round: input.round,
      authorityAddress: resolver.toBase58(),
      programId: programId.toBase58(),
    })],
    label: "next_round",
  });
  if (input.round + 1 < input.snapshot.roundCount) return { walletAddress: resolver.toBase58(), nextRoundSignature };

  await sendTeeTransaction({
    connection: session.connection,
    feePayer,
    instructions: inventoryAddresses.map((inventoryAddress) => createUndelegatePrivateInventoryInstruction({
      inventoryAddress,
      payer: feePayer.publicKey,
      magicFeeVaultAddress,
      programId: programId.toBase58(),
    })),
    label: "undelegate_inventories",
  });
  await Promise.all(inventoryAddresses.map((inventoryAddress) => waitForBaseProgramAccount(baseConnection, inventoryAddress, programId)));
  const resultAddress = resultPda(input.matchAddress, programId);
  if (!input.priceUpdates?.length) throw new Error("final_score_price_update_required");
  const posted = await postPythPriceAndConsume({
    connection: baseConnection,
    wallet,
    feedId: ORACLE_FEED_ID_HEX,
    priceUpdates: input.priceUpdates,
    label: "final score price update",
    createConsumerInstructions: (priceUpdate) => [
      createUpdateOracleInstruction({
        authorityAddress: resolver.toBase58(),
        priceUpdateAddress: priceUpdate.toBase58(),
        programId: programId.toBase58(),
      }),
      createFinalizeScoresInstruction({
        matchAddress: input.matchAddress,
        resultAddress: resultAddress.toBase58(),
        authorityAddress: resolver.toBase58(),
        remainingAccounts: inventoryAddresses.map((pubkey) => ({ pubkey, isWritable: false, isSigner: false })),
        programId: programId.toBase58(),
      }),
    ],
  });
  return { walletAddress: resolver.toBase58(), nextRoundSignature, finalizeSignature: posted.signature };
}

type EmptyRoundInput = {
  baseRpcUrl: string;
  teeRpcUrl: string;
  matchAddress: string;
  round: number;
  authorityAddress: string;
  snapshot: ReturnType<typeof decodePublicMatchAccount>;
  programId?: string;
};

async function emptyRoundOnchain(input: EmptyRoundInput, action: "skip" | "resume") {
  const wallet = window.solana;
  if (!wallet?.signTransaction) throw new Error("wallet_transaction_signing_unavailable");
  if (!wallet.signMessage) throw new Error("wallet_message_signing_unavailable");
  const connected = wallet.publicKey ? { publicKey: wallet.publicKey } : await wallet.connect();
  const authority = new PublicKey(connected.publicKey);
  if (!authority.equals(new PublicKey(input.authorityAddress))) throw new Error("skip_wallet_mismatch");
  if (input.snapshot.host !== authority.toBase58()) throw new Error("skip_must_be_host");
  if (input.snapshot.stateSource !== "tee") throw new Error("live_tee_round_state_unavailable");
  if (input.snapshot.status !== "STARTED") throw new Error("round_not_started");
  if (action === "skip" && input.snapshot.roundStatus !== "OPEN") throw new Error("round_not_open");
  if (action === "resume" && input.snapshot.roundStatus !== "SKIPPED") throw new Error("skipped_round_required");
  if (input.snapshot.currentRound !== input.round || !input.snapshot.taker) throw new Error("round_state_mismatch");
  if (input.snapshot.quoteCount !== 0) throw new Error("empty_round_required");
  if (action === "skip" && (!input.snapshot.deadlineAt || Date.now() < input.snapshot.deadlineAt)) throw new Error("skip_deadline_not_reached");

  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  const match = new PublicKey(input.matchAddress);
  const roundAddress = roundPda(input.matchAddress, input.round, programId);
  const baseConnection = createBaseRpcConnection(input.baseRpcUrl);
  await waitForDelegatedAccounts(baseConnection, { round: roundAddress });

  const session = await createPrivateConnection({
    teeRpcUrl: input.teeRpcUrl,
    publicKey: authority,
    signMessage: async (message) => {
      const signed = await wallet.signMessage!(message);
      return signed instanceof Uint8Array ? signed : signed.signature;
    },
  });
  const feePayer = await ensureTeeFeePayer({
    baseRpcUrl: input.baseRpcUrl,
    teeRpcUrl: input.teeRpcUrl,
    teeConnection: session.connection,
    player: authority,
    wallet,
    programId,
  });
  const magicFeeVaultAddress = magicFeeVaultPdaFromValidator(teeValidatorForRpc(input.teeRpcUrl)).toBase58();

  if (action === "skip") {
    await sendTeeTransaction({
      connection: session.connection,
      wallet,
      feePayer,
      instructions: [createSkipEmptyRoundInstruction({
        matchAddress: input.matchAddress,
        round: input.round,
        authorityAddress: authority.toBase58(),
        programId: programId.toBase58(),
      })],
      label: "skip_empty_round",
    });
  }
  await sendTeeTransaction({
    connection: session.connection,
    feePayer,
    instructions: [createUndelegateRoundInstruction({
      roundAddress,
      payer: feePayer.publicKey,
      magicFeeVaultAddress,
      programId: programId.toBase58(),
    })],
    label: "undelegate_skipped_round",
  });

  const quoteAddresses = input.snapshot.players
    .map((player) => new PublicKey(player))
    .filter((player) => !player.equals(new PublicKey(input.snapshot.taker!)))
    .map((dealer) => privateQuotePda({ matchAddress: match, round: input.round, dealer, programId }));
  const quoteInfos = await baseConnection.getMultipleAccountsInfo(quoteAddresses, "confirmed");
  const delegatedQuoteAddresses = quoteAddresses.filter((_, index) => quoteInfos[index]?.owner.equals(DELEGATION_PROGRAM_ID));
  if (delegatedQuoteAddresses.length > 0) {
    await sendTeeTransaction({
      connection: session.connection,
      feePayer,
      instructions: delegatedQuoteAddresses.map((quoteAddress) => createUndelegatePrivateQuoteInstruction({
        quoteAddress,
        payer: feePayer.publicKey,
        magicFeeVaultAddress,
        programId: programId.toBase58(),
      })),
      label: "undelegate_empty_round_quotes",
    });
  }

  await waitForBaseProgramAccount(baseConnection, roundAddress, programId);
  await Promise.all(delegatedQuoteAddresses.map((quoteAddress) => waitForBaseProgramAccount(baseConnection, quoteAddress, programId)));
  const nextRoundSignature = await sendWalletTransaction({
    connection: baseConnection,
    wallet,
    payer: authority,
    instructions: [createNextRoundInstruction({
      matchAddress: input.matchAddress,
      round: input.round,
      authorityAddress: authority.toBase58(),
      programId: programId.toBase58(),
    })],
    label: "next_round_after_skip",
  });
  return { walletAddress: authority.toBase58(), nextRoundSignature };
}

export function skipEmptyRoundOnchain(input: EmptyRoundInput) {
  return emptyRoundOnchain(input, "skip");
}

export function resumeSkippedRoundOnchain(input: EmptyRoundInput) {
  return emptyRoundOnchain(input, "resume");
}
