import Phaser from "phaser";
import { WorldScene } from "./WorldScene";

export function createWorldGame(parent: HTMLElement, worldId: string) {
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
    scene: [new WorldScene(worldId)],
  });
}
