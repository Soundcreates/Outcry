import type { PythSolanaReceiver, InstructionWithEphemeralSigners } from "@pythnetwork/pyth-solana-receiver";
import { Connection, PublicKey, Transaction, TransactionInstruction, type Signer, type VersionedTransaction } from "@solana/web3.js";

export type PythWallet = {
  publicKey: PublicKey | null;
  signTransaction?: <T extends Transaction | VersionedTransaction>(transaction: T) => Promise<T>;
  signAllTransactions?: <T extends Transaction | VersionedTransaction>(transactions: T[]) => Promise<T[]>;
};

export type PythSimulationDiagnostics = {
  transactionIndex?: number;
  transactionCount?: number;
  failedInstructionIndex?: number;
  failingProgramId?: string;
  instructionProgramIds: string[];
  err: unknown;
  logs: string[];
  unitsConsumed?: number | null;
  returnData?: unknown;
};

export class PythSubmissionError extends Error {
  constructor(
    public readonly stage: "build" | "simulation" | "wallet" | "confirmation",
    detail: string,
    public readonly diagnostics?: PythSimulationDiagnostics,
  ) {
    super(`pyth_${stage}_failed:${detail}`);
    this.name = "PythSubmissionError";
  }
}

function errorDetail(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

export function parsePythInstructionError(err: unknown): { index: number; details: unknown } | undefined {
  const value = Array.isArray(err)
    ? err[0] === "InstructionError" ? err[1] : undefined
    : err && typeof err === "object"
      ? (err as { InstructionError?: unknown }).InstructionError
      : undefined;
  if (!Array.isArray(value) || typeof value[0] !== "number") return undefined;
  return { index: value[0], details: value[1] };
}

function simulationDiagnostics(
  transaction: VersionedTransaction,
  value: { err: unknown; logs?: string[] | null; unitsConsumed?: number | null; returnData?: unknown },
  transactionIndex?: number,
  transactionCount?: number,
): PythSimulationDiagnostics {
  const failure = parsePythInstructionError(value.err);
  const instruction = failure === undefined
    ? undefined
    : transaction.message.compiledInstructions[failure.index];
  return {
    transactionIndex,
    transactionCount,
    failedInstructionIndex: failure?.index,
    failingProgramId: instruction
      ? transaction.message.staticAccountKeys[instruction.programIdIndex]?.toBase58()
      : undefined,
    instructionProgramIds: transaction.message.compiledInstructions.map((compiledInstruction) =>
      transaction.message.staticAccountKeys[compiledInstruction.programIdIndex]?.toBase58() ?? "unknown",
    ),
    err: value.err,
    logs: value.logs ?? [],
    unitsConsumed: value.unitsConsumed,
    returnData: value.returnData,
  };
}

function simulationDetail(diagnostics: PythSimulationDiagnostics) {
  const log = diagnostics.logs.find((entry) => /AnchorError|Error Code|failed|custom program error/i.test(entry));
  const instruction = diagnostics.failedInstructionIndex === undefined
    ? "simulation"
    : `instruction_${diagnostics.failedInstructionIndex}${diagnostics.failingProgramId ? `_${diagnostics.failingProgramId}` : ""}`;
  return `${instruction}:${log ?? JSON.stringify(diagnostics.err)}`;
}

export function pythFeedId(feedId: string) {
  const normalized = feedId.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new PythSubmissionError("build", "price_feed_id_invalid");
  return `0x${normalized}`;
}

function asAnchorWallet(wallet: PythWallet): ConstructorParameters<typeof PythSolanaReceiver>[0]["wallet"] {
  if (!wallet.publicKey || !wallet.signTransaction) throw new PythSubmissionError("wallet", "wallet_transaction_signing_unavailable");
  return {
    publicKey: wallet.publicKey,
    signTransaction: (transaction) => wallet.signTransaction!(transaction),
    signAllTransactions: async (transactions) => wallet.signAllTransactions
      ? wallet.signAllTransactions(transactions)
      : Promise.all(transactions.map((transaction) => wallet.signTransaction!(transaction))),
  } as ConstructorParameters<typeof PythSolanaReceiver>[0]["wallet"];
}

async function sendWalletTransaction(input: {
  connection: Connection;
  wallet: PythWallet;
  transaction: VersionedTransaction;
  signers: Signer[];
  label: string;
  transactionIndex?: number;
  transactionCount?: number;
  onProgress?: (status: string) => void;
}) {
  try {
    if (input.signers.length > 0) input.transaction.sign(input.signers);
    input.onProgress?.(`Simulating ${input.label}…`);
    const simulation = await input.connection.simulateTransaction(input.transaction, {
      commitment: "confirmed",
      sigVerify: false,
    });
    if (simulation.value.err) {
      const diagnostics = simulationDiagnostics(
        input.transaction,
        simulation.value,
        input.transactionIndex,
        input.transactionCount,
      );
      console.error("[outcry][pyth][simulation]", diagnostics);
      throw new PythSubmissionError("simulation", simulationDetail(diagnostics), diagnostics);
    }
    if (!input.wallet.signTransaction) throw new PythSubmissionError("wallet", "wallet_transaction_signing_unavailable");
    input.onProgress?.(`Approve ${input.label} in your wallet…`);
    const signed = await input.wallet.signTransaction(input.transaction);
    const signature = await input.connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 5 });
    input.onProgress?.(`Confirming ${input.label}…`);
    const confirmation = await input.connection.confirmTransaction(signature, "confirmed");
    if (confirmation.value.err) throw new PythSubmissionError("confirmation", JSON.stringify(confirmation.value.err));
    return signature;
  } catch (reason) {
    if (reason instanceof PythSubmissionError) throw reason;
    throw new PythSubmissionError("wallet", errorDetail(reason));
  }
}

