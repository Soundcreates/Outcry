import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const map = JSON.parse(await readFile("maps/wall-street/world.tmj", "utf8"));
const collisionLayer = map.layers.find((layer) => layer.name === "collision");
const walls = collisionLayer.objects;

function collides(point) {
  return walls.some((wall) =>
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
  if (!collides(wallAttempt)) position = wallAttempt;

  for (const point of [
    { x: 96, y: 64 },
    { x: 128, y: 64 },
    { x: 128, y: 96 },
    { x: 128, y: 224 },
  ]) {
    assert.equal(collides(point), false, "corridor/pit route must remain open");
    position = point;
  }

  assert.deepEqual(position, { x: 128, y: 224 });
}

console.log("collision route: 10/10 runs blocked wall penetration and reached pit");
