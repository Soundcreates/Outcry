import { motion } from "framer-motion";
import { fadeUp } from "./motion";

export default function FinalCta() {
  return (
    <footer className="landing-footer">
      <motion.section
        className="landing-final-cta"
        variants={fadeUp}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, amount: 0.5 }}
      >
        <p className="landing-tagline">
          Walk the floor. Shout the trade.
          <br />
          <em>Hide the quote. Own the pit.</em>
        </p>
        <motion.a
          className="landing-btn landing-btn-primary"
          href="/?play=1"
          whileHover={{ y: -2, boxShadow: "3px 3px 0 var(--border-strong)" }}
          whileTap={{ scale: 0.96, y: 0 }}
          transition={{ duration: 0.15 }}
        >
          Pick a world above, or just enter the floor
        </motion.a>
      </motion.section>
      <p className="landing-footer-meta">
        Built on Solana + MagicBlock Private Ephemeral Rollups. Pricing verified by Pyth.
      </p>
    </footer>
  );
}
