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
import { createPrivateConnection, ensurePrivateQuote, ensureTeeFeePayer, privateInventoryPda, privateQuotePda, teeValidatorForRpc } from "./privacy";
import { postPythPriceAndConsume, PythSubmissionError } from "./pyth";
import { decodePublicMatchAccount, ORACLE_FEED_ID, ORACLE_FEED_ID_HEX, escrowPda, oraclePda, resultPda, roundPda } from "./matchState";
import type { TradeIntent } from "../match/tradeIntent";

const OPEN_RFQ_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "open_rfq")?.discriminator ?? []);
const INITIALIZE_ORACLE_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "initialize_oracle")?.discriminator ?? []);
const INITIALIZE_ORACLE_UNPRICED_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "initialize_oracle_unpriced")?.discriminator ?? []);
const INITIALIZE_MATCH_RESULT_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "initialize_match_result")?.discriminator ?? []);
const PREPARE_RFQ_ROUND_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "prepare_rfq_round")?.discriminator ?? []);
const DELEGATE_ROUND_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "delegate_round")?.discriminator ?? []);
const UPDATE_ORACLE_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "update_oracle")?.discriminator ?? []);
const START_MATCH_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "start_match")?.discriminator ?? []);
const MIGRATE_LEGACY_MATCH_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "migrate_legacy_match")?.discriminator ?? []);
const SETTLE_MATCH_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "settle_match")?.discriminator ?? []);
const FINALIZE_SCORES_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "finalize_scores")?.discriminator ?? []);
const SUBMIT_QUOTE_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "submit_quote")?.discriminator ?? []);
const RESOLVE_ROUND_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "resolve_round")?.discriminator ?? []);
const UNDELEGATE_ROUND_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "undelegate_round")?.discriminator ?? []);
const UNDELEGATE_PRIVATE_QUOTE_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "undelegate_private_quote")?.discriminator ?? []);
const UNDELEGATE_PRIVATE_INVENTORY_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "undelegate_private_inventory")?.discriminator ?? []);
const UNDELEGATE_ORACLE_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "undelegate_oracle")?.discriminator ?? []);
const NEXT_ROUND_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "next_round")?.discriminator ?? []);
const PROGRAM_ID = new PublicKey(outcryIdl.address);
export const DEFAULT_QUOTE_WINDOW_SECONDS = 30;

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

async function sendTeeTransaction(input: {
  connection: Connection;
  wallet: { signTransaction?: (transaction: Transaction) => Promise<Transaction> };
  feePayer: Keypair;
  instructions: TransactionInstruction[];
  label: string;
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
      const relevantLog = simulation.value.logs?.find((log) => /AnchorError|Error Code|failed|custom program error/i.test(log));
      throw new Error(`${input.label}_simulation_failed: ${relevantLog ?? JSON.stringify(simulation.value.err)}`);
    }

    try {
      const signed = await input.wallet.signTransaction(transaction);
      const signature = await input.connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 5 });
      const status = await waitForTeeSignature(input.connection, signature);
      if (status.err) throw new Error(`${input.label}_transaction_failed: ${JSON.stringify(status.err)}`);
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
    const status = (await connection.getSignatureStatuses([signature])).value[0];
    if (status?.err || status?.confirmationStatus) return status ?? { err: null };
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
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(input.matchAddress), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.hostAddress), isWritable: false, isSigner: true },
    ],
    data: Uint8Array.from(START_MATCH_DISCRIMINATOR) as unknown as Buffer,
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

