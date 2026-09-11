import { motion } from "framer-motion";
import Reveal from "./Reveal";
import { staggerItem } from "./motion";

const STEPS = [
  {
    step: "01",
    title: "Shout the trade",
    body:
      "A taker's intent — buy or sell, one, two, or five SOL — is public the instant it's spoken or typed. Everyone in the pit sees the request. Nobody sees an edge.",
  },
  {
    step: "02",
    title: "Seal the quote",
    body:
      "Each dealer submits a private price inside MagicBlock's encrypted rollup. Rivals can't read it. Spectators can't read it. Not even the world server can read it.",
  },
  {
    step: "03",
    title: "Settle on chain",
    body:
      "The best valid quote wins by a deterministic, oracle-checked rule, and Solana's base layer finalizes the match, escrow, and payout — a public, permanent record.",
  },
];

export default function SolutionSection() {
  return (
    <section className="landing-section" aria-labelledby="solution-heading">
      <p className="landing-eyebrow">HOW OUTCRY SOLVES IT</p>
      <h2 className="landing-h2" id="solution-heading">
        Public intent, <em>private competition.</em>
      </h2>
      <Reveal className="landing-steps">
        {STEPS.map((item) => (
          <motion.article className="landing-step" key={item.step} variants={staggerItem}>
            <span className="landing-step-number">{item.step}</span>
            <h3>{item.title}</h3>
            <p>{item.body}</p>
          </motion.article>
        ))}
      </Reveal>
    </section>
  );
}
