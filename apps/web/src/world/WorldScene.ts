import Phaser from "phaser";

const PLAYER_SPEED = 150;

type Direction = "down" | "left" | "right" | "up";

export class WorldScene extends Phaser.Scene {
  private readonly worldId: string;
  private player?: Phaser.Physics.Arcade.Sprite;
  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd?: Record<"W" | "A" | "S" | "D", Phaser.Input.Keyboard.Key>;
  private readonly mapSlug = "wall-street";

  constructor(worldId: string) {
    super({ key: "WorldScene" });
    this.worldId = worldId;
  }

  preload() {
    this.load.tilemapTiledJSON("world", `/${this.mapSlug}/world.tmj`);
    this.load.image("outcry-floor", `/${this.mapSlug}/assets/floor.svg`);
    for (const asset of ["tree", "bench", "bin", "dust", "planter", "lamp"]) {
      this.load.image(asset, `/${this.mapSlug}/assets/${asset}.svg`);
    }
    this.load.spritesheet("trader", "/sprites/trader.svg", {
      frameWidth: 32,
      frameHeight: 48,
    });
  }

  create() {
    const map = this.make.tilemap({ key: "world" });
    const tileset = map.addTilesetImage("outcry-floor", "outcry-floor");
    if (!tileset) throw new Error("Unable to load OUTCRY tileset");

    for (const layerName of ["ground", "floor_decor", "furniture"]) {
      map.createLayer(layerName, tileset, 0, 0);
    }

    this.renderDecor(map.getObjectLayer("objects_decor")?.objects ?? []);
    const pits = map.getObjectLayer("objects_pits")?.objects ?? [];
    const seats = map.getObjectLayer("objects_seats")?.objects ?? [];
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
        "trader",
        0,
      );
      wall.setVisible(false).setDisplaySize(width, height);
      wall.refreshBody();
    }

    const spawn = map.getObjectLayer("objects_spawn")?.objects[0];
    if (!spawn) throw new Error("Map has no spawn point");

    this.player = this.physics.add.sprite(spawn.x ?? 0, spawn.y ?? 0, "trader", 0);
    this.player.setCollideWorldBounds(true);
    this.physics.add.collider(this.player, collisionBodies);
    this.physics.world.setBounds(0, 0, map.widthInPixels, map.heightInPixels);
    this.cameras.main.setBounds(0, 0, map.widthInPixels, map.heightInPixels);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
    map.createLayer("above_player", tileset, 0, 0);
    this.createAnimations();
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys("W,A,S,D") as typeof this.wasd;
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
  }

  update() {
    if (!this.player || !this.cursors || !this.wasd) return;

    const left = this.cursors.left.isDown || this.wasd.A.isDown;
    const right = this.cursors.right.isDown || this.wasd.D.isDown;
    const up = this.cursors.up.isDown || this.wasd.W.isDown;
    const down = this.cursors.down.isDown || this.wasd.S.isDown;
    const velocity = new Phaser.Math.Vector2(Number(right) - Number(left), Number(down) - Number(up));

    if (velocity.lengthSq() === 0) {
      this.player.setVelocity(0, 0);
      this.player.anims.stop();
      return;
    }

    velocity.normalize().scale(PLAYER_SPEED);
    this.player.setVelocity(velocity.x, velocity.y);
    this.player.anims.play(`walk-${this.direction(velocity.x, velocity.y)}`, true);
  }

  private direction(x: number, y: number): Direction {
    if (Math.abs(x) > Math.abs(y)) return x < 0 ? "left" : "right";
    return y < 0 ? "up" : "down";
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

  private createAnimations() {
    const ranges: Record<Direction, [number, number]> = {
      down: [0, 3],
      left: [4, 7],
      right: [8, 11],
      up: [12, 15],
    };
    for (const [direction, [start, end]] of Object.entries(ranges) as [Direction, [number, number]][]) {
      this.anims.create({
        key: `walk-${direction}`,
        frames: this.anims.generateFrameNumbers("trader", { start, end }),
        frameRate: 8,
        repeat: -1,
      });
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
      this.add.circle(seat.x ?? 0, seat.y ?? 0, 5, 0xffb347, 0.9).setDepth(3);
    }
  }
}
