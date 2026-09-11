import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useScroll, useTransform } from "framer-motion";
import { API_BASE_URL } from "../config";
import { staggerContainer, staggerItem } from "./motion";
import HeroVisual from "./HeroVisual";

export default function Hero() {
  const [liveLine, setLiveLine] = useState<string | null>(null);
  const heroRef = useRef<HTMLElement | null>(null);
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ["start start", "end start"] });
  const artY = useTransform(scrollYProgress, [0, 1], [0, 60]);
  const artOpacity = useTransform(scrollYProgress, [0, 0.9], [1, 0.4]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/worlds`);
        if (!response.ok) return;
        const payload = (await response.json()) as {
          worlds?: Array<{ online: number; activePits: number }>;
        };
        if (!active || !Array.isArray(payload.worlds)) return;
        const online = payload.worlds.reduce((sum, world) => sum + world.online, 0);
        const pits = payload.worlds.reduce((sum, world) => sum + world.activePits, 0);
        if (online > 0 || pits > 0) {
          setLiveLine(`LIVE NOW · ${online} TRADERS · ${pits} ACTIVE PITS`);
        }
      } catch {
        // Landing page stays honest with a static line while the floor is quiet.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return (
    <header className="landing-hero" ref={heroRef}>
      <motion.div
        className="landing-hero-copy"
        variants={staggerContainer}
        initial="hidden"
        animate="show"
      >
        <motion.p className="landing-eyebrow" variants={staggerItem}>
          SOCIAL TRADING FLOOR · SOLANA + MAGICBLOCK
        </motion.p>
        <motion.h1 className="landing-h1" variants={staggerItem}>
          Don&rsquo;t leak it,
          <br />
          <em>just seal it.</em>
        </motion.h1>
        <motion.p className="landing-hero-sub" variants={staggerItem}>
          Outcry is a multiplayer trading floor where every price request is public and every
          quote is private — sealed inside MagicBlock&rsquo;s encrypted rollup, settled for good
          on Solana.
        </motion.p>
        <motion.div className="landing-hero-actions" variants={staggerItem}>
          <motion.a
            className="landing-btn landing-btn-primary"
            href="/?play=1"
            whileHover={{ y: -2, boxShadow: "3px 3px 0 var(--border-strong)" }}
            whileTap={{ scale: 0.96, y: 0 }}
            transition={{ duration: 0.15 }}
          >
            Enter the floor
          </motion.a>
          <motion.a
            className="landing-btn landing-btn-ghost"
            href="#architecture"
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.96, y: 0 }}
            transition={{ duration: 0.15 }}
          >
            See how it&rsquo;s built
          </motion.a>
        </motion.div>
        <motion.p className="landing-hero-live" variants={staggerItem}>
          <AnimatePresence mode="wait">
            <motion.span
              key={liveLine ?? "static"}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.3 }}
            >
              {liveLine ?? "THE FLOOR OPENS THE MOMENT A PIT FILLS"}
            </motion.span>
          </AnimatePresence>
        </motion.p>
      </motion.div>
      <motion.div
        className="landing-hero-art"
        aria-hidden="true"
        style={{ y: artY, opacity: artOpacity }}
        initial={{ scale: 0.9 }}
        animate={{ scale: 1 }}
        transition={{ duration: 0.7, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
      >
        <HeroVisual />
      </motion.div>
    </header>
  );
}
