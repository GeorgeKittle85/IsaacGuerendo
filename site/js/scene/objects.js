// Scenery objects from the tiles' .stg files (tools/build_objects.py).
//
// OBJECT_STATIC landmarks (bridges, towers, terminals) are loaded as full
// FlightGear models with their animations.  OBJECT_SHARED models (hangars,
// masts, vehicles, ...) repeat many times, so each is built once as a static
// template and drawn with GPU instancing per tile.
//
// Placement follows SimGear's ReaderWriterSTG: a z-up frame at the object's
// position (x south, y east, z up), rotated by heading (counter-clockwise),
// then pitch, then roll.

import * as THREE from "three";
import { enuBasis, geodeticToEcef } from "./geo.js";
import { ModelLibrary, loadModel } from "../model/fgmodel.js";

const D2R = Math.PI / 180;
const SHARED_RANGE_KM = 9;

/** Object -> tile-frame matrix (the tile frame is ENU at the tile centre). */
export function placementMatrix(tile, o, out = new THREE.Matrix4()) {
  const b = tile.basis;
  const c = tile.center;
  const p = geodeticToEcef(o.lat, o.lon, o.elev);
  const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const local = [dot(b.e, d), dot(b.n, d), dot(b.u, d)];
  // The object's own east/north/up, expressed in the tile frame.
  const ob = enuBasis(o.lat, o.lon);
  const inTile = (v) => [dot(b.e, v), dot(b.n, v), dot(b.u, v)];
  const E = inTile(ob.e), N = inTile(ob.n), U = inTile(ob.u);
  // SimGear z-up frame: x = south, y = east, z = up.
  out.set(
    -N[0], E[0], U[0], local[0],
    -N[1], E[1], U[1], local[1],
    -N[2], E[2], U[2], local[2],
    0, 0, 0, 1,
  );
  const r = new THREE.Matrix4();
  out.multiply(r.makeRotationZ(o.hdg * D2R));
  out.multiply(r.makeRotationY((o.pitch ?? 0) * D2R));
  out.multiply(r.makeRotationX((o.roll ?? 0) * D2R));
  return out;
}

const objectRef = (tile, o) => (o.kind === "static" ? `static:${tile.info.objectsDir}/${o.path}` : `shared:${o.path}`);

export class SceneryObjects {
  /** ctx: {props, nasal} for animated landmarks. */
  constructor(baseUrl, renderer, ctx) {
    this.baseUrl = baseUrl;
    this.renderer = renderer;
    this.ctx = ctx;
    this.lib = null;
    this.templates = new Map(); // model key -> Promise<[{geometry, material, matrix}]>
    this.tiles = new Map(); // tile id -> {group, shared, models: [FGModel]}
    this.enabled = true;
  }

  async init() {
    try {
      this.lib = await ModelLibrary.load(this.baseUrl, this.renderer);
    } catch (err) {
      console.warn("scenery objects unavailable:", err.message);
      this.lib = null;
    }
  }

  /** A shared model's meshes with their transforms relative to the model origin. */
  template(key) {
    let t = this.templates.get(key);
    if (!t) {
      t = loadModel(this.lib, key, { ...this.ctx, base: "/", static: true }).then((m) => {
        const root = m.root;
        root.updateMatrixWorld(true);
        const parts = [];
        root.traverse((o) => {
          if (!o.isMesh) return;
          for (let n = o; n; n = n.parent) if (!n.visible) return;
          parts.push({ geometry: o.geometry, material: o.material, matrix: o.matrixWorld.clone() });
        });
        return parts;
      }).catch((err) => {
        console.warn("object model", key, err.message);
        return [];
      });
      this.templates.set(key, t);
    }
    return t;
  }

  /** Places a freshly loaded tile's objects (SceneryManager.onTileLoaded). */
  async addTile(tile) {
    if (!this.lib || !tile.info.objects?.length) return;
    const entry = { group: new THREE.Group(), shared: new THREE.Group(), models: [], dead: false };
    entry.group.name = "objects";
    entry.shared.name = "shared-objects";
    entry.group.add(entry.shared);
    this.tiles.set(tile.info.id, entry);
    tile.group.add(entry.group);
    const refs = this.lib.manifest.refs ?? {};
    const shared = new Map(); // key -> [matrix]
    const statics = [];
    for (const o of tile.info.objects) {
      if (o.kind === "sign") continue;
      const key = refs[objectRef(tile, o)];
      if (!key) continue;
      const m = placementMatrix(tile, o);
      if (o.kind === "static") statics.push({ key, m });
      else {
        if (!shared.has(key)) shared.set(key, []);
        shared.get(key).push(m);
      }
    }
    // Landmarks: full models, one at a time so a big tile does not stall.
    const landmarks = (async () => {
      for (const { key, m } of statics) {
        if (entry.dead) return;
        try {
          const model = await loadModel(this.lib, key, { ...this.ctx, base: "/" });
          if (entry.dead) return;
          const holder = new THREE.Group();
          holder.matrixAutoUpdate = false;
          holder.matrix.copy(m);
          holder.add(model.root);
          entry.group.add(holder);
          entry.models.push(model);
        } catch (err) {
          console.warn("landmark", key, err.message);
        }
      }
    })();
    // Shared models: one InstancedMesh per template part.
    const instanced = Promise.all([...shared].map(async ([key, mats]) => {
      const parts = await this.template(key);
      if (entry.dead) return;
      for (const part of parts) {
        const im = new THREE.InstancedMesh(part.geometry, part.material, mats.length);
        const tmp = new THREE.Matrix4();
        mats.forEach((m, i) => im.setMatrixAt(i, tmp.multiplyMatrices(m, part.matrix)));
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        entry.shared.add(im);
      }
    }));
    await Promise.all([landmarks, instanced]);
  }

  removeTile(tile) {
    const entry = this.tiles.get(tile.info.id);
    if (!entry) return;
    entry.dead = true;
    entry.group.removeFromParent();
    // Geometry and materials belong to the model library's caches.
    entry.shared.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    this.tiles.delete(tile.info.id);
  }

  /** Animations of the landmarks; shared objects only near the viewer. */
  update(dt, camera, scenery, lat, lon) {
    for (const [id, entry] of this.tiles) {
      const tile = scenery.tiles.get(id);
      if (tile) entry.shared.visible = scenery.distanceKm(tile.info, lat, lon) < SHARED_RANGE_KM;
      for (const m of entry.models) m.update(dt, camera);
    }
  }
}
