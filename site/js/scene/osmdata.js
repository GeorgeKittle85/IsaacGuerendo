// OpenStreetMap buildings, roads and railways on the scenery tiles: decoding
// tools/build_osm.py's files, setting them on the terrain and building their
// meshes.  Pure functions on typed arrays with no three.js, so they run in
// the tile worker (tile-worker.js) as well as on the main thread.
//
// A tile's OSM data is placed once, when the tile loads: every footprint gets
// its ground elevation and every road is draped over the terrain triangles.
// The landmarks (tall or big buildings, the main roads and railways) become
// one mesh right away; the rest is cut into 4 x 4 chunks whose meshes are
// built only when the aircraft comes near (osm.js).
//
// Building meshes share their vertices between walls and roof: the shader
// takes the normal from screen-space derivatives.  Each vertex carries the
// wall colour (alpha: the kind of windows), the roof colour (alpha: a random
// seed) and its place on the facade (metres along the walls / 4, metres
// above the ground * 10).
//
// Road meshes are ribbons: position, (metres along the road, 0..1 across),
// and (class, width * 4, flags, lanes).

import earcut from "../../vendor/earcut.js";

const Q = 65536;
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const D2R = Math.PI / 180;

/** Chunks per tile side for the small buildings and streets. */
export const CHUNKS = 4;

// tools/build_osm.py's BUILDING_KINDS and road classes.
export const KINDS = ["yes", "house", "residential", "apartments", "commercial", "retail", "office", "industrial",
  "warehouse", "garage", "shed", "religious", "school", "hospital", "hangar", "civic", "roof", "parking", "farm",
  "greenhouse", "tower"];
const K = Object.fromEntries(KINDS.map((k, i) => [k, i]));
export const ROAD = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, motorwayLink: 5, trunkLink: 6,
  minorLink: 7, unclassified: 8, residential: 9, service: 10, rail: 11 };
const MINOR_ROADS = new Set([ROAD.residential, ROAD.service]);
const ROAD_BRIDGE = 1, ROAD_ONEWAY = 2;

// sRGB palettes, picked per building by its seed.
const hex = (s) => s.split(" ").map((h) => parseInt(h, 16));
const WALLS = {
  house: hex("e8e2d4 d9cbb0 cdc6ba efe9dc bba88e d6d0c4 ab9c88 c6b69c e2d7c0 9fa7a9"),
  apartments: hex("d8d0c0 c8bfae b9aa92 e0dbd0 a8988a c4a48a"),
  commercial: hex("cfcac0 bdb8ae d8d2c4 a9a49a c8bca8 b0a898"),
  office: hex("9aa6b0 8c98a4 b8bcc0 7d8a96 c4c6c4 a2a8a8"),
  industrial: hex("c8c8c4 b4b6b4 d2d0c8 9ea4a8 bcb4a4"),
  small: hex("b8b0a0 a09888 c8c0b0 9a8c7c"),
  civic: hex("d8d0c0 c8b8a0 e4dccc bfb2a0 cfc8bc"),
  farm: hex("9c4a3a 8a6a50 b8b0a0 a0583e c8c0b0"),
};
const ROOFS = {
  pitched: hex("5a5652 6b5e55 4a4846 7a5a48 625a50 806a5a 585e62 8a5040"),
  flat: hex("b8b8b4 a8a8a4 c8c8c2 9a9a96 d4d4d0 8e8e8a"),
};
// Kind -> [wall palette, window style]: 0 none, 1 homes, 2 shops and offices, 3 industrial, 4 glass.
const KIND_LOOK = [];
for (const [k, i] of Object.entries(K)) {
  const look = {
    house: ["house", 1], residential: ["house", 1], apartments: ["apartments", 1], commercial: ["commercial", 2],
    retail: ["commercial", 2], office: ["office", 4], industrial: ["industrial", 3], warehouse: ["industrial", 3],
    garage: ["small", 0], shed: ["small", 0], religious: ["civic", 1], school: ["civic", 2], hospital: ["civic", 2],
    hangar: ["industrial", 0], civic: ["civic", 2], roof: ["small", 0], parking: ["industrial", 3],
    farm: ["farm", 0], greenhouse: ["small", 0], tower: ["industrial", 0],
  }[k] ?? ["commercial", 2];
  KIND_LOOK[i] = look;
}

function hash32(a, b) {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return h >>> 0;
}

// ------------------------------------------------------------------ decoding

