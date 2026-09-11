import { useEffect, useState } from "react";
import { motion } from "framer-motion";

const POINTS: Array<[number, number]> = [
  [0, 132],
  [38, 118],
  [72, 146],
  [108, 88],
  [148, 108],
  [188, 56],
  [228, 78],
  [268, 36],
  [320, 52],
];

const LINE_PATH = `M${POINTS.map(([x, y]) => `${x},${y}`).join(" L")}`;
const AREA_PATH = `${LINE_PATH} L320,180 L0,180 Z`;
const [LAST_X, LAST_Y] = POINTS[POINTS.length - 1];

const CHART_EASE = [0.16, 1, 0.3, 1] as const;

export default function HeroVisual() {
  const [price, setPrice] = useState(105.22);
  const [rising, setRising] = useState(true);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setPrice((current) => {
        const delta = (Math.random() - 0.45) * 0.32;
        setRising(delta >= 0);
        return Math.max(90, current + delta);
      });
    }, 1800);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <div className="landing-hero-chart-card">
      <div className="landing-hero-chart-header">
        <span className="landing-hero-chart-pair">SOL / USDC</span>
        <span className={`landing-hero-chart-price ${rising ? "is-up" : "is-down"}`}>
          {rising ? "▲" : "▼"} {price.toFixed(2)}
        </span>
      </div>

      <svg
        className="landing-hero-chart-svg"
        viewBox="0 0 320 180"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="heroChartFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent-blue)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent-blue)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <motion.path
          d={AREA_PATH}
          fill="url(#heroChartFill)"
          stroke="none"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.6 }}
        />
        <motion.path
          d={LINE_PATH}
          fill="none"
          stroke="var(--accent-blue)"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.4, delay: 0.3, ease: CHART_EASE }}
        />
        <motion.circle
          cx={LAST_X}
          cy={LAST_Y}
          r={10}
          fill="var(--accent-blue)"
          opacity={0.25}
          initial={{ scale: 0 }}
          animate={{ scale: [0, 1.6, 1] }}
          style={{ transformOrigin: `${LAST_X}px ${LAST_Y}px` }}
          transition={{ duration: 1.6, delay: 1.7, repeat: Infinity, repeatDelay: 0.6 }}
        />
        <motion.circle
          cx={LAST_X}
          cy={LAST_Y}
          r={4.5}
          fill="var(--accent-blue)"
          stroke="var(--bg-panel)"
          strokeWidth={2}
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ duration: 0.4, delay: 1.7 }}
        />
      </svg>

      <motion.span
        className="landing-hero-chip landing-hero-chip-sealed"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: [0, -6, 0] }}
        transition={{
          opacity: { duration: 0.4, delay: 1.1 },
          y: { duration: 3.2, delay: 1.1, repeat: Infinity, ease: "easeInOut" },
        }}
      >
        🔒 SEALED
      </motion.span>
      <motion.span
        className="landing-hero-chip landing-hero-chip-buy"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: [0, -6, 0] }}
        transition={{
          opacity: { duration: 0.4, delay: 1.4 },
          y: { duration: 3.6, delay: 1.4, repeat: Infinity, ease: "easeInOut" },
        }}
      >
        BUY 2 SOL
      </motion.span>
    </div>
  );
}
