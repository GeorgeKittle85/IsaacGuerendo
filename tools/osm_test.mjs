// OpenStreetMap layer and aerial imagery test (Node only): prepares a few
// scenery tiles with their OSM data and image bounds the way the tile worker
// does (site/js/scene/tiledata.js, osmdata.js) and checks the result:
// every building stands on the tile's terrain, every mesh index points at a
// vertex, every position is finite, the chunks hold the buildings the
// landmark mesh leaves out, and the image coordinates cover the tile.
//
// Usage: node tools/osm_test.mjs [tile id ...]

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { prepareTile } from "../site/js/scene/tiledata.js";
import { buildMeshes, CHUNKS, decodeOsm } from "../site/js/scene/osmdata.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const scenery = path.join(here, "../site/data/scenery");
const osmIndexFile = path.join(scenery, "osm/index.json");
if (!existsSync(osmIndexFile)) {
  console.log("skip: no site/data/scenery/osm (tools/build_osm.py)");
  process.exit(0);
}
const osmIndex = JSON.parse(readFileSync(osmIndexFile, "utf8"));
const imageryFile = path.join(scenery, "imagery/index.json");
const imagery = existsSync(imageryFile) ? JSON.parse(readFileSync(imageryFile, "utf8")).tiles : {};
const tiles = new Map(JSON.parse(readFileSync(path.join(scenery, "index.json"), "utf8")).tiles.map((t) => [t.id, t]));

// San Francisco and its airport, downtown Portland and PDX, Bend, the high desert.
const ids = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [942066, 942050, 942561, 958850, 991545];
let ok = true;
const check = (cond, msg) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) ok = false;
};
const read = (p) => {
  const b = gunzipSync(readFileSync(p));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

function checkBatches(batches, what) {
  let verts = 0, bad = 0;
  for (const b of batches) {
    verts += b.count;
    if (b.count > 65536) bad++;
    for (let i = 0; i < b.index.length; i++) if (b.index[i] >= b.count) { bad++; break; }
    for (let i = 0; i < b.position.length; i++) if (!Number.isFinite(b.position[i])) { bad++; break; }
    if (b.index.length % 3) bad++;
  }
  return { verts, bad, what };
}

for (const id of ids) {
  const info = tiles.get(id);
  const entry = osmIndex.tiles[id];
  if (!info || !entry) {
    console.log(`skip: tile ${id} has no OSM data`);
    continue;
  }
  const osm = read(path.join(scenery, `osm/${id}.bin.gz`));
  const decoded = decodeOsm(osm.slice(0));
  check(decoded.buildings.count === entry.buildings && decoded.roads.count === entry.roads,
    `tile ${id}: ${decoded.buildings.count} buildings and ${decoded.roads.count} roads, as the index says`);
  const sat = imagery[id]?.bounds ?? null;
  const t0 = performance.now();
  const prep = prepareTile(read(path.join(scenery, info.file)), { osm, satBounds: sat });
  const ms = performance.now() - t0;
  const P = prep.placed.b;
  let off = 0;
  for (let i = 0; i < P.count; i++) {
    if (!(P.base[i] >= prep.zmin - 1 && P.base[i] <= prep.zmax + 1)) off++;
  }
  check(off === 0, `tile ${id}: every building on the ground (${prep.zmin.toFixed(0)}..${prep.zmax.toFixed(0)} m), placed in ${ms.toFixed(0)} ms`);
  const major = [checkBatches(prep.osm.buildings, "landmark buildings"), checkBatches(prep.osm.roads, "main roads")];
  let minorBuildings = 0;
  const chunks = [];
  for (let c = 0; c < CHUNKS * CHUNKS; c++) {
    const m = buildMeshes(prep.placed, c);
    chunks.push(checkBatches(m.buildings, `chunk ${c} buildings`), checkBatches(m.roads, `chunk ${c} roads`));
  }
  for (let i = 0; i < P.count; i++) if (!P.major[i]) minorBuildings++;
  const all = [...major, ...chunks];
  const bad = all.filter((r) => r.bad);
  check(bad.length === 0, `tile ${id}: meshes well formed${bad.length ? ": " + bad.map((r) => r.what).join(", ") : ""}`);
  const chunkBuildingVerts = chunks.filter((r) => r.what.endsWith("buildings")).reduce((s, r) => s + r.verts, 0);
  check((minorBuildings === 0) === (chunkBuildingVerts === 0),
    `tile ${id}: ${P.count - minorBuildings} landmarks (${major[0].verts} vertices), ${minorBuildings} more buildings in the chunks (${chunkBuildingVerts} vertices)`);
  if (sat) {
    const uv = prep.satUv;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < uv.length; i++) {
      lo = Math.min(lo, uv[i]);
      hi = Math.max(hi, uv[i]);
    }
    check(lo > -0.002 && hi < 1.002 && hi > 0.99 && lo < 0.01, `tile ${id}: image coordinates span the image (${lo.toFixed(4)}..${hi.toFixed(4)})`);
  }
}
console.log(ok ? "PASS" : "FAILED");
process.exit(ok ? 0 : 1);
