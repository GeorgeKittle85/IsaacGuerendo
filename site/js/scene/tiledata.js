// Scenery tile data: decoding, normals and the ground-collision grid.
//
// Pure functions on typed arrays with no three.js dependency, so they run in
// the tile worker (tile-worker.js) as well as on the main thread.

export async function fetchGz(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  // GitHub Pages and most hosts serve .gz as opaque bytes; decompress here.
  const ds = new DecompressionStream("gzip");
  return new Response(res.body.pipeThrough(ds)).arrayBuffer();
}

/** Parses the FGT2 tile format (see build_scenery.py). */
export function decodeTile(buf) {
  const dv = new DataView(buf);
  let o = 0;
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (magic !== "FGT2") throw new Error("bad tile magic " + magic);
  o = 8;
  const f64 = () => { const v = dv.getFloat64(o, true); o += 8; return v; };
  const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
  const align = () => { o = (o + 3) & ~3; };
  const center = [f64(), f64(), f64()];
  const lat = f64();
  const lon = f64();

  // Land cover: quantised shared vertex pool.
  const tv = u32(), ti = u32(), tg = u32(), twide = u32();
  const lo = [f64(), f64(), f64()];
  const span = [f64(), f64(), f64()];
  const tGroups = [];
  for (let i = 0; i < tg; i++) tGroups.push({ material: u32(), start: u32(), count: u32() });
  const q = new Uint16Array(buf.slice(o, o + tv * 6));
  o += tv * 6;
  align();
  const tIdx = twide ? new Uint32Array(buf.slice(o, o + ti * 4)) : new Uint16Array(buf.slice(o, o + ti * 2));
  o += ti * (twide ? 4 : 2);
  align();
  const tPos = new Float32Array(tv * 3);
  for (let i = 0; i < tv; i++) {
    tPos[i * 3] = lo[0] + (q[i * 3] / 65535) * span[0];
    tPos[i * 3 + 1] = lo[1] + (q[i * 3 + 1] / 65535) * span[1];
    tPos[i * 3 + 2] = lo[2] + (q[i * 3 + 2] / 65535) * span[2];
  }

  // Airport surfaces: float positions, normals and uvs.
  const sv = u32(), si = u32(), sg = u32(), swide = u32();
  const sGroups = [];
  for (let i = 0; i < sg; i++) sGroups.push({ material: u32(), start: u32(), count: u32() });
  let sPos = null, sNrm = null, sUv = null, sIdx = null;
  if (sv) {
    sPos = new Float32Array(buf.slice(o, o + sv * 12)); o += sv * 12;
    sNrm = new Int8Array(buf.slice(o, o + sv * 4)); o += sv * 4;
    sUv = new Float32Array(buf.slice(o, o + sv * 8)); o += sv * 8;
    sIdx = swide ? new Uint32Array(buf.slice(o, o + si * 4)) : new Uint16Array(buf.slice(o, o + si * 2));
    o += si * (swide ? 4 : 2);
    align();
  }

  const nl = u32();
  const lights = [];
  for (let i = 0; i < nl; i++) {
    const material = u32();
    const n = u32();
    const pos = new Float32Array(buf.slice(o, o + n * 12)); o += n * 12;
    const nrm = new Int8Array(buf.slice(o, o + n * 4)); o += n * 4;
    lights.push({ material, pos, nrm });
  }
  return {
    center, lat, lon,
    terrain: { pos: tPos, idx: tIdx, groups: tGroups },
    surface: sv ? { pos: sPos, nrm: sNrm, uv: sUv, idx: sIdx, groups: sGroups } : null,
    lights,
  };
}

