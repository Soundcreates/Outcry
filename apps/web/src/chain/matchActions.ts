import {
  ConnectionMagicRouter,
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
import { createPrivateConnection, ensureTeeFeePayer, privateQuotePda, teeValidatorForRpc } from "./privacy";
import { decodePublicMatchAccount, ORACLE_FEED_ID, ORACLE_PRICE_UPDATE_ADDRESS, escrowPda, oraclePda, resultPda, roundPda } from "./matchState";
import type { TradeIntent } from "../match/tradeIntent";

const OPEN_RFQ_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "open_rfq")?.discriminator ?? []);
const INITIALIZE_ORACLE_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "initialize_oracle")?.discriminator ?? []);
const INITIALIZE_ORACLE_UNPRICED_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "initialize_oracle_unpriced")?.discriminator ?? []);
const PREPARE_RFQ_ROUND_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "prepare_rfq_round")?.discriminator ?? []);
const DELEGATE_MATCH_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "delegate_match")?.discriminator ?? []);
const DELEGATE_ROUND_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "delegate_round")?.discriminator ?? []);
const DELEGATE_ORACLE_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "delegate_oracle")?.discriminator ?? []);
const UPDATE_ORACLE_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "update_oracle")?.discriminator ?? []);
const COMMIT_RFQ_STATE_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "commit_rfq_state")?.discriminator ?? []);
const START_MATCH_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "start_match")?.discriminator ?? []);
const MIGRATE_LEGACY_MATCH_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "migrate_legacy_match")?.discriminator ?? []);
const SETTLE_MATCH_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "settle_match")?.discriminator ?? []);
const SUBMIT_QUOTE_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "submit_quote")?.discriminator ?? []);
const PROGRAM_ID = new PublicKey(outcryIdl.address);
const MAGIC_ROUTER_DEVNET_RPC = "https://devnet-router.magicblock.app";

type AccountInfoConnection = Pick<Connection, "getMultipleAccountsInfo">;

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

async function sendRoutedTransaction(input: {
  connection: ConnectionMagicRouter;
  wallet: { signTransaction?: (transaction: Transaction) => Promise<Transaction> };
  feePayer: Keypair;
  instructions: TransactionInstruction[];
  label: string;
}) {
  if (!input.wallet.signTransaction) throw new Error("wallet_transaction_signing_unavailable");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const transaction = new Transaction().add(...input.instructions);
    transaction.feePayer = input.feePayer.publicKey;
    const blockhash = await input.connection.getLatestBlockhashForTransaction(transaction, { commitment: "confirmed" });
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
  const connection = new Connection(input.rpcUrl, "confirmed");
  const matchInfo = await connection.getAccountInfo(new PublicKey(input.matchAddress), "confirmed");
  if (!matchInfo) throw new Error("match_account_unavailable");
  const transaction = new Transaction();
  if (matchInfo.data.length === 372) {
    transaction.add(createMigrateLegacyMatchInstruction({ ...input, hostAddress: authority.toBase58() }));
  }
  transaction.add(createStartMatchInstruction({ ...input, hostAddress: authority.toBase58() }));
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
  programId?: string;
  priceUpdateAddress?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  const authority = new PublicKey(input.authorityAddress);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: oraclePda(programId), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.priceUpdateAddress ?? ORACLE_PRICE_UPDATE_ADDRESS), isWritable: false, isSigner: false },
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

export function createDelegateMatchInstruction(input: {
  matchAddress: string;
  pitAddress: string;
  matchNonce: bigint;
  authorityAddress: string;
  validator: PublicKey;
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  const match = new PublicKey(input.matchAddress);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(input.authorityAddress), isWritable: false, isSigner: true },
      ...delegatedAccountKeys(match, programId, input.validator),
    ],
    data: Buffer.from([
      ...DELEGATE_MATCH_DISCRIMINATOR,
      ...new PublicKey(input.pitAddress).toBytes(),
      ...integerBytes(input.matchNonce),
    ]),
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

export function createDelegateOracleInstruction(input: {
  authorityAddress: string;
  validator: PublicKey;
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  const oracle = oraclePda(programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(input.authorityAddress), isWritable: false, isSigner: true },
      ...delegatedAccountKeys(oracle, programId, input.validator),
    ],
    data: Buffer.from([...DELEGATE_ORACLE_DISCRIMINATOR, ...ORACLE_FEED_ID]),
  });
}

export function createUpdateOracleInstruction(input: {
  authorityAddress: string;
  programId?: string;
  priceUpdateAddress?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: oraclePda(programId), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.priceUpdateAddress ?? ORACLE_PRICE_UPDATE_ADDRESS), isWritable: false, isSigner: false },
      { pubkey: new PublicKey(input.authorityAddress), isWritable: false, isSigner: true },
    ],
    data: Buffer.from(UPDATE_ORACLE_DISCRIMINATOR),
  });
}

