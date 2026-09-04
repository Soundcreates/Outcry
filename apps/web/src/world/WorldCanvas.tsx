import { useEffect, useRef } from "react";
import { createWorldGame } from "./createWorldGame";

type Props = {
  worldId: string;
  onExit: () => void;
};

export default function WorldCanvas({ worldId, onExit }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mountRef.current) return;
    const game = createWorldGame(mountRef.current, worldId);
    return () => game.destroy(true);
  }, [worldId]);

  return (
    <main className="world-shell">
      <button className="world-exit" onClick={onExit} type="button">
        Back to worlds
      </button>
      <div aria-label={`${worldId} trading floor`} ref={mountRef} />
    </main>
  );
}
