import LifecycleScroller from "./LifecycleScroller";

const LIFECYCLE = [
  {
    title: "Delegate",
    body:
      "When a match needs private state, the relevant Solana accounts are delegated to MagicBlock's Private Ephemeral Rollup — a real-time execution layer built for exactly this.",
  },
  {
    title: "Execute privately",
    body:
      "Inside a TEE-backed rollup, dealers submit sealed quotes, inventories update, and rounds resolve in real time — fast enough to keep up with a live, voice-driven trading floor.",
  },
  {
    title: "Commit & undelegate",
    body:
      "Final scores and results commit back to Solana's base layer and undelegate, where they become the permanent, public record everyone can verify.",
  },
];

export default function MagicBlockSpotlight() {
  return (
    <section className="landing-section landing-section-private" aria-labelledby="magicblock-heading">
      <div className="landing-private-badge">PRIVATE EXECUTION LAYER</div>
      <p className="landing-eyebrow">POWERED BY MAGICBLOCK</p>
      <h2 className="landing-h2" id="magicblock-heading">
        The magic block: <em>a rollup that keeps secrets on purpose.</em>
      </h2>
      <p className="landing-lede">
        A Private Ephemeral Rollup (PER) is a TEE-backed execution environment that runs the
        private parts of the game — quotes, inventory, fast round resolution — off the base
        layer, at rollup speed, with account-level access control enforced inside hardware. Your
        rivals never see your price. Outcry's own servers never see it either.
      </p>
      <LifecycleScroller items={LIFECYCLE} />
      <p className="landing-private-note">
        If verified TEE access isn&rsquo;t available, private actions fail closed — the round
        doesn&rsquo;t run rather than run insecurely.
      </p>
    </section>
  );
}
