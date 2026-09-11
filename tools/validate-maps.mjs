import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const REQUIRED_LAYERS = [
  "ground",
  "floor_decor",
  "furniture",
  "collision",
  "above_player",
  "objects_spawn",
  "objects_pits",
  "objects_seats",
  "objects_portals",
  "objects_decor",
];

const DECOR_ASSETS = new Set(["tree", "bench", "bin", "dust", "planter", "lamp"]);

function propertyMap(object) {
  return new Map((object.properties ?? []).map(({ name, value }) => [name, value]));
}

function hasPngAlpha(buffer) {
  return buffer.length >= 26 && buffer.toString("ascii", 1, 4) === "PNG" && [4, 6].includes(buffer[25]);
}

function isInside(point, rectangle) {
  return (
    point.x >= rectangle.x &&
    point.x <= rectangle.x + rectangle.width &&
    point.y >= rectangle.y &&
    point.y <= rectangle.y + rectangle.height
  );
}

export function validateMap(map, source = "map") {
  const errors = [];
  const layers = new Map((map.layers ?? []).map((layer) => [layer.name, layer]));
  const fail = (message) => errors.push(`${source}: ${message}`);

  for (const name of REQUIRED_LAYERS) {
    if (!layers.has(name)) fail(`missing layer ${name}`);
  }

  if (map.orientation !== "orthogonal" || map.tilewidth !== 32 || map.tileheight !== 32) {
    fail("map must be orthogonal with 32px tiles");
  }
  if (!map.tilesets?.length || map.tilesets.some((tileset) => tileset.source)) {
    fail("runtime map must embed tilesets");
  }

  for (const decor of layers.get("objects_decor")?.objects ?? []) {
    const asset = propertyMap(decor).get("asset");
    if (decor.class !== "Decor" || typeof asset !== "string" || !DECOR_ASSETS.has(asset)) {
      fail(`invalid decor ${decor.name || decor.id}`);
    }
  }

  const spawns = layers.get("objects_spawn")?.objects ?? [];
  if (spawns.length < 1) fail("missing spawn point");
  for (const spawn of spawns) {
    const properties = propertyMap(spawn);
    if (spawn.class !== "Spawn" || typeof properties.get("spawnId") !== "string") {
      fail(`invalid spawn ${spawn.name || spawn.id}`);
    }
  }

  const pits = layers.get("objects_pits")?.objects ?? [];
  if (pits.length < 2) fail("at least two pits are required");
  const pitIds = new Set();
  for (const pit of pits) {
    const properties = propertyMap(pit);
    const pitId = properties.get("pitId");
    const capacity = properties.get("capacity");
    if (pit.class !== "Pit" || typeof pitId !== "string" || pitIds.has(pitId)) {
      fail(`invalid or duplicate pit ${pit.name || pit.id}`);
    }
    pitIds.add(pitId);
    for (const [name, value] of [["capacity", capacity], ["interactionRadius", properties.get("interactionRadius")], ["minPlayers", properties.get("minPlayers")]]) {
      if (!Number.isInteger(value) || value < 1) fail(`pit ${pitId || pit.name} has invalid ${name}`);
    }
  }

  const collisions = (layers.get("collision")?.objects ?? []).filter(
    (object) => object.width > 0 && object.height > 0,
  );
  const seats = layers.get("objects_seats")?.objects ?? [];
  const seenSeats = new Set();
  for (const seat of seats) {
    const properties = propertyMap(seat);
    const pitId = properties.get("pitId");
    const seatIndex = properties.get("seatIndex");
    const key = `${pitId}:${seatIndex}`;
    if (
      seat.class !== "PitSeat" ||
      typeof pitId !== "string" ||
      !pitIds.has(pitId) ||
      !Number.isInteger(seatIndex) ||
      seatIndex < 0 ||
      seatIndex > 3 ||
      seenSeats.has(key) ||
      typeof properties.get("facing") !== "string"
    ) {
      fail(`invalid or duplicate seat ${seat.name || seat.id}`);
    }
    if (collisions.some((collision) => isInside(seat, collision))) {
      fail(`seat ${seat.name || seat.id} lies inside collision`);
    }
    seenSeats.add(key);
  }

  for (const pit of pits) {
    const properties = propertyMap(pit);
    const pitId = properties.get("pitId");
    const capacity = properties.get("capacity");
    const count = seats.filter((seat) => propertyMap(seat).get("pitId") === pitId).length;
    if (count !== capacity) fail(`pit ${pitId} capacity ${capacity} != seat count ${count}`);
    if (seats.some((seat) => propertyMap(seat).get("pitId") === pitId && isInside(seat, pit))) {
      fail(`pit ${pitId} has a seat anchor inside its table collision`);
    }
  }

  return errors;
}

export async function validateFile(path) {
  const map = JSON.parse(await readFile(path, "utf8"));
  const errors = validateMap(map, path);
  if (basename(dirname(path)) !== "wall-street") {
    const pitPath = join(dirname(path), "assets", "pit.png");
    try {
      const pitAsset = await readFile(pitPath);
      if (!hasPngAlpha(pitAsset)) errors.push(`${pitPath}: pit asset must contain an alpha channel`);
    } catch {
      errors.push(`${path}: missing themed pit asset`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return map;
}

async function mapFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...(await mapFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".tmj")) paths.push(path);
  }
  return paths;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const paths = await mapFiles("apps/world-server/maps");
  if (!paths.length) throw new Error("No Tiled maps found");
  for (const path of paths) await validateFile(path);
  console.log(`map validation: ${paths.length}/${paths.length} map(s) passed`);
}
