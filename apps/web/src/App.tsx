import { useEffect, useState } from "react";
import WorldCanvas from "./world/WorldCanvas";

type WorldCard = {
  id: string;
  name: string;
  online: number;
  pits: number;
  ready: boolean;
};

const initialWorlds: WorldCard[] = [
  { id: "wall-street", name: "Wall Street", online: 0, pits: 2, ready: true },
  { id: "tokyo-night", name: "Tokyo Night", online: 0, pits: 0, ready: false },
];

const worldHttp = import.meta.env.VITE_WORLD_HTTP ||
  (import.meta.env.VITE_WORLD_WS || "ws://localhost:2567").replace(/^ws/, "http");

export default function App() {
  const [worldId, setWorldId] = useState<string | null>(null);
  const [worlds, setWorlds] = useState(initialWorlds);

  useEffect(() => {
    let active = true;
    const refreshWorlds = async () => {
      try {
        const response = await fetch(`${worldHttp}/api/worlds`);
        if (!response.ok) return;
        const payload = await response.json() as { worlds?: Array<{ id: string; online: number; activePits: number }> };
        if (!active || !Array.isArray(payload.worlds)) return;
        const stats = new Map(payload.worlds.map((world) => [world.id, world]));
        setWorlds((current) => current.map((world) => {
          const stat = stats.get(world.id);
          return stat ? { ...world, online: stat.online, pits: stat.activePits } : world;
        }));
      } catch {
        // The card remains honest at zero while the world server is offline.
      }
    };

    void refreshWorlds();
    const interval = window.setInterval(refreshWorlds, 3_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

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
