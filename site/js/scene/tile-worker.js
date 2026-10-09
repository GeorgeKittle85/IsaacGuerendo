// Tile worker: fetches, decompresses and prepares scenery tiles off the main
// thread (see tiledata.js), then hands the typed arrays back without copying.
//
// A tile's placed OpenStreetMap data stays here while the tile is loaded, so
// the meshes of its small buildings and streets can be built when the
// aircraft comes near ({chunk}), until the tile goes ({drop}).

import { fetchGz, prepareTile, transferList } from "./tiledata.js";
import { buildMeshes, meshTransfers } from "./osmdata.js";

const placed = new Map(); // tile key -> placeOsm() result

self.onmessage = async (e) => {
  const m = e.data;
  if (m.drop !== undefined) {
    placed.delete(m.drop);
    return;
  }
  try {
    if (m.chunk !== undefined) {
      const p = placed.get(m.key);
      const mesh = p ? buildMeshes(p, m.chunk) : null;
      self.postMessage({ id: m.id, mesh }, mesh ? meshTransfers(mesh) : []);
      return;
    }
    const [buf, osm] = await Promise.all([
      fetchGz(m.url),
      m.osmUrl ? fetchGz(m.osmUrl).catch(() => null) : null,
    ]);
    const prep = prepareTile(buf, { satBounds: m.satBounds, osm });
    if (prep.placed) {
      placed.set(m.key, prep.placed);
      delete prep.placed;
    }
    self.postMessage({ id: m.id, prep }, transferList(prep));
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err?.message ?? err) });
  }
};