export async function postPythPriceAndConsume(input: {
  connection: Connection;
  wallet: PythWallet;
  feedId: string;
  priceUpdates: string[];
  createConsumerInstructions: (priceUpdate: PublicKey) => TransactionInstruction[];
  label?: string;
  onProgress?: (status: string) => void;
}) {
  if (input.priceUpdates.length === 0) throw new PythSubmissionError("build", "price_update_missing");
  try {
    const feedId = pythFeedId(input.feedId);
    const { PythSolanaReceiver } = await import("@pythnetwork/pyth-solana-receiver");
    const receiver = new PythSolanaReceiver({ connection: input.connection, wallet: asAnchorWallet(input.wallet) });
    const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
    input.onProgress?.("Preparing verified SOL/USD price update…");
    await builder.addPostPriceUpdates(input.priceUpdates);
    await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => input.createConsumerInstructions(getPriceUpdateAccount(feedId))
      .map((instruction): InstructionWithEphemeralSigners => ({ instruction, signers: [] })));
    // Let the SDK preserve its per-instruction compute metadata and Solana's
    // default allocation for our consumer instructions. The consumer entries
    // do not provide a tight-compute estimate, so forcing one here can cap the
    // OUTCRY instruction sequence below what it needs.
    const transactions = await builder.buildVersionedTransactions({});
    if (transactions.length === 0) throw new PythSubmissionError("build", "transaction_missing");
    const signatures: string[] = [];
    for (let index = 0; index < transactions.length; index += 1) {
      signatures.push(await sendWalletTransaction({
        connection: input.connection,
        wallet: input.wallet,
        transaction: transactions[index]!.tx,
        signers: transactions[index]!.signers,
        label: `${input.label ?? "verified price update"} ${index + 1}/${transactions.length}`,
        transactionIndex: index,
        transactionCount: transactions.length,
        onProgress: input.onProgress,
      }));
    }
    return { signature: signatures.at(-1)!, signatures };
  } catch (reason) {
    if (reason instanceof PythSubmissionError) throw reason;
    throw new PythSubmissionError("build", errorDetail(reason));
  }
}
