import { useState } from "react";
import WorldCanvas from "./world/WorldCanvas";

const worlds = [
  { id: "wall-street", name: "Wall Street", online: 26, pits: 2, ready: true },
  { id: "tokyo-night", name: "Tokyo Night", online: 11, pits: 1, ready: false },
] as const;

export default function App() {
  const [worldId, setWorldId] = useState<string | null>(null);

  if (worldId) {
    return <WorldCanvas worldId={worldId} onExit={() => setWorldId(null)} />;
  }

  return (
    <main className="shell selector">
      <section>
        <p className="eyebrow">SOCIAL TRADING FLOOR</p>
        <h1>OUTCRY</h1>
        <p>Shout the trade. Hide the quote. Win the pit.</p>
      </section>
      <section className="world-grid" aria-label="Worlds">
        {worlds.map((world) => (
          <button
            className="world-card"
            disabled={!world.ready}
            key={world.id}
            onClick={() => setWorldId(world.id)}
            type="button"
          >
            <span>{world.name}</span>
            <small>{world.online} online · {world.pits} active pits</small>
            <strong>{world.ready ? "Enter world" : "Coming soon"}</strong>
          </button>
        ))}
      </section>
    </main>
  );
}
