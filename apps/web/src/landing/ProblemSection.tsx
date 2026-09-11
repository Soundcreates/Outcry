import { motion } from "framer-motion";
import Reveal from "./Reveal";
import { staggerItem } from "./motion";

const PROBLEMS = [
  {
    title: "Information leakage",
    body:
      "The moment you ask for a price, the market already knows what you want. FX desks, OTC credit, and crypto RFQs share the same flaw: dealers can see your intent before they ever answer it.",
  },
  {
    title: "Last-look and quote fading",
    body:
      "By the time a fill comes back, the price has moved — or the dealer simply declines. You carried the risk of asking; they kept the option of answering.",
  },
  {
    title: "Opaque settlement",
    body:
      "Who actually filled your order, and at what price? On most OTC desks you're trusting a printout, not a ledger.",
  },
  {
    title: "No accountable record",
    body:
      "Disputes get resolved by whoever kept better logs. There's no shared, tamper-proof source of truth both sides can point to.",
  },
];

export default function ProblemSection() {
  return (
    <section className="landing-section" aria-labelledby="problem-heading">
      <p className="landing-eyebrow">THE QUOTE PROBLEM</p>
      <h2 className="landing-h2" id="problem-heading">
        Every OTC desk has run on <em>the same trade-off</em> for decades
      </h2>
      <Reveal className="landing-grid landing-grid-4">
        {PROBLEMS.map((problem) => (
          <motion.article className="landing-card" key={problem.title} variants={staggerItem}>
            <h3>{problem.title}</h3>
            <p>{problem.body}</p>
          </motion.article>
        ))}
      </Reveal>
    </section>
  );
}