export function createCommitRfqStateInstruction(input: {
  matchAddress: string;
  round: number;
  payer: PublicKey;
  magicFeeVaultAddress: string;
  programId?: string;
}) {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: input.payer, isWritable: true, isSigner: true },
      { pubkey: new PublicKey(input.matchAddress), isWritable: true, isSigner: false },
      { pubkey: roundPda(input.matchAddress, input.round, programId), isWritable: true, isSigner: false },
      { pubkey: oraclePda(programId), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.magicFeeVaultAddress), isWritable: true, isSigner: false },
      { pubkey: MAGIC_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: MAGIC_CONTEXT_ID, isWritable: true, isSigner: false },
    ],
    data: Buffer.from(COMMIT_RFQ_STATE_DISCRIMINATOR),
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
  const quoteWindowSeconds = input.quoteWindowSeconds ?? 10;
  if (!Number.isInteger(quoteWindowSeconds) || quoteWindowSeconds < 1 || quoteWindowSeconds > 30) throw new Error("invalid_quote_window");
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: match, isWritable: true, isSigner: false },
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

export async function openRfqOnchain(input: {
  rpcUrl?: string;
  baseRpcUrl?: string;
  teeRpcUrl?: string;
  magicRouterRpcUrl?: string;
  matchAddress: string;
  hostAddress?: string;
  programId?: string;
  round: number;
  intent: TradeIntent;
}) {
  const wallet = window.solana;
  if (!wallet) throw new Error("solana_wallet_not_found");
  if (!wallet.signTransaction) throw new Error("wallet_transaction_signing_unavailable");
  const connected = wallet.publicKey ? { publicKey: wallet.publicKey } : await wallet.connect();
  const player = new PublicKey(connected.publicKey);
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  const baseRpcUrl = input.baseRpcUrl ?? input.rpcUrl ?? "https://api.devnet.solana.com";
  const teeRpcUrl = input.teeRpcUrl ?? "https://devnet-tee.magicblock.app";
  const magicRouterRpcUrl = input.magicRouterRpcUrl ?? MAGIC_ROUTER_DEVNET_RPC;
  const baseConnection = new Connection(baseRpcUrl, "confirmed");
  const match = new PublicKey(input.matchAddress);
  const matchInfo = await baseConnection.getAccountInfo(match, "confirmed");
  if (!matchInfo) throw new Error("match_account_unavailable");
  const matchOwnerIsBase = matchInfo.owner.equals(programId);
  const matchOwnerIsDelegated = matchInfo.owner.equals(DELEGATION_PROGRAM_ID);
  if (!matchOwnerIsBase && !matchOwnerIsDelegated) throw new Error("match_account_invalid_owner");

  const matchSnapshot = decodePublicMatchAccount(input.matchAddress, matchInfo.data);
  if (matchSnapshot.status !== "STARTED") throw new Error("match_not_started");
  if (matchSnapshot.currentRound !== input.round) throw new Error("round_state_mismatch");
  const host = new PublicKey(input.hostAddress ?? matchSnapshot.host ?? matchSnapshot.players[0]);
  const taker = new PublicKey(matchSnapshot.taker ?? matchSnapshot.players[input.round % matchSnapshot.playerCount]);
  if (!taker.equals(player)) throw new Error("taker_wallet_mismatch");

  const validator = teeValidatorForRpc(teeRpcUrl);
  const oracleAddress = oraclePda(programId);
  const roundAddress = roundPda(input.matchAddress, input.round, programId);
  const [roundInfo, oracleInfo] = await Promise.all([
    baseConnection.getAccountInfo(roundAddress, "confirmed"),
    baseConnection.getAccountInfo(oracleAddress, "confirmed"),
  ]);
  const baseInstructions: TransactionInstruction[] = [];

  if (!roundInfo) {
    if (!matchOwnerIsBase) throw new Error("round_preparation_requires_base_match");
    baseInstructions.push(createPrepareRfqRoundInstruction({
      matchAddress: input.matchAddress,
      takerAddress: player.toBase58(),
      round: input.round,
      programId: programId.toBase58(),
    }));
    baseInstructions.push(createDelegateRoundInstruction({
      matchAddress: input.matchAddress,
      round: input.round,
      authorityAddress: player.toBase58(),
      validator,
      programId: programId.toBase58(),
    }));
  } else if (roundInfo.owner.equals(programId)) {
    baseInstructions.push(createDelegateRoundInstruction({
      matchAddress: input.matchAddress,
      round: input.round,
      authorityAddress: player.toBase58(),
      validator,
      programId: programId.toBase58(),
    }));
  } else if (!roundInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
    throw new Error("round_account_invalid_owner");
  }

  if (!oracleInfo) {
    if (!host.equals(player)) throw new Error("oracle_initialization_required_host");
    baseInstructions.push(createInitializeOracleUnpricedInstruction({
      authorityAddress: host.toBase58(),
      programId: programId.toBase58(),
    }));
    baseInstructions.push(createDelegateOracleInstruction({
      authorityAddress: host.toBase58(),
      validator,
      programId: programId.toBase58(),
    }));
  } else if (oracleInfo.owner.equals(programId)) {
    if (!host.equals(player)) throw new Error("oracle_delegation_required_host");
    if (oracleInfo.data.length < 89) throw new Error("oracle_account_invalid");
    baseInstructions.push(createDelegateOracleInstruction({
      authorityAddress: host.toBase58(),
      validator,
      programId: programId.toBase58(),
    }));
  } else if (!oracleInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
    throw new Error("oracle_account_invalid_owner");
  }

  if (matchOwnerIsBase) {
    if (!host.equals(player)) throw new Error("match_delegation_required_host");
    baseInstructions.push(createDelegateMatchInstruction({
      matchAddress: input.matchAddress,
      pitAddress: matchSnapshot.pit,
      matchNonce: matchSnapshot.matchNonce,
      authorityAddress: host.toBase58(),
      validator,
      programId: programId.toBase58(),
    }));
  }

  let baseSignature: string | undefined;
  if (baseInstructions.length > 0) {
    baseSignature = await sendWalletTransaction({
      connection: baseConnection,
      wallet,
      payer: player,
      instructions: baseInstructions,
      label: "rfq_state_setup",
    });
  }

  const session = await createPrivateConnection({
    teeRpcUrl,
    publicKey: player,
    signMessage: async (message) => {
      if (!wallet.signMessage) throw new Error("wallet_message_signing_unavailable");
      const signed = await wallet.signMessage(message);
      return signed instanceof Uint8Array ? signed : signed.signature;
    },
  });
  const teeFeePayer = await ensureTeeFeePayer({
    baseRpcUrl,
    teeRpcUrl,
    teeConnection: session.connection,
    player,
    wallet,
    programId,
  });
  await waitForRfqExecutionState({
    baseConnection,
    teeConnection: session.connection,
    accounts: { match, round: roundAddress, oracle: oracleAddress },
  });
  const signature = await sendRoutedTransaction({
    connection: new ConnectionMagicRouter(magicRouterRpcUrl, "confirmed"),
    wallet,
    feePayer: teeFeePayer,
    instructions: [
      createUpdateOracleInstruction({ authorityAddress: player.toBase58(), programId: programId.toBase58() }),
      createOpenRfqInstruction({
        matchAddress: input.matchAddress,
        playerAddress: player.toBase58(),
        programId: programId.toBase58(),
        round: input.round,
        side: input.intent.side,
        quantity: input.intent.quantity,
      }),
      createCommitRfqStateInstruction({
        matchAddress: input.matchAddress,
        round: input.round,
        payer: teeFeePayer.publicKey,
        magicFeeVaultAddress: magicFeeVaultPdaFromValidator(validator).toBase58(),
        programId: programId.toBase58(),
      }),
    ],
    label: "open_rfq",
  });
  return { walletAddress: player.toBase58(), signature, baseSignature };
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
  const connection = new Connection(input.rpcUrl, "confirmed");
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
      { pubkey: oraclePda(programId), isWritable: false, isSigner: false },
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
  const session = await createPrivateConnection({
    teeRpcUrl: input.teeRpcUrl,
    publicKey: dealer,
    signMessage: async (message) => {
      if (!wallet.signMessage) throw new Error("wallet_message_signing_unavailable");
      const signed = await wallet.signMessage(message);
      return signed instanceof Uint8Array ? signed : signed.signature;
    },
  });
  const teeFeePayer = await ensureTeeFeePayer({
    baseRpcUrl: input.baseRpcUrl,
    teeRpcUrl: input.teeRpcUrl,
    teeConnection: session.connection,
    player: dealer,
    wallet,
    programId: new PublicKey(input.programId ?? PROGRAM_ID),
  });
  const signature = await sendTeeTransaction({
    connection: session.connection,
    wallet,
    feePayer: teeFeePayer,
    instructions: [createSubmitQuoteInstruction({ ...input, dealerAddress: dealer.toBase58() })],
    label: "submit_quote",
  });
  return { walletAddress: dealer.toBase58(), signature };
}
