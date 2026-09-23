// FlightGear scenery tiles in the browser.
//
// Loads the tiles written by tools/build_scenery.py around the aircraft,
// turns them into three.js meshes with FlightGear's materials, and answers
// JSBSim's ground queries (elevation, normal, surface material) by casting a
// ray down the local vertical onto the actual tile triangles, like
// FlightGear's ground cache does.

import * as THREE from "three";
import { enuBasis, geodeticToEcef } from "./geo.js";
import { createMaterial } from "./materials.js";

const FT_PER_M = 1 / 0.3048;

async function fetchGz(url) {
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
function computeNormals(pos, idx) {
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
class CollisionGrid {
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

class Tile {
  constructor(info, data, manager) {
    this.info = info;
    this.data = data;
    this.center = data.center;
    this.basis = enuBasis(data.lat, data.lon);
    const frame = manager.frame;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.group.matrix.copy(frame.enuMatrixAtEcef(data.center, data.lat, data.lon));
    this.group.matrixWorldNeedsUpdate = true;
    this.group.name = `tile-${info.id}`;

    const meshes = [];
    const t = data.terrain;
    if (t.idx.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(t.pos, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(computeNormals(t.pos, t.idx), 3));
      geo.setIndex(new THREE.BufferAttribute(t.idx, 1));
      const mats = t.groups.map((g, i) => {
        geo.addGroup(g.start, g.count, i);
        return manager.material(g.material, false);
      });
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mats);
      mesh.name = "terrain";
      this.group.add(mesh);
      meshes.push({ pos: t.pos, idx: t.idx, groups: t.groups });
    }
    const s = data.surface;
    if (s) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(s.pos, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(s.nrm, 3, true));
      geo.setAttribute("uv", new THREE.BufferAttribute(s.uv, 2));
      geo.setIndex(new THREE.BufferAttribute(s.idx, 1));
      const mats = s.groups.map((g, i) => {
        geo.addGroup(g.start, g.count, i);
        return manager.material(g.material, true);
      });
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mats);
      mesh.name = "airport";
      mesh.renderOrder = 1;
      this.group.add(mesh);
      meshes.push({ pos: s.pos, idx: s.idx, groups: s.groups });
    }
    if (data.lights.length && manager.lightFactory) {
      const pts = manager.lightFactory(data.lights, manager);
      if (pts) this.group.add(pts);
    }
    this.meshes = meshes;
    this.grid = new CollisionGrid(meshes);
    let zmin = Infinity, zmax = -Infinity;
    for (const m of meshes) {
      for (let i = 2; i < m.pos.length; i += 3) {
        if (m.pos[i] < zmin) zmin = m.pos[i];
        if (m.pos[i] > zmax) zmax = m.pos[i];
      }
    }
    this.zmin = zmin;
    this.zmax = zmax;
  }

  materialOf(meshIndex, tri) {
    for (const g of this.meshes[meshIndex].groups) if (tri >= g.start && tri < g.start + g.count) return g.material;
    return -1;
  }

  contains(lat, lon) {
    const i = this.info;
    return lat >= i.lat0 && lat <= i.lat1 && lon >= i.lon0 && lon <= i.lon1;
  }

  /** Ground below (lat, lon) -> {elev (m), nE, nN, nU, material} or null. */
  query(latDeg, lonDeg) {
    const surf = geodeticToEcef(latDeg, lonDeg, 0);
    const up = enuBasis(latDeg, lonDeg).u;
    const { e, n, u } = this.basis;
    const d0 = surf[0] - this.center[0], d1 = surf[1] - this.center[1], d2 = surf[2] - this.center[2];
    const o = [e[0] * d0 + e[1] * d1 + e[2] * d2, n[0] * d0 + n[1] * d1 + n[2] * d2, u[0] * d0 + u[1] * d1 + u[2] * d2];
    const d = [e[0] * up[0] + e[1] * up[1] + e[2] * up[2], n[0] * up[0] + n[1] * up[1] + n[2] * up[2],
      u[0] * up[0] + u[1] * up[1] + u[2] * up[2]];
    const hit = this.grid.cast(o, d, this.zmin - 5, this.zmax + 5);
    if (!hit) return null;
    const m = this.meshes[hit.mesh];
    const p = m.pos, ix = m.idx, t = hit.tri;
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    // Tile ENU normal -> ECEF -> ENU at the query point.
    const ne = [e[0] * nx + n[0] * ny + u[0] * nz, e[1] * nx + n[1] * ny + u[1] * nz, e[2] * nx + n[2] * ny + u[2] * nz];
    const q = enuBasis(latDeg, lonDeg);
    return {
      elev: hit.t,
      nE: q.e[0] * ne[0] + q.e[1] * ne[1] + q.e[2] * ne[2],
      nN: q.n[0] * ne[0] + q.n[1] * ne[1] + q.n[2] * ne[2],
      nU: q.u[0] * ne[0] + q.u[1] * ne[1] + q.u[2] * ne[2],
      material: this.materialOf(hit.mesh, hit.tri),
    };
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
  }
}