/** Parses an OSM1 tile (see tools/build_osm.py). */
export function decodeOsm(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (magic !== "OSM1") throw new Error("bad OSM tile magic " + magic);
  const lat0 = dv.getFloat64(8, true), lon0 = dv.getFloat64(16, true);
  const lat1 = dv.getFloat64(24, true), lon1 = dv.getFloat64(32, true);
  const nb = dv.getUint32(40, true), nr = dv.getUint32(44, true), len = dv.getUint32(48, true);
  const bytes = new Uint8Array(buf, 52, len);
  let p = 0;
  const uv = () => {
    let b = bytes[p++];
    if (b < 128) return b;
    let v = b & 0x7f, s = 128;
    do {
      b = bytes[p++];
      v += (b & 0x7f) * s;
      s *= 128;
    } while (b & 0x80);
    return v;
  };
  const zz = () => {
    const v = uv();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  };
  const ringCount = new Uint16Array(nb);
  let rings = 0;
  for (let i = 0; i < nb; i++) rings += ringCount[i] = uv();
  const ringLen = new Uint32Array(rings);
  let verts = 0;
  for (let i = 0; i < rings; i++) verts += ringLen[i] = uv();
  const height = new Float32Array(nb), minH = new Float32Array(nb), roofH = new Float32Array(nb);
  for (let i = 0; i < nb; i++) height[i] = uv() / 10;
  for (let i = 0; i < nb; i++) minH[i] = uv() / 10;
  for (let i = 0; i < nb; i++) roofH[i] = uv() / 10;
  const style = new Uint16Array(nb);
  for (let i = 0; i < nb; i++) style[i] = uv();
  const wall = new Int32Array(nb).fill(-1), roof = new Int32Array(nb).fill(-1);
  for (let i = 0; i < nb; i++) {
    if (style[i] & 256) wall[i] = uv();
    if (style[i] & 512) roof[i] = uv();
  }
  const bq = new Int32Array(verts * 2);
  let x = 0, y = 0;
  for (let i = 0; i < verts; i++) {
    x += zz();
    y += zz();
    bq[i * 2] = x;
    bq[i * 2 + 1] = y;
  }
  const cls = new Uint8Array(nr), width = new Float32Array(nr), flags = new Uint16Array(nr), count = new Uint32Array(nr);
  for (let i = 0; i < nr; i++) cls[i] = uv();
  for (let i = 0; i < nr; i++) width[i] = uv() / 10;
  for (let i = 0; i < nr; i++) flags[i] = uv();
  let rverts = 0;
  for (let i = 0; i < nr; i++) rverts += count[i] = uv();
  const rq = new Int32Array(rverts * 2);
  for (let i = 0; i < rverts; i++) {
    x += zz();
    y += zz();
    rq[i * 2] = x;
    rq[i * 2 + 1] = y;
  }
  return {
    lat0, lon0, lat1, lon1,
    buildings: { count: nb, ringCount, ringLen, height, minH, roofH, style, wall, roof, q: bq },
    roads: { count: nr, cls, width, flags, len: count, q: rq },
  };
}

// ------------------------------------------------------------------ placing

/**
 * Quantised tile coordinates -> the terrain tile's east/north (metres): the
 * exact mapping on a 64 x 64 grid over the tile (and a margin around it),
 * bilinear in between, which is good to well under a centimetre.
 */
function projector(osm, data) {
  const la = data.lat * D2R, lo = data.lon * D2R;
  const sla = Math.sin(la), cla = Math.cos(la), slo = Math.sin(lo), clo = Math.cos(lo);
  const e = [-slo, clo, 0], n = [-sla * clo, -sla * slo, cla];
  const c = data.center;
  const dLat = (osm.lat1 - osm.lat0) / Q, dLon = (osm.lon1 - osm.lon0) / Q;
  const exact = (qx, qy, out, k) => {
    const lat = (osm.lat0 + qy * dLat) * D2R, lon = (osm.lon0 + qx * dLon) * D2R;
    const s = Math.sin(lat), cl = Math.cos(lat);
    const nn = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
    const X = nn * cl * Math.cos(lon) - c[0], Y = nn * cl * Math.sin(lon) - c[1], Z = nn * (1 - WGS84_E2) * s - c[2];
    out[k] = e[0] * X + e[1] * Y;
    out[k + 1] = n[0] * X + n[1] * Y + n[2] * Z;
  };
  // Grid nodes every Q/64 steps, from -Q/8 to Q * 9/8 (buildings reach out of their tile).
  const N = 64, step = Q / N, off = Q / 8, M = N + N / 4 + 1;
  const grid = new Float64Array(M * M * 2);
  for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) exact(i * step - off, j * step - off, grid, (j * M + i) * 2);
  return (qx, qy, out, k) => {
    const fx = (qx + off) / step, fy = (qy + off) / step;
    const i = Math.floor(fx), j = Math.floor(fy);
    if (i < 0 || j < 0 || i >= M - 1 || j >= M - 1) {
      exact(qx, qy, out, k);
      return;
    }
    const tx = fx - i, ty = fy - j;
    const a = (j * M + i) * 2, b = a + 2, cc = a + M * 2, d = cc + 2;
    out[k] = (grid[a] * (1 - tx) + grid[b] * tx) * (1 - ty) + (grid[cc] * (1 - tx) + grid[d] * tx) * ty;
    out[k + 1] = (grid[a + 1] * (1 - tx) + grid[b + 1] * tx) * (1 - ty) + (grid[cc + 1] * (1 - tx) + grid[d + 1] * tx) * ty;
  };
}

