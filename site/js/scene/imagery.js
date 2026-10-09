// Aerial imagery on the scenery tiles (tools/build_imagery.py: USGS NAIP
// orthophotos, ~10 m a pixel, ~5 m for the busiest tiles).
//
// Each tile's image is loaded at the resolution its distance calls for, to
// keep the GPU memory down: far tiles get it at half size, near ones whole,
// and the nearest the sharper image where there is one.  The images are
// decoded off the main thread (createImageBitmap) and swapped into the
// tile's materials (materials.js, satMap) when they are ready.

import * as THREE from "three";

// Levels: 0 half size, 1 the base image, 2 the sharper image.  Distances in
// km to the tile's edge; leaving a level needs `HYSTERESIS` km more.  At
// most HI_TILES tiles, the nearest, have the sharper image (64 MB each on
// the GPU).
const NEAR_KM = 10;
const HI_KM = 3.5;
const HI_TILES = 2;
const HYSTERESIS = 2;

export class Imagery {
  constructor(baseUrl, index, renderer, { mobile = false } = {}) {
    this.baseUrl = baseUrl;
    this.tiles = index.tiles ?? {};
    this.renderer = renderer;
    this.mobile = mobile;
    this.loading = 0;
    this.queue = [];
    this.hiBudget = 0;
    this.blobs = new Map(); // url -> Promise<Blob>, the files in use
    const clear = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    clear.needsUpdate = true;
    this.placeholder = clear;
  }

  /** The image's [lat0, lon0, lat1, lon1] for a tile id, or null. */
  bounds(id) {
    return this.tiles[id]?.bounds ?? null;
  }

  /** The level a tile at `km` should have. */
  wanted(tile, km) {
    const e = this.tiles[tile.info.id];
    if (!e) return -1;
    const cur = tile.satLevel ?? -1;
    if (this.mobile) return 0;
    if (e.hi && km < HI_KM + (cur === 2 ? HYSTERESIS : 0) && this.hiBudget > 0) {
      this.hiBudget--;
      return 2;
    }
    if (km < NEAR_KM + (cur >= 1 ? HYSTERESIS : 0)) return 1;
    return 0;
  }

  /** Starts a round of update() calls, nearest tile first. */
  beginPass() {
    this.hiBudget = HI_TILES;
  }

  /** Brings a loaded tile's image to the level its distance calls for (SceneryManager.update). */
  update(tile, km) {
    if (!tile.sat) return;
    const want = this.wanted(tile, km);
    if (want < 0 || want === tile.satLevel || want === tile.satPending) return;
    tile.satPending = want;
    this.enqueue(() => this.load(tile.info.id, want).then((tex) => {
      if (tile.disposed || tile.satPending !== want) {
        tex?.dispose();
        return;
      }
      tile.satPending = undefined;
      if (!tex) return;
      const old = tile.sat.value;
      tile.sat.value = tex;
      tile.satLevel = want;
      if (old !== this.placeholder) old.dispose();
    }).catch((err) => {
      if (tile.satPending === want) tile.satPending = undefined;
      console.warn("imagery", tile.info.id, err.message);
    }), want === 2 ? 1 : want === 1 ? 2 : 3);
  }

  /** Resolves when no image is loading or waiting (or after timeoutMs). */
  idle(timeoutMs = 10000) {
    const t0 = performance.now();
    return new Promise((resolve) => {
      const check = () => {
        if ((!this.loading && !this.queue.length) || performance.now() - t0 > timeoutMs) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }

  /** Two images at a time, the sharper levels first. */
  enqueue(job, priority) {
    this.queue.push({ job, priority });
    this.queue.sort((a, b) => a.priority - b.priority);
    this.pump();
  }

  pump() {
    while (this.loading < 2 && this.queue.length) {
      const { job } = this.queue.shift();
      this.loading++;
      job().finally(() => {
        this.loading--;
        this.pump();
      });
    }
  }

  blob(url) {
    let p = this.blobs.get(url);
    if (!p) {
      p = fetch(url).then((r) => {
        if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
        return r.blob();
      });
      p.catch(() => this.blobs.delete(url));
      this.blobs.set(url, p);
      // Keep a few dozen files around for going back and forth.
      if (this.blobs.size > 48) this.blobs.delete(this.blobs.keys().next().value);
    }
    return p;
  }

  async load(id, level) {
    const e = this.tiles[id];
    if (!e) return null;
    const url = level === 2 && e.hi ? `${this.baseUrl}/imagery/hi/${id}.webp` : `${this.baseUrl}/imagery/${id}.webp`;
    const blob = await this.blob(url);
    const opts = { imageOrientation: "none", premultiplyAlpha: "none", colorSpaceConversion: "none" };
    let bmp = null;
    if (level === 0) {
      const [w, h] = e.size;
      try {
        bmp = await createImageBitmap(blob, { ...opts, resizeWidth: Math.round(w / 2), resizeHeight: Math.round(h / 2),
          resizeQuality: "high" });
      } catch {
        bmp = null; // no resizing here: the whole image
      }
    }
    bmp ??= await createImageBitmap(blob, opts);
    const tex = new THREE.Texture(bmp);
    tex.flipY = false; // v = 0 is the image's top row (osmdata.js, satUvs)
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = Math.min(8, this.renderer?.capabilities.getMaxAnisotropy?.() ?? 1);
    tex.needsUpdate = true;
    // The bitmap goes once the GPU has it.
    tex.onUpdate = () => bmp.close?.();
    return tex;
  }
}