export class SceneryManager {
  constructor({ baseUrl, frame, scene, renderer }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.frame = frame;
    this.scene = scene;
    this.renderer = renderer;
    this.root = new THREE.Group();
    this.root.name = "scenery";
    scene.add(this.root);
    this.tiles = new Map(); // id -> Tile
    this.loading = new Map(); // id -> Promise
    this.materials = new Map();
    this.textures = new Map();
    this.index = null;
    this.lastMaterial = null;
    this.lightFactory = null;
    this.onTileLoaded = null;
  }

  async init() {
    const res = await fetch(`${this.baseUrl}/index.json`);
    this.index = await res.json();
    this.materialDefs = this.index.materials;
  }

  texture(path) {
    if (!path) return null;
    let tex = this.textures.get(path);
    if (!tex) {
      tex = new THREE.TextureLoader().load(`${this.baseUrl}/${path}`);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, this.renderer?.capabilities.getMaxAnisotropy?.() ?? 1);
      this.textures.set(path, tex);
    }
    return tex;
  }

  material(index, hasUv) {
    const key = `${index}:${hasUv}`;
    let m = this.materials.get(key);
    if (!m) {
      const def = this.materialDefs[index];
      m = createMaterial(def, this.texture(def.texture), hasUv);
      this.materials.set(key, m);
    }
    return m;
  }

  /** Re-anchors every loaded tile to a new render frame. */
  setFrame(frame) {
    this.frame = frame;
    for (const t of this.tiles.values()) {
      t.group.matrix.copy(frame.enuMatrixAtEcef(t.data.center, t.data.lat, t.data.lon));
      t.group.matrixWorldNeedsUpdate = true;
    }
  }

  tileAt(lat, lon) {
    for (const t of this.tiles.values()) if (t.contains(lat, lon)) return t;
    return null;
  }

  infoAt(lat, lon) {
    return this.index.tiles.find((t) => lat >= t.lat0 && lat <= t.lat1 && lon >= t.lon0 && lon <= t.lon1) ?? null;
  }

  /** JSBSim ground callback: (radians) -> {elev, nE, nN, nU} or null. */
  groundQuery(latRad, lonRad) {
    const lat = (latRad * 180) / Math.PI;
    const lon = (lonRad * 180) / Math.PI;
    const tile = this.tileAt(lat, lon);
    if (!tile) return null;
    const r = tile.query(lat, lon);
    if (r) this.lastMaterial = r.material >= 0 ? this.materialDefs[r.material] : null;
    return r;
  }

  /** Elevation in metres, or null when no tile is loaded there. */
  elevation(lat, lon) {
    const t = this.tileAt(lat, lon);
    const r = t?.query(lat, lon);
    return r ? r.elev : null;
  }

  async loadTile(info) {
    if (this.tiles.has(info.id)) return this.tiles.get(info.id);
    if (this.loading.has(info.id)) return this.loading.get(info.id);
    const p = (async () => {
      const buf = await fetchGz(`${this.baseUrl}/${info.file}`);
      const tile = new Tile(info, decodeTile(buf), this);
      this.tiles.set(info.id, tile);
      this.root.add(tile.group);
      this.onTileLoaded?.(tile);
      return tile;
    })().finally(() => this.loading.delete(info.id));
    this.loading.set(info.id, p);
    return p;
  }

  distanceKm(info, lat, lon) {
    const clat = Math.min(Math.max(lat, info.lat0), info.lat1);
    const clon = Math.min(Math.max(lon, info.lon0), info.lon1);
    const dy = (lat - clat) * 111.2;
    const dx = (lon - clon) * 111.2 * Math.cos((lat * Math.PI) / 180);
    return Math.hypot(dx, dy);
  }

  /** Loads tiles within `radiusKm` of (lat, lon), unloads far ones. */
  update(lat, lon, radiusKm = 30) {
    if (!this.index) return [];
    const wanted = this.index.tiles
      .map((t) => ({ t, d: this.distanceKm(t, lat, lon) }))
      .filter((x) => x.d <= radiusKm)
      .sort((a, b) => a.d - b.d);
    const started = [];
    for (const { t } of wanted) {
      if (this.tiles.has(t.id) || this.loading.has(t.id)) continue;
      if (this.loading.size >= 3) break;
      started.push(this.loadTile(t).catch((err) => console.warn("tile", t.id, err)));
    }
    for (const [id, tile] of this.tiles) {
      if (this.distanceKm(tile.info, lat, lon) > radiusKm * 1.4) {
        this.root.remove(tile.group);
        tile.dispose();
        this.tiles.delete(id);
      }
    }
    return started;
  }

  /** Loads everything needed around a start position before flying. */
  async preload(lat, lon, radiusKm, onProgress) {
    const wanted = this.index.tiles.filter((t) => this.distanceKm(t, lat, lon) <= radiusKm)
      .sort((a, b) => this.distanceKm(a, lat, lon) - this.distanceKm(b, lat, lon));
    let done = 0;
    const queue = [...wanted];
    const worker = async () => {
      while (queue.length) {
        const t = queue.shift();
        await this.loadTile(t);
        onProgress?.(++done, wanted.length);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }
}

export { FT_PER_M };
