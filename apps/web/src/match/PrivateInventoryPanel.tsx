import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { baseRpcConfigurationMessage, browserBaseRpc } from "../chain/baseRpc";
import { unlockPrivateInventory, type PrivateInventorySnapshot } from "../chain/privacy";

type Props = {
  matchAddress?: string;
  playerAddress?: string;
  programId: string;
  lastResolvedRound?: number;
};

const teeRpc = import.meta.env.VITE_MAGICBLOCK_TEE_RPC || import.meta.env.NEXT_PUBLIC_MAGICBLOCK_TEE_RPC || "";
const teeValidator = import.meta.env.VITE_MAGICBLOCK_TEE_VALIDATOR || undefined;

function formatUsdcE6(value: bigint) {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}$${whole}${fraction ? `.${fraction}` : ""}`;
}

export default function PrivateInventoryPanel({ matchAddress, playerAddress, programId, lastResolvedRound }: Props) {
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
    if (!browserBaseRpc.url) {
      setStatus("error");
      setError(baseRpcConfigurationMessage(browserBaseRpc.error));
      return;
    }
    setStatus("loading");
    setError("");
    try {
      const next = await unlockPrivateInventory({
        baseRpcUrl: browserBaseRpc.url,
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
        <>
          <dl className="private-inventory-values">
            <div><dt>SOL position</dt><dd>{snapshot.solPositionLots.toString()} SOL</dd></div>
            <div><dt>Cash</dt><dd>{formatUsdcE6(snapshot.cashE6)} USDC</dd></div>
            <div><dt>Realized PnL</dt><dd>{formatUsdcE6(snapshot.realizedPnlE6)} USDC</dd></div>
            <div><dt>Cumulative notional</dt><dd>{formatUsdcE6(snapshot.filledNotionalE6)} USDC</dd></div>
          </dl>
          <div className="private-inventory-refresh">
            <span>{lastResolvedRound === undefined ? "Refresh after a round resolves to view your latest private fill." : `Round ${lastResolvedRound + 1} settled. Refresh to view your latest private fill.`}</span>
            <button onClick={() => void unlock()} type="button">Refresh private inventory</button>
          </div>
        </>
      )}
    </section>
  );
}
