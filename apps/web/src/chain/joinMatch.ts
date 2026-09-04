import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

const JOIN_MATCH_DISCRIMINATOR = Uint8Array.from([244, 8, 47, 130, 192, 59, 179, 44]);

type WalletProvider = {
  publicKey: PublicKey | null;
  connect: () => Promise<{ publicKey: PublicKey }>;
  signAndSendTransaction: (transaction: Transaction) => Promise<string | { signature: string }>;
};

declare global {
  interface Window {
    solana?: WalletProvider;
  }
}

export function connectedWalletAddress() {
  return window.solana?.publicKey?.toBase58();
}

export function createJoinMatchInstruction(input: {
  matchAddress: string;
  playerAddress: string;
  programId: string;
  seatIndex: number;
}) {
  if (!Number.isInteger(input.seatIndex) || input.seatIndex < 0 || input.seatIndex > 3) {
    throw new Error("invalid_seat");
  }
  const match = new PublicKey(input.matchAddress);
  const player = new PublicKey(input.playerAddress);
  return new TransactionInstruction({
    programId: new PublicKey(input.programId),
    keys: [
      { pubkey: match, isWritable: true, isSigner: false },
      { pubkey: player, isWritable: false, isSigner: true },
    ],
    data: Uint8Array.from([...JOIN_MATCH_DISCRIMINATOR, input.seatIndex]) as unknown as Buffer,
  });
}

export function validateJoinAccounts(
  programInfo: { executable: boolean } | null,
  matchInfo: { owner: PublicKey } | null,
  programId: PublicKey,
) {
  if (!programInfo?.executable) throw new Error("outcry_program_not_deployed");
  if (!matchInfo) throw new Error("match_account_not_initialized");
  if (!matchInfo.owner.equals(programId)) throw new Error("match_account_program_mismatch");
}

export async function joinMatchOnchain(input: {
  matchAddress: string;
  seatIndex: number;
  rpcUrl: string;
  programId: string;
}) {
  const wallet = window.solana;
  if (!wallet) throw new Error("solana_wallet_not_found");

  const connected = wallet.publicKey ? { publicKey: wallet.publicKey } : await wallet.connect();
  const player = new PublicKey(connected.publicKey);

  const connection = new Connection(input.rpcUrl, "confirmed");
  const [programInfo, matchInfo] = await Promise.all([
    connection.getAccountInfo(new PublicKey(input.programId), "confirmed"),
    connection.getAccountInfo(new PublicKey(input.matchAddress), "confirmed"),
  ]);
  validateJoinAccounts(programInfo, matchInfo, new PublicKey(input.programId));
  const transaction = new Transaction().add(createJoinMatchInstruction({
    matchAddress: input.matchAddress,
    playerAddress: player.toBase58(),
    programId: input.programId,
    seatIndex: input.seatIndex,
  }));
  transaction.feePayer = player;
  const blockhash = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;

  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) throw new Error("join_match_simulation_failed");

  const sent = await wallet.signAndSendTransaction(transaction);
  const signature = typeof sent === "string" ? sent : sent.signature;
  await connection.confirmTransaction({
    signature,
    blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  }, "confirmed");
  return { walletAddress: player.toBase58(), signature };
}
