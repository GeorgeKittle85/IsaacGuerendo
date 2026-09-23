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
import { fetchGz, prepareTile, CollisionGrid } from "./tiledata.js";

export { decodeTile } from "./tiledata.js";

const FT_PER_M = 1 / 0.3048;

class Tile {
  /** prep: prepareTile() output {data, normals, grid, zmin, zmax}, usually from the worker. */
  constructor(info, prep, manager) {
    const data = prep.data;
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
      geo.setAttribute("normal", new THREE.BufferAttribute(prep.normals, 3));
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
    this.grid = CollisionGrid.from(meshes, prep.grid);
    this.zmin = prep.zmin;
    this.zmax = prep.zmax;
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

  /** Decoding, normals and the collision grid happen in a worker when possible. */
  prepare(url) {
    if (this.worker === undefined) {
      try {
        this.worker = new Worker(new URL("./tile-worker.js", import.meta.url), { type: "module" });
        this.workerJobs = new Map();
        this.workerSeq = 0;
        this.worker.onmessage = (e) => {
          const job = this.workerJobs.get(e.data.id);
          this.workerJobs.delete(e.data.id);
          if (e.data.error) job?.reject(new Error(e.data.error));
          else job?.resolve(e.data.prep);
        };
        this.worker.onerror = (e) => {
          console.warn("tile worker failed, decoding on the main thread:", e.message);
          for (const job of this.workerJobs.values()) job.reject(new Error("tile worker failed"));
          this.workerJobs.clear();
          this.worker = null;
        };
      } catch (err) {
        this.worker = null;
      }
    }
    if (!this.worker) return fetchGz(url).then(prepareTile);
    const id = ++this.workerSeq;
    return new Promise((resolve, reject) => {
      this.workerJobs.set(id, { resolve, reject });
      this.worker.postMessage({ id, url: new URL(url, document.baseURI).href });
    }).catch(() => fetchGz(url).then(prepareTile));
  }

  async loadTile(info) {
    if (this.tiles.has(info.id)) return this.tiles.get(info.id);
    if (this.loading.has(info.id)) return this.loading.get(info.id);
    const p = (async () => {
      const prep = await this.prepare(`${this.baseUrl}/${info.file}`);
      const tile = new Tile(info, prep, this);
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