/** Area-weighted smooth vertex normals (terrain normals are not stored). */
export function computeNormals(pos, idx) {
  const n = new Float32Array(pos.length);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    for (const k of [a, b, c]) {
      n[k] += nx; n[k + 1] += ny; n[k + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

/**
 * Uniform grid over a tile's east/north plane for ray casts against its
 * triangles (both land cover and airport surfaces).
 */
export class CollisionGrid {
  /** From precomputed grid data (see toData) or by building it now. */
  static from(meshes, data) {
    const g = Object.create(CollisionGrid.prototype);
    Object.assign(g, data);
    g.meshes = meshes;
    return g;
  }

  toData() {
    const { minX, minY, cell, nx, ny, start, items } = this;
    return { minX, minY, cell, nx, ny, start, items };
  }

  constructor(meshes, cell = 120) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const m of meshes) {
      for (let i = 0; i < m.pos.length; i += 3) {
        minX = Math.min(minX, m.pos[i]); maxX = Math.max(maxX, m.pos[i]);
        minY = Math.min(minY, m.pos[i + 1]); maxY = Math.max(maxY, m.pos[i + 1]);
      }
    }
    this.minX = minX; this.minY = minY; this.cell = cell;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
    this.ny = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
    this.meshes = meshes;
    const ncell = this.nx * this.ny;
    const counts = new Uint32Array(ncell + 1);
    const each = (fn) => {
      meshes.forEach((m, mi) => {
        const { pos, idx } = m;
        for (let t = 0; t < idx.length; t += 3) {
          const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
          const x0 = Math.min(pos[a], pos[b], pos[c]), x1 = Math.max(pos[a], pos[b], pos[c]);
          const y0 = Math.min(pos[a + 1], pos[b + 1], pos[c + 1]), y1 = Math.max(pos[a + 1], pos[b + 1], pos[c + 1]);
          const cx0 = Math.floor((x0 - minX) / cell), cx1 = Math.floor((x1 - minX) / cell);
          const cy0 = Math.floor((y0 - minY) / cell), cy1 = Math.floor((y1 - minY) / cell);
          for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) fn(cy * this.nx + cx, mi, t);
        }
      });
    };
    each((c) => counts[c + 1]++);
    for (let i = 0; i < ncell; i++) counts[i + 1] += counts[i];
    const fill = counts.slice();
    this.start = counts;
    this.items = new Uint32Array(counts[ncell]);
    each((c, mi, t) => { this.items[fill[c]++] = (t << 1) | mi; });
  }

  /**
   * Ray (origin o, direction d, tile ENU) -> {t, mesh, tri} of the highest
   * hit.  The ray is nearly vertical, so only the cells it crosses between
   * the tile's lowest and highest points are searched.
   */
  cast(o, d, zmin = -500, zmax = 5000) {
    const t0 = (zmin - o[2]) / d[2], t1 = (zmax - o[2]) / d[2];
    const xa = o[0] + d[0] * t0, xb = o[0] + d[0] * t1;
    const ya = o[1] + d[1] * t0, yb = o[1] + d[1] * t1;
    const c = this.cell;
    const cx0 = Math.max(0, Math.floor((Math.min(xa, xb) - this.minX) / c));
    const cx1 = Math.min(this.nx - 1, Math.floor((Math.max(xa, xb) - this.minX) / c));
    const cy0 = Math.max(0, Math.floor((Math.min(ya, yb) - this.minY) / c));
    const cy1 = Math.min(this.ny - 1, Math.floor((Math.max(ya, yb) - this.minY) / c));
    let best = null;
    for (let yy = cy0; yy <= cy1; yy++) {
      for (let xx = cx0; xx <= cx1; xx++) {
        const cc = yy * this.nx + xx;
        for (let k = this.start[cc]; k < this.start[cc + 1]; k++) {
          const item = this.items[k];
          const mi = item & 1;
          const t = item >>> 1;
          const hit = rayTriangle(o, d, this.meshes[mi], t);
          if (hit !== null && (!best || hit > best.t)) best = { t: hit, mesh: mi, tri: t };
        }
      }
    }
    return best;
  }
}

// Möller–Trumbore; returns the ray parameter (can be negative: point below).
function rayTriangle(o, d, m, t) {
  const p = m.pos, i = m.idx;
  const a = i[t] * 3, b = i[t + 1] * 3, c = i[t + 2] * 3;
  const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
  const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const sx = o[0] - p[a], sy = o[1] - p[a + 1], sz = o[2] - p[a + 2];
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < -1e-7 || u > 1 + 1e-7) return null;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < -1e-7 || u + v > 1 + 1e-7) return null;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

/** Everything a tile needs that is expensive to compute: runs in the worker. */
export function prepareTile(buf) {
  const data = decodeTile(buf);
  const meshes = [];
  const t = data.terrain;
  let normals = null;
  if (t.idx.length) {
    normals = computeNormals(t.pos, t.idx);
    meshes.push({ pos: t.pos, idx: t.idx });
  }
  if (data.surface) meshes.push({ pos: data.surface.pos, idx: data.surface.idx });
  let zmin = Infinity, zmax = -Infinity;
  for (const m of meshes) {
    for (let i = 2; i < m.pos.length; i += 3) {
      if (m.pos[i] < zmin) zmin = m.pos[i];
      if (m.pos[i] > zmax) zmax = m.pos[i];
    }
  }
  const grid = new CollisionGrid(meshes).toData();
  return { data, normals, grid, zmin, zmax };
}

/** Transferable buffers of a prepared tile (for postMessage). */
export function transferList(prep) {
  const out = new Set();
  const add = (a) => { if (a && a.buffer) out.add(a.buffer); };
  const d = prep.data;
  add(d.terrain.pos); add(d.terrain.idx);
  if (d.surface) { add(d.surface.pos); add(d.surface.nrm); add(d.surface.uv); add(d.surface.idx); }
  for (const l of d.lights) { add(l.pos); add(l.nrm); }
  add(prep.normals); add(prep.grid.start); add(prep.grid.items);
  return [...out];
}