/**
 * The highest terrain or airport surface below (x, y) in the tile frame,
 * straight down the tile's up axis, or NaN.  grid: CollisionGrid data with
 * its meshes ({pos, idx}).
 */
export function heightField(grid) {
  const { minX, minY, cell, nx, ny, start, items, meshes } = grid;
  // Barycentric height on triangle `it` (a grid item), or NaN when (x, y) is outside it.
  const on = (it, x, y) => {
    const m = meshes[it & 1];
    const t = it >>> 1;
    const p = m.pos, ix = m.idx;
    const a = ix[t] * 3, b = ix[t + 1] * 3, d3 = ix[t + 2] * 3;
    const x0 = p[a], y0 = p[a + 1], x1 = p[b], y1 = p[b + 1], x2 = p[d3], y2 = p[d3 + 1];
    const det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (det === 0) return NaN;
    const l0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / det;
    if (l0 < -1e-7 || l0 > 1 + 1e-7) return NaN;
    const l1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / det;
    if (l1 < -1e-7 || l0 + l1 > 1 + 1e-7) return NaN;
    return l0 * p[a + 2] + l1 * p[b + 2] + (1 - l0 - l1) * p[d3 + 2];
  };
  // Queries come along roads and around buildings: the last triangle hit
  // usually holds the next point too.  Terrain triangles do not overlap
  // (airports sit in holes in the land cover), so it is the answer.
  let last = -1;
  return (x, y) => {
    if (last >= 0) {
      const z = on(last, x, y);
      if (z === z) return z;
    }
    const cx = Math.floor((x - minX) / cell), cy = Math.floor((y - minY) / cell);
    if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) return NaN;
    const c = cy * nx + cx;
    let best = -Infinity;
    for (let k = start[c], end = start[c + 1]; k < end; k++) {
      const z = on(items[k], x, y);
      if (z > best) {
        best = z;
        last = items[k];
      }
    }
    return best === -Infinity ? NaN : best;
  };
}

const AROUND = [];
for (const r of [30, 80, 200, 500, 1200, 3000]) {
  for (let k = 0; k < 8; k++) AROUND.push([r * Math.cos((k * Math.PI) / 4), r * Math.sin((k * Math.PI) / 4)]);
}

/** heightField with a fallback: the nearest ground found around (x, y) (holes left for a neighbour's airport). */
function groundFn(hf) {
  let last = 0;
  return (x, y) => {
    let z = hf(x, y);
    if (z === z) return (last = z);
    for (const [dx, dy] of AROUND) {
      z = hf(x + dx, y + dy);
      if (z === z) return (last = z);
    }
    return last;
  };
}

/** Is this building a landmark, drawn as far as the tile (else only near)? */
function isMajor(h, area) {
  return h >= 20 || area >= 4000;
}

/**
 * Places a decoded tile's buildings and roads on the terrain.  Returns the
 * data the meshes are built from (see buildMeshes): a few typed arrays,
 * small enough to keep while the tile is loaded.
 */
