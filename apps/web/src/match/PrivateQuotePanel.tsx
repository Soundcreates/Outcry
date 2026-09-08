import { useState } from "react";
import { baseRpcConfigurationMessage, browserBaseRpc } from "../chain/baseRpc";
import { submitPrivateQuoteOnchain } from "../chain/matchActions";

type Props = {
  active: boolean;
  matchAddress?: string;
  dealerAddress?: string;
  round?: number;
  programId: string;
};

const teeRpc = import.meta.env.VITE_MAGICBLOCK_TEE_RPC || import.meta.env.NEXT_PUBLIC_MAGICBLOCK_TEE_RPC || "";

export default function PrivateQuotePanel({ active, matchAddress, dealerAddress, round, programId }: Props) {
  const [price, setPrice] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "submitted" | "error">("idle");
  const [error, setError] = useState("");

  if (!active) return null;

  const submit = async () => {
    const priceE6 = Number(price);
    if (!matchAddress || !dealerAddress || round === undefined) return setError("private_round_unavailable");
    if (!teeRpc) return setError("tee_rpc_unconfigured");
    if (!browserBaseRpc.url) return setError(baseRpcConfigurationMessage(browserBaseRpc.error));
    if (!Number.isSafeInteger(priceE6) || priceE6 <= 0) return setError("enter_positive_price_e6");
    setStatus("submitting");
    setError("");
    try {
      await submitPrivateQuoteOnchain({ baseRpcUrl: browserBaseRpc.url, teeRpcUrl: teeRpc, matchAddress, dealerAddress, round, priceE6, programId });
      setStatus("submitted");
    } catch (reason) {
      setStatus("error");
      setError(reason instanceof Error ? reason.message : "private_quote_failed");
    }
  };

  return (
    <section className="private-quote" aria-label="Private dealer quote">
      <div>
        <p className="eyebrow">PRIVATE DEALER QUOTE</p>
        <strong>Only your quote is sent through the TEE.</strong>
      </div>
      <label>
        Price (USDC e6)
        <input inputMode="numeric" onChange={(event) => setPrice(event.target.value)} placeholder="105000000" value={price} />
      </label>
      {error && <span role="alert">{error}</span>}
      {status === "submitted" ? <span role="status">Quote sealed privately.</span> : <button disabled={status === "submitting"} onClick={() => void submit()} type="button">{status === "submitting" ? "Sealing…" : "Submit private quote"}</button>}
    </section>
  );
}
