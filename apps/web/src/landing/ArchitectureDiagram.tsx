import { useMemo } from "react";
import { motion } from "framer-motion";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { fadeUp } from "./motion";

const PUBLIC_NODE_STYLE = {
  background: "var(--bg-panel)",
  border: "1.5px solid var(--border-strong)",
  borderRadius: "0.85rem",
  padding: "0.7rem 1rem",
  color: "var(--text-primary)",
  fontFamily: "var(--font-body)",
  fontSize: "0.85rem",
  fontWeight: 600,
  width: 190,
};

const PRIVATE_NODE_STYLE = {
  ...PUBLIC_NODE_STYLE,
  background: "var(--accent-lavender)",
  border: "1.5px solid var(--border-strong)",
};

const CLIENT_NODE_STYLE = {
  ...PUBLIC_NODE_STYLE,
  background: "var(--text-primary)",
  color: "var(--bg-root)",
  border: "1.5px solid var(--border-strong)",
};

const NODES: Node[] = [
  { id: "client", position: { x: 0, y: 200 }, data: { label: "Browser\nReact + Phaser world" }, style: CLIENT_NODE_STYLE },
  { id: "colyseus", position: { x: 300, y: 40 }, data: { label: "Colyseus\nworld server" }, style: PUBLIC_NODE_STYLE },
  { id: "livekit", position: { x: 300, y: 200 }, data: { label: "LiveKit\nmedia room" }, style: PUBLIC_NODE_STYLE },
  { id: "solana", position: { x: 300, y: 360 }, data: { label: "Solana L1\nmatch, escrow, settlement" }, style: PUBLIC_NODE_STYLE },
  { id: "magicblock", position: { x: 620, y: 360 }, data: { label: "MagicBlock PER\nprivate RFQ, quotes, inventory" }, style: PRIVATE_NODE_STYLE },
  { id: "pyth", position: { x: 620, y: 500 }, data: { label: "Pyth oracle" }, style: PUBLIC_NODE_STYLE },
  { id: "groq", position: { x: 620, y: 40 }, data: { label: "Groq Whisper STT" }, style: PUBLIC_NODE_STYLE },
];

const EDGES: Edge[] = [
  { id: "client-colyseus", source: "client", target: "colyseus", label: "movement, seats, chat" },
  { id: "client-livekit", source: "client", target: "livekit", label: "video / voice" },
  { id: "client-solana", source: "client", target: "solana", label: "wallet tx" },
  { id: "solana-magicblock", source: "solana", target: "magicblock", label: "delegate / commit / undelegate", style: { strokeWidth: 2 } },
  { id: "pyth-magicblock", source: "pyth", target: "magicblock" },
  { id: "colyseus-groq", source: "colyseus", target: "groq", label: "speech draft", style: { strokeDasharray: "4 4" } },
].map((edge) => ({
  ...edge,
  markerEnd: { type: MarkerType.ArrowClosed, color: "#1a1a1a" },
  style: { stroke: "#1a1a1a", strokeWidth: 1.5, ...edge.style },
  labelStyle: { fill: "#1a1a1a", fontFamily: "var(--font-body)", fontSize: 11, fontWeight: 600 },
  labelBgStyle: { fill: "#fffdf0", fillOpacity: 0.9 },
}));

export default function ArchitectureDiagram() {
  const nodes = useMemo(
    () =>
      NODES.map((node) => ({
        ...node,
        data: { label: (node.data.label as string).split("\n").map((line, i) => <div key={i}>{line}</div>) },
      })),
    [],
  );

  return (
    <section className="landing-section" id="architecture" aria-labelledby="architecture-heading">
      <p className="landing-eyebrow">HOW IT'S BUILT</p>
      <h2 className="landing-h2" id="architecture-heading">
        One floor, <em>five systems, one authority each.</em>
      </h2>
      <p className="landing-lede">
        The frontend is never canonical. Movement stays off-chain, voice never signs a
        transaction, and private actions fail closed when MagicBlock isn&rsquo;t verifiably
        available. Drag to pan, scroll to zoom.
      </p>
      <motion.div
        className="landing-diagram-frame"
        variants={fadeUp}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, amount: 0.2 }}
      >
        <ReactFlow
          nodes={nodes}
          edges={EDGES}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#e8e0bd" variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </motion.div>
    </section>
  );
}
