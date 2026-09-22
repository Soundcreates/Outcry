import { motion } from "framer-motion";
import Reveal from "./Reveal";
import { staggerItem } from "./motion";

const FEATURES = [
  {
    title: "Pixel-art multiplayer floor",
    body:
      "Four playable worlds with live player and pit counts. Walk the floor, watch matches, and feel the room before you ever sit down.",
  },
  {
    title: "Interactive pits & seats",
    body:
      "Walk up, press E, claim a seat with a server-validated 60-second lease. No double-bookings, no stuck chairs, no exploits.",
  },
  {
    title: "Wallet-gated match entry",
    body:
      "Every seat is checked by the world server, while the match account independently verifies wallet membership before the trading room opens.",
  },
  {
    title: "Live trading matches",
    body:
      "One to eight rounds, taker rotation, buy/sell intents in 1, 2, or 5 SOL sizes, and a visible quote deadline every round.",
  },
  {
    title: "Private RFQ + voice trading",
    body:
      "Say “buy two SOL,” confirm the draft, and the request goes out. Speech only drafts an intent — it never signs or submits a transaction.",
  },
  {
    title: "On-chain settlement & oracle safety",
    body:
      "Pyth-verified pricing, deviation bands, deterministic tie-breaking, and durable, public results on Solana's base layer.",
  },
];

export default function FeaturesGrid() {
  return (
    <section className="landing-section" aria-labelledby="features-heading">
      <p className="landing-eyebrow">WHAT'S IN THE FLOOR</p>
      <h2 className="landing-h2" id="features-heading">
        Everything a live pit needs, <em>none of the dashboard clutter.</em>
      </h2>
      <Reveal className="landing-grid landing-grid-3">
        {FEATURES.map((feature) => (
          <motion.article
            className="landing-card"
            key={feature.title}
            variants={staggerItem}
            whileHover={{ y: -4, transition: { duration: 0.2 } }}
          >
            <h3>{feature.title}</h3>
            <p>{feature.body}</p>
          </motion.article>
        ))}
      </Reveal>
    </section>
  );
}
