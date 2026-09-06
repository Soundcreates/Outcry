import Phaser from "phaser";
import type { PlayerState, WorldState } from "@outcry/shared/world-state";
import type { WorldRoom } from "./createWorldGame";
import avatar01 from "../../../../avatar_images/avatar_01_walk.png";
import avatar02 from "../../../../avatar_images/avatar_02_walk.png";
import avatar03 from "../../../../avatar_images/avatar_03_walk.png";
import avatar04 from "../../../../avatar_images/avatar_04_walk.png";
import avatar05 from "../../../../avatar_images/avatar_05_walk.png";
import avatar06 from "../../../../avatar_images/avatar_06_walk.png";
import avatar07 from "../../../../avatar_images/avatar_07_walk.png";
import avatar08 from "../../../../avatar_images/avatar_08_walk.png";
import avatar09 from "../../../../avatar_images/avatar_09_walk.png";
import avatar10 from "../../../../avatar_images/avatar_10_walk.png";

const PLAYER_SPEED = 150;
const DECOR_COLLISIONS = {
  tree: { width: 24, height: 16 },
  bench: { width: 56, height: 14 },
  bin: { width: 18, height: 18 },
  planter: { width: 56, height: 12 },
  lamp: { width: 14, height: 12 },
} as const;

const AVATAR_IMAGES = [
  avatar01,
  avatar02,
  avatar03,
  avatar04,
  avatar05,
  avatar06,
  avatar07,
  avatar08,
  avatar09,
  avatar10,
] as const;

type Direction = "down" | "left" | "right" | "up";
type RemotePlayer = {
  sprite: Phaser.GameObjects.Sprite;
  targetX: number;
  targetY: number;
  avatarIndex: number;
};

type InteractiveSeat = {
  pitId: string;
  seatIndex: number;
  x: number;
  y: number;
  facing: string;
  interactionRadius: number;
};

export type WorldSceneCallbacks = {
  onSeatEnter?: (seat: { pitId: string; seatIndex: number; matchAddress?: string; chainConfirmed?: boolean }) => void;
  onSeatExit?: () => void;
};

export class WorldScene extends Phaser.Scene {
  private readonly worldId: string;
  private readonly room?: WorldRoom;
  private readonly callbacks: WorldSceneCallbacks;
  private readonly mapSlug: string;
  private player?: Phaser.Physics.Arcade.Sprite;
  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd?: Record<"W" | "A" | "S" | "D", Phaser.Input.Keyboard.Key>;
  private interactKey?: Phaser.Input.Keyboard.Key;
  private releaseKey?: Phaser.Input.Keyboard.Key;
  private interactionText?: Phaser.GameObjects.Text;
  private interactionFeedback = "";
  private feedbackUntil = 0;
  private inputSequence = 0;
  private readonly remotePlayers = new Map<string, RemotePlayer>();
  private interactiveSeats: InteractiveSeat[] = [];
  private seatOverlayOpen = false;
  private playerAvatarIndex = 0;

  constructor(worldId: string, room?: WorldRoom, callbacks: WorldSceneCallbacks = {}) {
    super({ key: "WorldScene" });
    this.worldId = worldId;
    this.mapSlug = worldId;
    this.room = room;
    this.callbacks = callbacks;
  }

  preload() {
    this.load.tilemapTiledJSON("world", `/${this.mapSlug}/world.tmj`);
    if (this.mapSlug === "tokyo-night") {
      this.load.image("world-background", `/${this.mapSlug}/assets/background.png`);
    } else {
      this.load.image("outcry-floor", `/${this.mapSlug}/assets/floor.svg`);
      for (const asset of ["tree", "bench", "bin", "dust", "planter", "lamp"]) {
        this.load.image(asset, `/${this.mapSlug}/assets/${asset}.svg`);
      }
    }
    AVATAR_IMAGES.forEach((image, index) => {
      this.load.spritesheet(`avatar-${index}`, image, { frameWidth: 32, frameHeight: 48 });
    });
  }

