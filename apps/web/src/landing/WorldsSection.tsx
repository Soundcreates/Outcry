import { motion } from "framer-motion";
import { WORLDS } from "../worlds";
import Reveal from "./Reveal";
import { staggerItem } from "./motion";

export default function WorldsSection() {
  return (
    <section className="landing-section" aria-labelledby="worlds-heading">
      <p className="landing-eyebrow">PICK A FLOOR</p>
      <h2 className="landing-h2" id="worlds-heading">
        Four worlds, <em>same rules, different room.</em>
      </h2>
      <Reveal className="landing-worlds">
        {WORLDS.map((world) => (
          <motion.a
            className="landing-world-card"
            href={`/?play=1&world=${encodeURIComponent(world.id)}`}
            key={world.id}
            variants={staggerItem}
            whileHover={{ y: -4, boxShadow: "4px 4px 0 var(--accent-lavender-strong)" }}
            whileTap={{ scale: 0.97, y: 0 }}
            transition={{ duration: 0.2 }}
          >
            <h3>{world.name}</h3>
            <p>{world.blurb}</p>
            <span className="landing-world-meta">{world.pits} pits</span>
            <span className="landing-world-enter">Enter {world.name} →</span>
          </motion.a>
        ))}
      </Reveal>
    </section>
  );
}
