import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import outcryIdl from "./idl/outcry.json";
import { createPrivateConnection, privateQuotePda } from "./privacy";
import { escrowPda, oraclePda, resultPda, roundPda } from "./matchState";
import type { TradeIntent } from "../match/tradeIntent";

const OPEN_RFQ_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "open_rfq")?.discriminator ?? []);
const SETTLE_MATCH_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "settle_match")?.discriminator ?? []);
const SUBMIT_QUOTE_DISCRIMINATOR = Uint8Array.from(outcryIdl.instructions.find((instruction) => instruction.name === "submit_quote")?.discriminator ?? []);
const PROGRAM_ID = new PublicKey(outcryIdl.address);

function integerBytes(value: number | bigint, signed = false) {
  const data = new Uint8Array(8);
  new DataView(data.buffer)[signed ? "setBigInt64" : "setBigUint64"](0, BigInt(value), true);
  return data;
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
      { pubkey: player, isWritable: true, isSigner: true },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
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
  rpcUrl: string;
  matchAddress: string;
  programId?: string;
  round: number;
  intent: TradeIntent;
}) {
  const wallet = window.solana;
  if (!wallet) throw new Error("solana_wallet_not_found");
  const connected = wallet.publicKey ? { publicKey: wallet.publicKey } : await wallet.connect();
  const player = new PublicKey(connected.publicKey);
  const programId = input.programId ?? PROGRAM_ID.toBase58();
  const connection = new Connection(input.rpcUrl, "confirmed");
  const transaction = new Transaction().add(createOpenRfqInstruction({
    matchAddress: input.matchAddress,
    playerAddress: player.toBase58(),
    programId,
    round: input.round,
    side: input.intent.side,
    quantity: input.intent.quantity,
  }));
  transaction.feePayer = player;
  const blockhash = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) throw new Error("open_rfq_simulation_failed");
  const sent = await wallet.signAndSendTransaction(transaction);
  const signature = typeof sent === "string" ? sent : sent.signature;
  await connection.confirmTransaction({ signature, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight }, "confirmed");
  return { walletAddress: player.toBase58(), signature };
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
  const transaction = new Transaction().add(createSubmitQuoteInstruction({ ...input, dealerAddress: dealer.toBase58() }));
  transaction.feePayer = dealer;
  const blockhash = await session.connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
  const simulation = await session.connection.simulateTransaction(transaction);
  if (simulation.value.err) throw new Error("submit_quote_simulation_failed");
  const signed = await wallet.signTransaction(transaction);
  const signature = await session.connection.sendRawTransaction(signed.serialize());
  await session.connection.confirmTransaction({ signature, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight }, "confirmed");
  return { walletAddress: dealer.toBase58(), signature };
}
