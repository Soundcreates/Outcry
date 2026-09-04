import { readFile } from "node:fs/promises";

export type CollisionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PitDefinition = CollisionRect & {
  pitId: string;
  capacity: number;
  interactionRadius: number;
  minPlayers: number;
};

export type SeatDefinition = {
  pitId: string;
  seatIndex: number;
  x: number;
  y: number;
  facing: string;
};

export type WorldGeometry = {
  spawn: { x: number; y: number };
  width: number;
  height: number;
  obstacles: CollisionRect[];
  pits: PitDefinition[];
  seats: SeatDefinition[];
  collides: (x: number, y: number, width: number, height: number) => boolean;
};

type TiledObject = {
  x: number;
  y: number;
  width?: number;
  height?: number;
  properties?: { name: string; value: unknown }[];
};

type TiledLayer = {
  name: string;
  objects?: TiledObject[];
};

const DECOR_COLLISIONS = {
  tree: { width: 24, height: 16 },
  bench: { width: 56, height: 14 },
  bin: { width: 18, height: 18 },
  planter: { width: 56, height: 12 },
  lamp: { width: 14, height: 12 },
} as const;

function propertyValue(object: { properties?: { name: string; value: unknown }[] }, name: string) {
  return object.properties?.find((property) => property.name === name)?.value;
}

function numberProperty(object: TiledObject, name: string, fallback: number) {
  const value = propertyValue(object, name);
  return typeof value === "number" ? value : fallback;
}

function rectContains(rectangle: CollisionRect, x: number, y: number, width: number, height: number) {
  return (
    x < rectangle.x + rectangle.width &&
    x + width > rectangle.x &&
    y < rectangle.y + rectangle.height &&
    y + height > rectangle.y
  );
}

export async function loadWorldGeometry(): Promise<WorldGeometry> {
  const map = JSON.parse(
    await readFile(new URL("../../../../maps/wall-street/world.tmj", import.meta.url), "utf8"),
  );
  const layers = new Map(
    ((map.layers ?? []) as TiledLayer[]).map((layer) => [layer.name, layer] as const),
  );
  const pits = (layers.get("objects_pits")?.objects ?? []).flatMap((object) => {
    const pitId = propertyValue(object, "pitId");
    if (typeof pitId !== "string") return [];
    return [{
      pitId,
      x: object.x,
      y: object.y,
      width: object.width ?? 0,
      height: object.height ?? 0,
      capacity: numberProperty(object, "capacity", 0),
      interactionRadius: numberProperty(object, "interactionRadius", 0),
      minPlayers: numberProperty(object, "minPlayers", 0),
    }];
  });
  const seats = (layers.get("objects_seats")?.objects ?? []).flatMap((object) => {
    const pitId = propertyValue(object, "pitId");
    const seatIndex = propertyValue(object, "seatIndex");
    const facing = propertyValue(object, "facing");
    if (typeof pitId !== "string" || typeof seatIndex !== "number" || typeof facing !== "string") return [];
    return [{ pitId, seatIndex, x: object.x, y: object.y, facing }];
  });
  const obstacles: CollisionRect[] = [
    ...((layers.get("collision")?.objects ?? []) as CollisionRect[]),
    ...pits,
    ...seats.map((seat) => ({
      x: seat.x - 9,
      y: seat.y - 9,
      width: 18,
      height: 18,
    })),
  ];

  for (const object of layers.get("objects_decor")?.objects ?? []) {
    const asset = propertyValue(object, "asset");
    const size = typeof asset === "string"
      ? DECOR_COLLISIONS[asset as keyof typeof DECOR_COLLISIONS]
      : undefined;
    if (size) {
      obstacles.push({
        x: object.x - size.width / 2,
        y: object.y - size.height,
        ...size,
      });
    }
  }

  const spawn = layers.get("objects_spawn")?.objects?.[0];
  if (!spawn) throw new Error("Map has no spawn point");

  return {
    spawn: { x: spawn.x, y: spawn.y },
    width: map.width * map.tilewidth,
    height: map.height * map.tileheight,
    obstacles,
    pits,
    seats,
    collides: (x, y, width, height) =>
      x < 0 || y < 0 || x + width > map.width * map.tilewidth || y + height > map.height * map.tileheight ||
      obstacles.some((obstacle) => rectContains(obstacle, x, y, width, height)),
  };
}
