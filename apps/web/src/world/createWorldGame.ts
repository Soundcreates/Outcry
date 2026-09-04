import Phaser from "phaser";
import type { Room } from "@colyseus/sdk";
import type { WorldState } from "@outcry/shared/world-state";
import { WorldScene, type WorldSceneCallbacks } from "./WorldScene";

export type WorldRoom = Room<any, WorldState>;

export function createWorldGame(
  parent: HTMLElement,
  worldId: string,
  room?: WorldRoom,
  callbacks?: WorldSceneCallbacks,
) {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: 640,
    height: 480,
    backgroundColor: "#0b0b0f",
    pixelArt: true,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    physics: {
      default: "arcade",
      arcade: { debug: false },
    },
    scene: [new WorldScene(worldId, room, callbacks)],
  });
}