  create() {
    const map = this.make.tilemap({ key: "world" });
    if (this.mapSlug === "tokyo-night") {
      this.add
        .image(map.widthInPixels / 2, map.heightInPixels / 2, "world-background")
        .setOrigin(0.5)
        .setDisplaySize(map.widthInPixels, map.heightInPixels)
        .setDepth(-100);
    } else {
      const tileset = map.addTilesetImage("outcry-floor", "outcry-floor");
      if (!tileset) throw new Error("Unable to load OUTCRY tileset");

      for (const layerName of ["ground", "floor_decor", "furniture"]) {
        map.createLayer(layerName, tileset, 0, 0);
      }
    }

    const decor = map.getObjectLayer("objects_decor")?.objects ?? [];
    this.renderDecor(decor);
    const pits = map.getObjectLayer("objects_pits")?.objects ?? [];
    const seats = map.getObjectLayer("objects_seats")?.objects ?? [];
    const pitById = new Map(
      pits.map((pit) => [this.propertyValue(pit, "pitId") ?? pit.name, pit] as const),
    );
    this.interactiveSeats = seats.flatMap((seat) => {
      const pitId = this.propertyValue(seat, "pitId");
      const seatIndex = this.propertyValue(seat, "seatIndex");
      const pit = typeof pitId === "string" ? pitById.get(pitId) : undefined;
      if (typeof pitId !== "string" || typeof seatIndex !== "number" || !pit) return [];
      return [{
        pitId,
        seatIndex,
        x: seat.x ?? 0,
        y: seat.y ?? 0,
        facing: String(this.propertyValue(seat, "facing") ?? "south"),
        interactionRadius: Number(this.propertyValue(pit, "interactionRadius") ?? 48),
      }];
    });
    this.renderPitMarkers(pits, seats);

    const collisionBodies = this.physics.add.staticGroup();
    for (const object of map.getObjectLayer("collision")?.objects ?? []) {
      const x = object.x ?? 0;
      const y = object.y ?? 0;
      const width = object.width ?? 0;
      const height = object.height ?? 0;
      const wall = collisionBodies.create(
        x + width / 2,
        y + height / 2,
        "avatar-0",
      );
      wall.setVisible(false).setDisplaySize(width, height);
      wall.refreshBody();
    }

    for (const pit of pits) {
      const blocker = collisionBodies.create(
        (pit.x ?? 0) + (pit.width ?? 0) / 2,
        (pit.y ?? 0) + (pit.height ?? 0) / 2,
        "avatar-0",
      );
      blocker
        .setVisible(false)
        .setDisplaySize(pit.width ?? 0, pit.height ?? 0)
        .refreshBody();
    }

    for (const seat of seats) {
      const blocker = collisionBodies.create(seat.x ?? 0, seat.y ?? 0, "avatar-0");
      blocker.setVisible(false).setDisplaySize(18, 18).refreshBody();
    }

    for (const object of decor) {
      const asset = object.properties?.find(
        (property: { name: string; value: unknown }) => property.name === "asset",
      )?.value;
      const size = typeof asset === "string"
        ? DECOR_COLLISIONS[asset as keyof typeof DECOR_COLLISIONS]
        : undefined;
      if (!size) continue;

      const blocker = collisionBodies.create(
        object.x ?? 0,
        (object.y ?? 0) - size.height / 2,
        "avatar-0",
      );
      blocker.setVisible(false).setDisplaySize(size.width, size.height).refreshBody();
    }

    const spawn = map.getObjectLayer("objects_spawn")?.objects[0];
    if (!spawn) throw new Error("Map has no spawn point");

    this.playerAvatarIndex = this.avatarIndexForSession(this.room?.sessionId ?? "preview");
    this.player = this.physics.add.sprite(
      spawn.x ?? 0,
      spawn.y ?? 0,
      `avatar-${this.playerAvatarIndex}`,
    );
    this.player.setBodySize(18, 24, true);
    this.player.setCollideWorldBounds(true);
    this.physics.add.collider(this.player, collisionBodies);
    this.physics.world.setBounds(0, 0, map.widthInPixels, map.heightInPixels);
    this.cameras.main.setBounds(0, 0, map.widthInPixels, map.heightInPixels);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
    this.createAnimations();
    if (this.room) {
      this.room.onStateChange((state) => this.syncServerState(state));
      this.room.onMessage("seat", (result) => this.handleSeatResult(result));
      this.syncServerState(this.room.state);
    }
    if (this.mapSlug !== "tokyo-night") {
      const tileset = map.addTilesetImage("outcry-floor", "outcry-floor");
      if (tileset) map.createLayer("above_player", tileset, 0, 0);
    }
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys("W,A,S,D") as typeof this.wasd;
    this.interactKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.E);
    this.releaseKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.R);
    this.add
      .text(16, 16, `${this.worldId.toUpperCase()}  ·  WASD / arrows to walk`, {
        color: "#f4f1ea",
        fontFamily: "monospace",
        fontSize: "14px",
        backgroundColor: "#0b0b0fcc",
        padding: { x: 8, y: 6 },
      })
      .setScrollFactor(0)
      .setDepth(10);
    this.interactionText = this.add
      .text(16, 52, "", {
        color: "#ffb347",
        fontFamily: "monospace",
        fontSize: "13px",
        backgroundColor: "#0b0b0fcc",
        padding: { x: 8, y: 6 },
      })
      .setScrollFactor(0)
      .setDepth(10)
      .setVisible(false);
  }

  update() {
    if (!this.player || !this.cursors || !this.wasd) return;

    const localState = this.room?.state.players.get(this.room.sessionId);
    this.updateInteraction(localState);
    const canMove = !this.room || localState?.mode === "WALKING";

    const left = this.cursors.left.isDown || this.wasd.A.isDown;
    const right = this.cursors.right.isDown || this.wasd.D.isDown;
    const up = this.cursors.up.isDown || this.wasd.W.isDown;
    const down = this.cursors.down.isDown || this.wasd.S.isDown;
    const velocity = new Phaser.Math.Vector2(Number(right) - Number(left), Number(down) - Number(up));
    if (this.room && canMove && this.room.connection.isOpen) {
      this.room.send("input", {
        seq: this.inputSequence++,
        left,
        right,
        up,
        down,
        dtMs: Math.min(Math.max(this.game.loop.delta, 0), 50),
      });
    }

    if (!canMove) {
      this.player.setVelocity(0, 0);
      this.player.anims.stop();
      this.updateRemotePlayers();
      return;
    }

    if (velocity.lengthSq() === 0) {
      this.player.setVelocity(0, 0);
      this.player.anims.stop();
      this.updateRemotePlayers();
      return;
    }

    velocity.normalize().scale(PLAYER_SPEED);
    this.player.setVelocity(velocity.x, velocity.y);
    this.player.anims.play(this.animationKey(this.playerAvatarIndex, this.direction(velocity.x, velocity.y)), true);
    this.updateRemotePlayers();
  }

  private syncServerState(state: WorldState) {
    const localId = this.room?.sessionId;
    const localState = localId ? state.players.get(localId) : undefined;
    if (localState && this.player) {
      this.player.setPosition(localState.x, localState.y);
      this.player.setDepth(localState.y);
      if (this.player.body) this.player.body.enable = localState.mode !== "SEATED";
      if (this.seatOverlayOpen && localState.mode === "WALKING") {
        this.seatOverlayOpen = false;
        this.callbacks.onSeatExit?.();
      }
    }

    const seen = new Set<string>();
    state.players.forEach((player, sessionId) => {
      if (sessionId === localId) return;
      seen.add(sessionId);
      const remote = this.remotePlayers.get(sessionId);
      if (remote) {
        remote.targetX = player.x;
        remote.targetY = player.y;
        remote.sprite.setAlpha(player.mode === "RECONNECTING" ? 0.45 : 1);
        this.updateAnimation(remote.sprite, remote.avatarIndex, player.facing, player.mode === "WALKING");
        return;
      }

      const avatarIndex = this.avatarIndexForSession(sessionId);
      this.remotePlayers.set(sessionId, {
        sprite: this.add.sprite(player.x, player.y, `avatar-${avatarIndex}`).setDepth(player.y),
        targetX: player.x,
        targetY: player.y,
        avatarIndex,
      });
      this.updateAnimation(this.remotePlayers.get(sessionId)!.sprite, avatarIndex, player.facing, player.mode === "WALKING");
    });

    for (const [sessionId, remote] of this.remotePlayers) {
      if (seen.has(sessionId)) continue;
      remote.sprite.destroy();
      this.remotePlayers.delete(sessionId);
    }
  }

  private updateInteraction(localState: PlayerState | undefined) {
    if (!this.interactionText || !this.room) return;
    if (this.feedbackUntil > this.time.now) {
      this.interactionText.setText(this.interactionFeedback).setVisible(true);
      return;
    }

    if (localState?.mode === "SEATED") {
      this.interactionText
        .setText(`${localState.pitId} · seat ${localState.seatIndex} · press R to leave`)
        .setVisible(true);
      if (this.releaseKey && Phaser.Input.Keyboard.JustDown(this.releaseKey)) {
        this.room.send("releaseSeat");
      }
      return;
    }

    if (!this.player || localState?.mode !== "WALKING") {
      this.interactionText.setVisible(false);
      return;
    }
    const seat = this.nearestAvailableSeat(this.player.x, this.player.y);
    if (!seat) {
      this.interactionText.setVisible(false);
      return;
    }
    this.interactionText
      .setText(`Press E to sit · ${seat.pitId} · seat ${seat.seatIndex}`)
      .setVisible(true);
    if (this.interactKey && Phaser.Input.Keyboard.JustDown(this.interactKey)) {
      this.room.send("interact", { pitId: seat.pitId, seatIndex: seat.seatIndex });
    }
  }

  private nearestAvailableSeat(x: number, y: number) {
    return this.interactiveSeats
      .filter((seat) => {
        const state = this.room?.state.pits.get(seat.pitId)?.seats.get(String(seat.seatIndex));
        return (!state || state.status === "FREE") &&
          Math.hypot(x - seat.x, y - seat.y) <= seat.interactionRadius;
      })
      .sort((left, right) =>
        Math.hypot(x - left.x, y - left.y) - Math.hypot(x - right.x, y - right.y),
      )[0];
  }

  private handleSeatResult(result: unknown) {
    if (!result || typeof result !== "object") return;
    const value = result as {
      accepted?: boolean;
      action?: string;
      reason?: string;
      seat?: { pitId?: string; seatIndex?: number };
    };
    if (
      value.accepted &&
      (value.action === "reserved" || value.action === "confirmed" || value.action === "restored") &&
      typeof value.seat?.pitId === "string" &&
      typeof value.seat.seatIndex === "number"
    ) {
      this.seatOverlayOpen = true;
      this.callbacks.onSeatEnter?.({
        pitId: value.seat.pitId,
        seatIndex: value.seat.seatIndex,
        matchAddress: this.room?.state.pits.get(value.seat.pitId)?.activeMatchId || undefined,
        chainConfirmed: value.action === "confirmed" || value.action === "restored",
      });
    }
    if (value.accepted && value.action === "released") {
      this.seatOverlayOpen = false;
      this.callbacks.onSeatExit?.();
    }
    const reason = value.reason === "chain_match_unavailable"
      ? "Match unavailable · onchain setup required"
      : value.reason ?? "request rejected";
    this.interactionFeedback = value.accepted
      ? value.action === "released" ? "Seat released" : `Seat ${value.action ?? "updated"}`
      : `Seat unavailable · ${reason}`;
    this.feedbackUntil = this.time.now + 1800;
  }

  private propertyValue(object: Phaser.Types.Tilemaps.TiledObject, name: string) {
    return object.properties?.find(
      (property: { name: string; value: unknown }) => property.name === name,
    )?.value;
  }

  private updateRemotePlayers() {
    for (const remote of this.remotePlayers.values()) {
      remote.sprite.x = Phaser.Math.Linear(remote.sprite.x, remote.targetX, 0.35);
      remote.sprite.y = Phaser.Math.Linear(remote.sprite.y, remote.targetY, 0.35);
      remote.sprite.setDepth(remote.sprite.y);
    }
  }

  private avatarIndexForSession(sessionId: string) {
    let hash = 0;
    for (const character of sessionId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    return hash % AVATAR_IMAGES.length;
  }

  private direction(x: number, y: number): Direction {
    if (Math.abs(x) > Math.abs(y)) return x < 0 ? "left" : "right";
    return y < 0 ? "up" : "down";
  }

  private animationKey(avatarIndex: number, direction: Direction) {
    return `avatar-${avatarIndex}-walk-${direction}`;
  }

  private updateAnimation(
    sprite: Phaser.GameObjects.Sprite,
    avatarIndex: number,
    facing: string,
    walking: boolean,
  ) {
    if (!walking) {
      sprite.anims.stop();
      return;
    }
    const direction = ["down", "left", "right", "up"].includes(facing as Direction)
      ? facing as Direction
      : "down";
    sprite.anims.play(this.animationKey(avatarIndex, direction), true);
  }

  private createAnimations() {
    const ranges: Record<Direction, [number, number]> = {
      down: [0, 3],
      left: [4, 7],
      right: [8, 11],
      up: [12, 15],
    };
    for (let avatarIndex = 0; avatarIndex < AVATAR_IMAGES.length; avatarIndex += 1) {
      for (const [direction, [start, end]] of Object.entries(ranges) as [Direction, [number, number]][]) {
        this.anims.create({
          key: this.animationKey(avatarIndex, direction),
          frames: this.anims.generateFrameNumbers(`avatar-${avatarIndex}`, { start, end }),
          frameRate: 8,
          repeat: -1,
        });
      }
    }
  }

  private renderDecor(objects: Phaser.Types.Tilemaps.TiledObject[]) {
    for (const object of objects) {
      const asset = object.properties?.find(
        (property: { name: string; value: unknown }) => property.name === "asset",
      )?.value;
      if (typeof asset !== "string") continue;

      const image = this.add.image(object.x ?? 0, object.y ?? 0, asset);
      if (asset === "dust") {
        image.setOrigin(0.5, 0.5).setDepth(1);
      } else {
        image.setOrigin(0.5, 1).setDepth(object.y ?? 0);
      }
    }
  }

  private renderPitMarkers(
    pits: Phaser.Types.Tilemaps.TiledObject[],
    seats: Phaser.Types.Tilemaps.TiledObject[],
  ) {
    for (const pit of pits) {
      const x = pit.x ?? 0;
      const y = pit.y ?? 0;
      const width = pit.width ?? 0;
      const height = pit.height ?? 0;
      const pitId = pit.properties?.find(
        (property: { name: string; value: unknown }) => property.name === "pitId",
      )?.value ?? pit.name;
      this.add
        .rectangle(x + width / 2, y + height / 2, width + 12, height + 12)
        .setStrokeStyle(2, 0xffb347, 0.55)
        .setFillStyle(0x0b0b0f, 0)
        .setDepth(2);
      this.add
        .text(x, y - 22, String(pitId), {
          color: "#ffb347",
          fontFamily: "monospace",
          fontSize: "10px",
        })
        .setDepth(3);
    }

    for (const seat of seats) {
      const x = seat.x ?? 0;
      const y = seat.y ?? 0;
      const facing = String(this.propertyValue(seat, "facing") ?? "south").toLowerCase();
      const horizontal = facing === "east" || facing === "west";
      const backrestOffset = facing === "south" ? -5 : facing === "north" ? 5 : 0;
      const sideOffset = facing === "east" ? -5 : facing === "west" ? 5 : 0;
      this.add
        .rectangle(x + sideOffset, y + backrestOffset, horizontal ? 4 : 16, horizontal ? 16 : 4, 0x162236, 0.95)
        .setStrokeStyle(1, 0x6df7e8, 0.9)
        .setDepth(3);
      this.add
        .rectangle(x, y, horizontal ? 8 : 16, horizontal ? 16 : 8, 0x312245, 0.95)
        .setStrokeStyle(1, 0xff4fc3, 0.85)
        .setDepth(3);
    }
  }
}