export function createMigrateLegacyMatchInstruction(input: {
  matchAddress: string;
  hostAddress: string;
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
  if (matchInfo.data.length === 372) {
    transaction.add(createMigrateLegacyMatchInstruction({ ...input, hostAddress: authority.toBase58() }));
  }
  transaction.add(createStartMatchInstruction({ ...input, hostAddress: authority.toBase58() }));
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
  const matchOwnerIsBase = matchInfo.owner.equals(programId);
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

  if (!roundInfo) {
    if (!matchOwnerIsBase) throw new Error("round_preparation_requires_base_match");
    baseInstructions.push(createPrepareRfqRoundInstruction({
      matchAddress: input.matchAddress,
      takerAddress: player.toBase58(),
      round: input.round,
      programId: programId.toBase58(),
    }));
  } else if (roundInfo.owner.equals(programId)) {
    // The round can be opened on Base and delegated in the same transaction.
  } else if (!roundInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
    throw new Error("round_account_invalid_owner");
  } else {
    throw new Error("round_already_delegated");
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
      wallet,
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
  const transaction = new Transaction().add(createSettleMatchInstruction({ ...input, programId }));
  transaction.feePayer = winner;
  const blockhash = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) throw new Error("settle_match_simulation_failed");
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
  if (!wallet?.signTransaction) throw new Error("wallet_transaction_signing_unavailable");
  const connected = wallet.publicKey ? { publicKey: wallet.publicKey } : await wallet.connect();
  const dealer = new PublicKey(connected.publicKey);
  if (dealer.toBase58() !== input.dealerAddress) throw new Error("quote_wallet_mismatch");
  const { connection, feePayer } = await ensurePrivateQuote({
    baseRpcUrl: input.baseRpcUrl,
    teeRpcUrl: input.teeRpcUrl,
    matchAddress: new PublicKey(input.matchAddress),
    dealer,
    round: input.round,
    wallet,
    programId: new PublicKey(input.programId ?? PROGRAM_ID),
  });
  const signature = await sendTeeTransaction({
    connection,
    wallet,
    feePayer,
    instructions: [createSubmitQuoteInstruction({ ...input, dealerAddress: dealer.toBase58() })],
    label: "submit_quote",
  });
  return { walletAddress: dealer.toBase58(), signature };
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
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const infos = await connection.getMultipleAccountsInfo(entries.map(([, address]) => address), "confirmed");
    const unavailable = entries.flatMap(([label], index) => infos[index]?.owner.equals(DELEGATION_PROGRAM_ID) ? [] : [`${label}_not_delegated`]);
    if (unavailable.length === 0) return;
    if (attempt + 1 < 20) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("rfq_state_not_ready:delegated_private_state");
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
  if (input.snapshot.status !== "STARTED" || input.snapshot.roundStatus !== "OPEN") throw new Error("round_not_open");
  if (input.snapshot.currentRound !== input.round || !input.snapshot.taker) throw new Error("round_state_mismatch");
  if (input.snapshot.quoteCount < input.snapshot.dealerCount) throw new Error("quotes_not_complete");

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
  await waitForDelegatedAccounts(baseConnection, {
    round: roundAddress,
    taker_inventory: inventoryAddresses[input.snapshot.players.indexOf(taker.toBase58())],
    ...Object.fromEntries(quoteAddresses.map((address, index) => [`quote_${index}`, address])),
    ...Object.fromEntries(inventoryAddresses.map((address, index) => [`inventory_${index}`, address])),
  });

  const remainingAccounts = [
    ...quoteAddresses.map((pubkey) => ({ pubkey, isWritable: false, isSigner: false })),
    ...inventoryAddresses.filter((address) => !address.equals(inventoryAddresses[input.snapshot.players.indexOf(taker.toBase58())])).map((pubkey) => ({ pubkey, isWritable: true, isSigner: false })),
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
    wallet,
    feePayer,
    instructions: [createUndelegateRoundInstruction({ roundAddress, payer: feePayer.publicKey, magicFeeVaultAddress, programId: programId.toBase58() })],
    label: "undelegate_round",
  });
  await sendTeeTransaction({
    connection: session.connection,
    wallet,
    feePayer,
    instructions: quoteAddresses.map((quoteAddress) => createUndelegatePrivateQuoteInstruction({
      quoteAddress,
      payer: feePayer.publicKey,
      magicFeeVaultAddress,
      programId: programId.toBase58(),
    })),
    label: "undelegate_quotes",
  });
  await waitForBaseProgramAccount(baseConnection, roundAddress, programId);
  await Promise.all(quoteAddresses.map((quoteAddress) => waitForBaseProgramAccount(baseConnection, quoteAddress, programId)));
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
  if (input.round < 7) return { walletAddress: resolver.toBase58(), nextRoundSignature };

  await sendTeeTransaction({
    connection: session.connection,
    wallet,
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
