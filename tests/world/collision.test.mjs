import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const map = JSON.parse(await readFile("apps/world-server/maps/wall-street/world.tmj", "utf8"));
const collisionLayer = map.layers.find((layer) => layer.name === "collision");
const pits = map.layers.find((layer) => layer.name === "objects_pits").objects;
const seats = map.layers.find((layer) => layer.name === "objects_seats").objects;
const decor = map.layers.find((layer) => layer.name === "objects_decor").objects;
const decorCollisions = {
  tree: { width: 24, height: 16 },
  bench: { width: 56, height: 14 },
  bin: { width: 18, height: 18 },
  planter: { width: 56, height: 12 },
  lamp: { width: 14, height: 12 },
};
const obstacles = [
  ...collisionLayer.objects,
  ...pits,
  ...seats.map((seat) => ({ x: seat.x - 9, y: seat.y - 9, width: 18, height: 18 })),
  ...decor.flatMap((object) => {
    const asset = object.properties.find((property) => property.name === "asset").value;
    const size = decorCollisions[asset];
    return size ? [{ x: object.x - size.width / 2, y: object.y - size.height, ...size }] : [];
  }),
];

function collides(point) {
  return obstacles.some((wall) =>
    point.x >= wall.x &&
    point.x <= wall.x + wall.width &&
    point.y >= wall.y &&
    point.y <= wall.y + wall.height,
  );
}

for (let run = 0; run < 10; run += 1) {
  let position = { x: 64, y: 64 };
  const wallAttempt = { x: 64, y: 16 };
  assert.equal(collides(wallAttempt), true, "north wall must block the route");
  assert.equal(collides({ x: 160, y: 160 }), true, "pit table must block movement");
  assert.equal(collides({ x: 160, y: 124 }), true, "seat must block movement");
  assert.equal(collides({ x: 64, y: 312 }), true, "tree must block movement");
  assert.equal(collides({ x: 104, y: 329 }), true, "bench must block movement");
  assert.equal(collides({ x: 112, y: 391 }), true, "bin must block movement");
  assert.equal(collides({ x: 64, y: 250 }), true, "planter must block movement");
  assert.equal(collides({ x: 64, y: 106 }), true, "lamp must block movement");
  assert.equal(collides({ x: 272, y: 248 }), false, "ground dust must remain walkable");
  if (!collides(wallAttempt)) position = wallAttempt;

  for (const point of [
    { x: 96, y: 64 },
    { x: 96, y: 96 },
    { x: 96, y: 224 },
  ]) {
    assert.equal(collides(point), false, "corridor/pit route must remain open");
    position = point;
  }

  assert.deepEqual(position, { x: 96, y: 224 });
}

console.log("collision route: 10/10 runs blocked walls, pits, seats, and solid decor; reached pit edge");