export function placeOsm(osm, data, grid) {
  const proj = projector(osm, data);
  const ground = groundFn(heightField(grid));
  const B = osm.buildings;
  const xy = new Float32Array(B.q.length);
  for (let i = 0; i < B.q.length; i += 2) proj(B.q[i], B.q[i + 1], xy, i);
  const ringStart = new Uint32Array(B.count + 1); // first ring of each building
  const vertStart = new Uint32Array(B.ringLen.length + 1); // first vertex of each ring
  for (let i = 0; i < B.count; i++) ringStart[i + 1] = ringStart[i] + B.ringCount[i];
  for (let r = 0; r < B.ringLen.length; r++) vertStart[r + 1] = vertStart[r] + B.ringLen[r];
  const base = new Float32Array(B.count);
  const chunk = new Uint8Array(B.count);
  const major = new Uint8Array(B.count);
  const cq = Q / CHUNKS;
  for (let i = 0; i < B.count; i++) {
    const r = ringStart[i];
    const v0 = vertStart[r], v1 = vertStart[r + 1];
    let zmin = Infinity, area = 0, qx = 0, qy = 0;
    // The ground under the lowest corner: the building stands on the slope
    // without hanging over it.
    const step = Math.max(1, Math.ceil((v1 - v0) / 4));
    for (let v = v0; v < v1; v += step) zmin = Math.min(zmin, ground(xy[v * 2], xy[v * 2 + 1]));
    for (let v = v0; v < v1; v++) {
      const w = v + 1 < v1 ? v + 1 : v0;
      area += xy[v * 2] * xy[w * 2 + 1] - xy[w * 2] * xy[v * 2 + 1];
      qx += B.q[v * 2];
      qy += B.q[v * 2 + 1];
    }
    base[i] = zmin;
    major[i] = isMajor(B.height[i], Math.abs(area) / 2) ? 1 : 0;
    const n = v1 - v0;
    const ccx = Math.min(CHUNKS - 1, Math.max(0, Math.floor(qx / n / cq)));
    const ccy = Math.min(CHUNKS - 1, Math.max(0, Math.floor(qy / n / cq)));
    chunk[i] = ccy * CHUNKS + ccx;
  }

  // Roads: drape each polyline, keep the samples (x, y, z left, z right).
  const R = osm.roads;
  const rxy = new Float32Array(R.q.length);
  for (let i = 0; i < R.q.length; i += 2) proj(R.q[i], R.q[i + 1], rxy, i);
  const hf = heightField(grid);
  const samples = [];
  const roadStart = new Uint32Array(R.count + 1);
  const rchunk = new Uint8Array(R.count);
  let v = 0;
  for (let i = 0; i < R.count; i++) {
    const n = R.len[i];
    const pts = rxy.subarray(v * 2, (v + n) * 2);
    const first = samples.length / 5;
    drape(pts, R.width[i], (R.flags[i] & ROAD_BRIDGE) !== 0, hf, ground, samples);
    roadStart[i] = first;
    const m = Math.floor(n / 2) + v;
    const ccx = Math.min(CHUNKS - 1, Math.max(0, Math.floor(R.q[m * 2] / cq)));
    const ccy = Math.min(CHUNKS - 1, Math.max(0, Math.floor(R.q[m * 2 + 1] / cq)));
    rchunk[i] = ccy * CHUNKS + ccx;
    v += n;
  }
  roadStart[R.count] = samples.length / 5;
  return {
    b: { count: B.count, ringStart, vertStart, xy, base, chunk, major, height: B.height, minH: B.minH, roofH: B.roofH,
      style: B.style, wall: B.wall, roof: B.roof },
    r: { count: R.count, cls: R.cls, width: R.width, flags: R.flags, start: roadStart, chunk: rchunk,
      s: new Float32Array(samples) },
  };
}

/**
 * Drapes a polyline: cuts it where the ground bends under it, then sets each
 * sample's two edges on the ground.  Appends (x, y, zLeft, zRight, along)
 * per sample.  Bridges run straight from bank to bank instead.
 */
