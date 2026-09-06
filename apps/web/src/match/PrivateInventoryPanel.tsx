import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { unlockPrivateInventory, type PrivateInventorySnapshot } from "../chain/privacy";

type Props = {
  matchAddress?: string;
  playerAddress?: string;
  programId: string;
};

const teeRpc = import.meta.env.VITE_MAGICBLOCK_TEE_RPC || import.meta.env.NEXT_PUBLIC_MAGICBLOCK_TEE_RPC || "";
const baseRpc = import.meta.env.VITE_SOLANA_BASE_RPC || "https://api.devnet.solana.com";
const teeValidator = import.meta.env.VITE_MAGICBLOCK_TEE_VALIDATOR || undefined;

export default function PrivateInventoryPanel({ matchAddress, playerAddress, programId }: Props) {
  const [snapshot, setSnapshot] = useState<PrivateInventorySnapshot>();
  const [status, setStatus] = useState<"locked" | "loading" | "ready" | "error">("locked");
  const [error, setError] = useState("");

  const unlock = async () => {
    const wallet = window.solana;
    if (!matchAddress || !playerAddress || !wallet?.publicKey || !wallet.signMessage || !wallet.signTransaction) {
      setStatus("error");
      setError(!wallet?.signMessage ? "wallet_message_signing_unavailable" : "wallet_transaction_signing_unavailable");
      return;
    }
    if (!teeRpc) {
      setStatus("error");
      setError("tee_rpc_unconfigured");
      return;
    }
    setStatus("loading");
    setError("");
    try {
      const next = await unlockPrivateInventory({
        baseRpcUrl: baseRpc,
        teeRpcUrl: teeRpc,
        matchAddress: new PublicKey(matchAddress),
        player: new PublicKey(playerAddress),
        wallet,
        programId: new PublicKey(programId),
        teeValidator: teeValidator ? new PublicKey(teeValidator) : undefined,
      });
      setSnapshot(next);
      setStatus("ready");
    } catch (reason) {
      setStatus("error");
      setError(reason instanceof Error ? reason.message : "private_inventory_unavailable");
    }
  };

  return (
    <section className="private-inventory" aria-label="Private inventory">
      <div>
        <p className="eyebrow">PRIVATE INVENTORY</p>
        <strong>Only your wallet can unlock this view.</strong>
      </div>
      {status === "locked" && <button onClick={() => void unlock()} type="button">Unlock private inventory</button>}
      {status === "loading" && <span role="status">Setting up private inventory…</span>}
      {status === "error" && (
        <div className="private-inventory-error">
          <span role="alert">{error}</span>
          <button onClick={() => void unlock()} type="button">Retry private view</button>
        </div>
      )}
      {status === "ready" && snapshot && (
        <dl className="private-inventory-values">
          <div><dt>SOL position</dt><dd>{snapshot.solPositionLots.toString()}</dd></div>
          <div><dt>Cash (e6)</dt><dd>{snapshot.cashE6.toString()}</dd></div>
          <div><dt>Realized PnL (e6)</dt><dd>{snapshot.realizedPnlE6.toString()}</dd></div>
          <div><dt>Filled notional (e6)</dt><dd>{snapshot.filledNotionalE6.toString()}</dd></div>
        </dl>
      )}
    </section>
  );
}
