import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateMap } from "../../tools/validate-maps.mjs";

const valid = JSON.parse(await readFile("apps/world-server/maps/wall-street/world.tmj", "utf8"));
assert.deepEqual(validateMap(valid), []);

function layer(map, name) {
  return map.layers.find((candidate) => candidate.name === name);
}

function clone(value) {
  return structuredClone(value);
}

const duplicatePit = clone(valid);
layer(duplicatePit, "objects_pits").objects[1].properties.find((property) => property.name === "pitId").value = "wall-street-01";
assert.match(validateMap(duplicatePit).join("\n"), /duplicate pit/);

const missingSpawn = clone(valid);
layer(missingSpawn, "objects_spawn").objects = [];
assert.match(validateMap(missingSpawn).join("\n"), /missing spawn/);

const badSeat = clone(valid);
layer(badSeat, "objects_seats").objects[0].properties.find((property) => property.name === "seatIndex").value = 4;
assert.match(validateMap(badSeat).join("\n"), /invalid or duplicate seat/);

const wrongCapacity = clone(valid);
layer(wrongCapacity, "objects_pits").objects[0].properties.find((property) => property.name === "capacity").value = 3;
assert.match(validateMap(wrongCapacity).join("\n"), /capacity 3 != seat count 4/);

const blockedSeat = clone(valid);
layer(blockedSeat, "collision").objects.push({ x: 128, y: 96, width: 32, height: 32 });
assert.match(validateMap(blockedSeat).join("\n"), /lies inside collision/);

const externalTileset = clone(valid);
externalTileset.tilesets[0] = { firstgid: 1, source: "tileset.tsj" };
assert.match(validateMap(externalTileset).join("\n"), /embed tilesets/);

const badDecor = clone(valid);
badDecor.layers.find((candidate) => candidate.name === "objects_decor").objects[0].properties[0].value = "missing-asset";
assert.match(validateMap(badDecor).join("\n"), /invalid decor/);

console.log("map validator: valid map + 7 invalid fixtures passed");