function drape(pts, width, bridge, hf, ground, out) {
  const n = pts.length / 2;
  const cx = [], cy = [], cz = [];
  const add = (x, y, z) => { cx.push(x); cy.push(y); cz.push(z); };
  const MAX = 40, TOL = 0.12;
  const sub = (x0, y0, z0, x1, y1, z1, depth) => {
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const zm = ground(mx, my);
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (depth < 9 && len > 3 && Math.abs(zm - (z0 + z1) / 2) > TOL) {
      sub(x0, y0, z0, mx, my, zm, depth + 1);
      sub(mx, my, zm, x1, y1, z1, depth + 1);
    } else {
      add(x1, y1, z1);
    }
  };
  if (bridge) {
    for (let i = 0; i < n; i++) add(pts[i * 2], pts[i * 2 + 1], 0);
  } else {
    let x0 = pts[0], y0 = pts[1], z0 = ground(x0, y0);
    add(x0, y0, z0);
    for (let i = 1; i < n; i++) {
      const x1 = pts[i * 2], y1 = pts[i * 2 + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      const steps = Math.max(1, Math.ceil(len / MAX));
      for (let s = 1; s <= steps; s++) {
        const xs = x0 + ((x1 - x0) * s) / steps, ys = y0 + ((y1 - y0) * s) / steps;
        const zs = ground(xs, ys);
        sub(cx[cx.length - 1], cy[cy.length - 1], cz[cz.length - 1], xs, ys, zs, 0);
      }
      x0 = x1;
      y0 = y1;
    }
  }
  const m = cx.length;
  if (m < 2) return;
  let along = 0;
  // A bridge deck: straight between the ground at its ends, a little up.
  let zb0 = 0, zb1 = 0, total = 0;
  if (bridge) {
    zb0 = ground(cx[0], cy[0]);
    zb1 = ground(cx[m - 1], cy[m - 1]);
    for (let i = 1; i < m; i++) total += Math.hypot(cx[i] - cx[i - 1], cy[i] - cy[i - 1]);
  }
  const half = width / 2;
  for (let i = 0; i < m; i++) {
    if (i > 0) along += Math.hypot(cx[i] - cx[i - 1], cy[i] - cy[i - 1]);
    // Direction: the mean of the segments on either side (a mitred joint).
    const ia = Math.max(0, i - 1), ib = Math.min(m - 1, i + 1);
    let tx = cx[ib] - cx[ia], ty = cy[ib] - cy[ia];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    let miter = 1;
    if (i > 0 && i < m - 1) {
      const ax = cx[i] - cx[i - 1], ay = cy[i] - cy[i - 1], al = Math.hypot(ax, ay) || 1;
      const cos = (ax * tx + ay * ty) / al;
      miter = 1 / Math.max(0.5, cos);
    }
    const nx = -ty * half * miter, ny = tx * half * miter;
    let zl, zr;
    if (bridge) {
      const f = total > 0 ? along / total : 0;
      zl = zr = zb0 + (zb1 - zb0) * f + 1.2 + Math.sin(f * Math.PI) * Math.min(4, total * 0.02);
    } else {
      const lz = hf(cx[i] + nx, cy[i] + ny), rz = hf(cx[i] - nx, cy[i] - ny);
      zl = lz === lz ? lz : cz[i];
      zr = rz === rz ? rz : cz[i];
      // A crowned road: keep the centre line above the ground too.
      const lift = cz[i] - (zl + zr) / 2;
      if (lift > 0) {
        zl += lift;
        zr += lift;
      }
    }
    out.push(cx[i], cy[i], zl, zr, along);
  }
}

// ------------------------------------------------------------------ meshes

/** Growable typed-array batches with 16-bit indices. */
class Batches {
  constructor(attrs) {
    this.attrs = attrs; // name -> [ArrayType, itemSize]
    this.done = [];
    this.open(4096);
  }

  open(cap) {
    this.n = 0;
    this.cap = cap;
    this.a = {};
    for (const [k, [T, s]] of Object.entries(this.attrs)) this.a[k] = new T(cap * s);
    this.idx = new Uint16Array(cap * 3);
    this.ni = 0;
  }

  /** Room for `verts` more vertices and `indices` more indices; returns the first new vertex. */
  reserve(verts, indices) {
    if (this.n + verts > 65535) this.flush();
    if (this.n + verts > this.cap) this.grow(Math.max(this.cap * 2, this.n + verts), null);
    if (this.ni + indices > this.idx.length) this.grow(null, Math.max(this.idx.length * 2, this.ni + indices));
    return this.n;
  }

  grow(cap, icap) {
    if (cap) {
      for (const [k, [T, s]] of Object.entries(this.attrs)) {
        const b = new T(Math.min(cap, 65536) * s);
        b.set(this.a[k].subarray(0, this.n * s));
        this.a[k] = b;
      }
      this.cap = Math.min(cap, 65536);
    }
    if (icap) {
      const b = new Uint16Array(icap);
      b.set(this.idx.subarray(0, this.ni));
      this.idx = b;
    }
  }

  flush() {
    if (!this.ni) {
      this.open(this.cap);
      return;
    }
    const out = { count: this.n, index: this.idx.slice(0, this.ni) };
    for (const [k, [_T, s]] of Object.entries(this.attrs)) out[k] = this.a[k].slice(0, this.n * s);
    this.done.push(out);
    this.open(Math.min(65536, Math.max(4096, this.n)));
  }

  result() {
    this.flush();
    return this.done;
  }
}

const BUILDING_ATTRS = { position: [Float32Array, 3], wallColor: [Uint8Array, 4], roofColor: [Uint8Array, 4],
  facade: [Uint16Array, 2] };
const ROAD_ATTRS = { position: [Float32Array, 3], roadUv: [Float32Array, 2], roadInfo: [Uint8Array, 4] };

/**
 * Meshes for part of a placed tile: which = "major" (the landmarks, all
 * chunks) or a chunk number (the rest in that chunk).  Returns {buildings,
 * roads}: arrays of batches {count, index, <attributes>}.
 */
export function buildMeshes(placed, which) {
  const b = new Batches(BUILDING_ATTRS);
  const P = placed.b;
  const wantMajor = which === "major";
  for (let i = 0; i < P.count; i++) {
    if (wantMajor ? !P.major[i] : P.major[i] || P.chunk[i] !== which) continue;
    addBuilding(b, P, i);
  }
  const r = new Batches(ROAD_ATTRS);
  const RR = placed.r;
  for (let i = 0; i < RR.count; i++) {
    const minor = MINOR_ROADS.has(RR.cls[i]);
    if (wantMajor ? minor : !minor || RR.chunk[i] !== which) continue;
    addRoad(r, RR, i);
  }
  return { buildings: b.result(), roads: r.result() };
}

/** The transferable buffers of buildMeshes' result. */
export function meshTransfers(m) {
  const out = [];
  for (const list of [m.buildings, m.roads]) {
    for (const batch of list) for (const v of Object.values(batch)) if (v?.buffer) out.push(v.buffer);
  }
  return out;
}

const tmpRing = [];

function addBuilding(B, P, i) {
  const r0 = P.ringStart[i], r1 = P.ringStart[i + 1];
  const xy = P.xy;
  const base = P.base[i];
  const minH = P.minH[i];
  const kind = P.style[i] & 31;
  let shape = (P.style[i] >> 5) & 7;
  const zb = minH > 0 ? base + minH : base - 0.5;
  let roofH = P.roofH[i];
  const zt = base + P.height[i] - (shape ? roofH : 0);
  const v0 = P.vertStart[r0];
  const seed = hash32(Math.round(xy[v0 * 2] * 4), Math.round(xy[v0 * 2 + 1] * 4));
  const [pal, windows] = KIND_LOOK[kind] ?? KIND_LOOK[0];
  // Glass only on towers; low offices look like other shops.
  const win = windows === 4 && P.height[i] < 30 ? 2 : windows;
  let wall = P.wall[i];
  if (wall < 0) {
    const list = WALLS[P.height[i] >= 40 && pal !== "office" ? "office" : pal];
    wall = list[seed % list.length];
  }
  const n0 = P.vertStart[r0 + 1] - v0;
  if (shape && (r1 - r0 > 1 || (shape !== 3 && shape !== 4 && n0 !== 4))) shape = 0;
  if (!shape) roofH = 0;
  let roof = P.roof[i];
  if (roof < 0) {
    // Homes have shingles, flat or not; big flat roofs are pale membranes.
    const list = shape || pal === "house" || pal === "farm" ? ROOFS.pitched : ROOFS.flat;
    roof = list[(seed >>> 8) % list.length];
  }
  const wr = (wall >> 16) & 255, wg = (wall >> 8) & 255, wb = wall & 255;
  const rr = (roof >> 16) & 255, rg = (roof >> 8) & 255, rb = roof & 255;

  // Vertex count: two per ring vertex (+1 seam), plus the roof's ridge or apex.
  let verts = 0, ringsLen = 0;
  for (let r = r0; r < r1; r++) {
    const n = P.vertStart[r + 1] - P.vertStart[r];
    verts += 2 * (n + 1);
    ringsLen += n;
  }
  const extra = shape === 1 || shape === 2 ? 2 : shape ? 1 : 0;
  if (verts > 60000) return;
  const first = B.reserve(verts + extra, ringsLen * 6 + (ringsLen + 2 * (r1 - r0) + 4) * 3 + 12);
  const A = B.a;
  let k = first;
  const put = (x, y, z, along) => {
    B.n = k + 1;
    A.position[k * 3] = x;
    A.position[k * 3 + 1] = y;
    A.position[k * 3 + 2] = z;
    A.wallColor[k * 4] = wr; A.wallColor[k * 4 + 1] = wg; A.wallColor[k * 4 + 2] = wb; A.wallColor[k * 4 + 3] = win;
    A.roofColor[k * 4] = rr; A.roofColor[k * 4 + 1] = rg; A.roofColor[k * 4 + 2] = rb; A.roofColor[k * 4 + 3] = seed & 255;
    A.facade[k * 2] = Math.round(along * 4) & 0xffff;
    A.facade[k * 2 + 1] = Math.max(0, Math.min(65535, Math.round((z - base) * 10)));
    return k++;
  };
  const idx = B.idx;
  const tri = (a, b, c) => {
    idx[B.ni++] = a;
    idx[B.ni++] = b;
    idx[B.ni++] = c;
  };
  const tops = []; // per ring: the index of its first top vertex
  for (let r = r0; r < r1; r++) {
    const s = P.vertStart[r], n = P.vertStart[r + 1] - s;
    const start = k;
    let along = 0;
    for (let j = 0; j <= n; j++) {
      const v = s + (j % n);
      if (j > 0) {
        const u = s + j - 1;
        along += Math.hypot(xy[v * 2] - xy[u * 2], xy[v * 2 + 1] - xy[u * 2 + 1]);
      }
      put(xy[v * 2], xy[v * 2 + 1], zb, along);
      put(xy[v * 2], xy[v * 2 + 1], zt, along);
    }
    for (let j = 0; j < n; j++) {
      const bA = start + j * 2, tA = bA + 1, bB = bA + 2, tB = bA + 3;
      tri(bA, bB, tB);
      tri(bA, tB, tA);
    }
    tops.push(start + 1);
  }
  const top = (r, j) => tops[r] + j * 2; // ring r's vertex j at the wall top

  if (!shape) {
    // Flat roof: earcut over the rings (holes included).
    tmpRing.length = 0;
    const holes = [];
    for (let r = r0; r < r1; r++) {
      if (r > r0) holes.push(tmpRing.length / 2);
      for (let v = P.vertStart[r]; v < P.vertStart[r + 1]; v++) tmpRing.push(xy[v * 2], xy[v * 2 + 1]);
    }
    const t = earcut(tmpRing, holes.length ? holes : undefined);
    // Flat vertex index -> its ring and position in the ring.
    const ringOf = [];
    for (let r = r0; r < r1; r++) {
      const n = P.vertStart[r + 1] - P.vertStart[r];
      for (let j = 0; j < n; j++) ringOf.push(top(r - r0, j));
    }
    for (let j = 0; j < t.length; j += 3) {
      const a = t[j] * 2, b = t[j + 1] * 2, c = t[j + 2] * 2;
      const cross = (tmpRing[b] - tmpRing[a]) * (tmpRing[c + 1] - tmpRing[a + 1]) -
        (tmpRing[b + 1] - tmpRing[a + 1]) * (tmpRing[c] - tmpRing[a]);
      if (cross >= 0) tri(ringOf[t[j]], ringOf[t[j + 1]], ringOf[t[j + 2]]);
      else tri(ringOf[t[j]], ringOf[t[j + 2]], ringOf[t[j + 1]]);
    }
    return;
  }

  const s = P.vertStart[r0];
  const px = (j) => xy[(s + (j % n0)) * 2], py = (j) => xy[(s + (j % n0)) * 2 + 1];
  let mx = 0, my = 0;
  for (let j = 0; j < n0; j++) {
    mx += px(j);
    my += py(j);
  }
  mx /= n0;
  my /= n0;
  const zr = zt + roofH;
  const midZ = zt;
  // Every roof triangle faces away from the middle of the roof's base.
  const face = (a, b, c) => {
    const p = A.position;
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const e1x = p[b * 3] - ax, e1y = p[b * 3 + 1] - ay, e1z = p[b * 3 + 2] - az;
    const e2x = p[c * 3] - ax, e2y = p[c * 3 + 1] - ay, e2z = p[c * 3 + 2] - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const gx = (ax + p[b * 3] + p[c * 3]) / 3 - mx, gy = (ay + p[b * 3 + 1] + p[c * 3 + 1]) / 3 - my;
    const gz = (az + p[b * 3 + 2] + p[c * 3 + 2]) / 3 - midZ;
    if (nx * gx + ny * gy + nz * gz >= 0) tri(a, b, c);
    else tri(a, c, b);
  };
  if (shape === 3 || shape === 4) {
    const apex = put(mx, my, zr, 0);
    for (let j = 0; j < n0; j++) face(top(0, j), top(0, j + 1), apex);
    return;
  }
  // Four corners: the ridge runs along the longer sides.
  const len = (j) => Math.hypot(px(j + 1) - px(j), py(j + 1) - py(j));
  const o = len(0) + len(2) >= len(1) + len(3) ? 0 : 1; // edges o and o+2 are the long ones
  const c0 = o, c1 = o + 1, c2 = o + 2, c3 = o + 3;
  // Ridge ends: the middles of the short edges (c1-c2 and c3-c0).
  let ax = (px(c1) + px(c2)) / 2, ay = (py(c1) + py(c2)) / 2;
  let bx = (px(c3) + px(c0)) / 2, by = (py(c3) + py(c0)) / 2;
  if (shape === 2) {
    // Hipped: pull the ridge ends in by half the building's depth.
    const rl = Math.hypot(bx - ax, by - ay) || 1;
    const inset = Math.min((len(c1) + len(c3)) / 4, rl / 2 - 0.2);
    const dx = (bx - ax) / rl, dy = (by - ay) / rl;
    ax += dx * inset; ay += dy * inset;
    bx -= dx * inset; by -= dy * inset;
  }
  const ridgeA = put(ax, ay, zr, 0), ridgeB = put(bx, by, zr, 0);
  const t0 = top(0, c0), t1 = top(0, c1), t2 = top(0, c2), t3 = top(0, c3);
  face(t0, t1, ridgeA); face(t0, ridgeA, ridgeB); // slope along c0-c1
  face(t2, t3, ridgeB); face(t2, ridgeB, ridgeA); // slope along c2-c3
  face(t1, t2, ridgeA); // gable or hip at the c1-c2 end
  face(t3, t0, ridgeB); // and at the c3-c0 end
}

function addRoad(B, R, i) {
  const s0 = R.start[i], s1 = R.start[i + 1];
  const m = s1 - s0;
  if (m < 2) return;
  const S = R.s;
  const bridge = (R.flags[i] & ROAD_BRIDGE) !== 0;
  const w = R.width[i];
  const info = [R.cls[i], Math.min(255, Math.round(w * 4)), R.flags[i] & 15, (R.flags[i] >> 4) & 15];
  const verts = m * 2 * (bridge ? 3 : 1);
  const first = B.reserve(verts, (m - 1) * 6 * (bridge ? 3 : 1));
  const A = B.a;
  let k = first;
  const half = w / 2;
  for (let j = 0; j < m; j++) {
    const o = (s0 + j) * 5;
    const x = S[o], y = S[o + 1], zl = S[o + 2], zr = S[o + 3], along = S[o + 4];
    // The edges, rebuilt from the neighbouring samples' direction.
    const pa = (s0 + Math.max(0, j - 1)) * 5, pb = (s0 + Math.min(m - 1, j + 1)) * 5;
    let tx = S[pb] - S[pa], ty = S[pb + 1] - S[pa + 1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    let miter = 1;
    if (j > 0 && j < m - 1) {
      const ax = x - S[pa], ay = y - S[pa + 1], al = Math.hypot(ax, ay) || 1;
      miter = 1 / Math.max(0.5, (ax * tx + ay * ty) / al);
    }
    const nx = -ty * half * miter, ny = tx * half * miter;
    const lift = 0.15;
    const put = (px, py, pz, v) => {
      B.n = k + 1;
      A.position[k * 3] = px;
      A.position[k * 3 + 1] = py;
      A.position[k * 3 + 2] = pz;
      A.roadUv[k * 2] = along;
      A.roadUv[k * 2 + 1] = v;
      A.roadInfo.set(info, k * 4);
      k++;
    };
    put(x + nx, y + ny, zl + lift, 0);
    put(x - nx, y - ny, zr + lift, 1);
    if (bridge) {
      // The deck's sides, down to its underside.
      put(x + nx, y + ny, zl + lift, 2);
      put(x + nx, y + ny, zl - 1.4, 2);
      put(x - nx, y - ny, zr + lift, 2);
      put(x - nx, y - ny, zr - 1.4, 2);
    }
  }
  const idx = B.idx;
  const per = bridge ? 6 : 2;
  for (let j = 0; j < m - 1; j++) {
    const a = first + j * per, b = a + per;
    // Ribbon (left a, right a+1): counter-clockwise seen from above.
    idx[B.ni++] = a; idx[B.ni++] = a + 1; idx[B.ni++] = b + 1;
    idx[B.ni++] = a; idx[B.ni++] = b + 1; idx[B.ni++] = b;
    if (bridge) {
      // Left side (faces left), right side (faces right): drawn double sided.
      idx[B.ni++] = a + 2; idx[B.ni++] = b + 2; idx[B.ni++] = b + 3;
      idx[B.ni++] = a + 2; idx[B.ni++] = b + 3; idx[B.ni++] = a + 3;
      idx[B.ni++] = a + 4; idx[B.ni++] = a + 5; idx[B.ni++] = b + 5;
      idx[B.ni++] = a + 4; idx[B.ni++] = b + 5; idx[B.ni++] = b + 4;
    }
  }
}

/** Satellite texture coordinates for a terrain tile's vertices: (u, v) with v = 0 at the image's top. */
export function satUvs(data, pos, bounds) {
  const [lat0, lon0, lat1, lon1] = bounds;
  const la = data.lat * D2R, lo = data.lon * D2R;
  const sla = Math.sin(la), cla = Math.cos(la), slo = Math.sin(lo), clo = Math.cos(lo);
  const c = data.center;
  const uv = new Float32Array((pos.length / 3) * 2);
  const b = WGS84_A * (1 - WGS84_F);
  const ep2 = WGS84_E2 / (1 - WGS84_E2);
  for (let i = 0, j = 0; i < pos.length; i += 3, j += 2) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    // Tile east/north/up -> ECEF -> geodetic (Bowring).
    const X = c[0] - slo * x - sla * clo * y + cla * clo * z;
    const Y = c[1] + clo * x - sla * slo * y + cla * slo * z;
    const Z = c[2] + cla * y + sla * z;
    const p = Math.hypot(X, Y);
    const th = Math.atan2(Z * WGS84_A, p * b);
    const st = Math.sin(th), ct = Math.cos(th);
    const lat = Math.atan2(Z + ep2 * b * st * st * st, p - WGS84_E2 * WGS84_A * ct * ct * ct) / D2R;
    const lon = Math.atan2(Y, X) / D2R;
    uv[j] = (lon - lon0) / (lon1 - lon0);
    uv[j + 1] = (lat1 - lat) / (lat1 - lat0);
  }
  return uv;
}
