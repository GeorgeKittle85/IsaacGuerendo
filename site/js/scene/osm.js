// OpenStreetMap buildings, roads and railways (tools/build_osm.py), drawn on
// the scenery tiles.
//
// When a tile loads, the tile worker sets its OSM data on the terrain and
// builds the landmarks' mesh: tall and big buildings, the main roads and the
// railways (osmdata.js).  Small buildings and streets are kept in 4 x 4
// chunks per tile; their meshes are built when the aircraft comes within
// `nearKm` and dropped again when it leaves.
//
// The building shader takes its normals from screen-space derivatives (the
// walls and roof share vertices), picks the wall or roof colour by the
// slope, and draws windows along the facades: glass by day, lit at random
// by night.  The road shader paints lanes, edge lines and the centre line,
// and railway sleepers; it moves the ribbon a little toward the camera
// along the view ray, which keeps it above the terrain it is draped on
// without moving it on the screen (the logarithmic depth buffer ignores
// polygon offset).

import * as THREE from "three";
import { COMMON_FRAGMENT, COMMON_VERTEX, sceneryBaseUniforms } from "./materials.js";
import { CHUNKS } from "./osmdata.js";

const BUILDING_VERTEX = /* glsl */ `
  ${COMMON_VERTEX}
  attribute vec4 wallColor;
  attribute vec4 roofColor;
  attribute vec2 facade;
  varying vec3 vWall;
  varying vec4 vRoof;
  varying vec2 vFacade;
  varying float vStyle;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormalW = vec3(0.0, 1.0, 0.0);
    vec4 mv = viewMatrix * wp;
    vDist = length(mv.xyz);
    // The colours are sRGB.
    vWall = pow(wallColor.rgb, vec3(2.2));
    vRoof = vec4(pow(roofColor.rgb, vec3(2.2)), roofColor.a);
    vStyle = floor(wallColor.a * 255.0 + 0.5);
    vFacade = vec2(facade.x * 0.25, facade.y * 0.1);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;

const BUILDING_FRAGMENT = /* glsl */ `
  ${COMMON_FRAGMENT}
  varying vec3 vWall;
  varying vec4 vRoof;
  varying vec2 vFacade;
  varying float vStyle;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec3 n = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
    vec3 toCam = cameraPosition - vWorldPos;
    if (dot(n, toCam) < 0.0) n = -n;
    bool roof = dot(n, upDir) > 0.3;
    vec3 albedo = roof ? vRoof.rgb : vWall;
    vec3 emit = vec3(0.0);
    float glassSpec = 0.0;
    // Windows: 1 homes, 2 shops and offices, 3 industrial, 4 glass towers.
    if (!roof && vStyle > 0.5) {
      float bay = vStyle < 1.5 ? 4.2 : vStyle > 3.5 ? 2.0 : 3.2;
      float storey = vStyle < 1.5 ? 3.0 : vStyle > 2.5 && vStyle < 3.5 ? 4.5 : 3.6;
      vec2 size = vStyle < 1.5 ? vec2(0.38, 0.45) : vStyle > 3.5 ? vec2(0.86, 0.72)
        : vStyle > 2.5 ? vec2(0.6, 0.22) : vec2(0.55, 0.5);
      vec2 g = vec2(vFacade.x / bay, vFacade.y / storey);
      vec2 f = fract(g) - vec2(0.5, 0.55);
      vec2 w = max(fwidth(g), vec2(1e-4));
      vec2 d = abs(f) - size * 0.5;
      float win = (1.0 - smoothstep(-w.x, w.x, d.x)) * (1.0 - smoothstep(-w.y, w.y, d.y));
      // Smaller than a few pixels: the windows' average.
      float far = smoothstep(0.25, 0.6, max(w.x, w.y));
      win = mix(win, size.x * size.y, far) * step(1.0, vFacade.y);
      vec3 glass = vStyle > 3.5 ? vec3(0.035, 0.07, 0.11) : vec3(0.02, 0.025, 0.03);
      albedo = mix(albedo, glass, win * (vStyle > 3.5 ? 0.9 : 0.75));
      glassSpec = win * (vStyle > 3.5 ? 0.6 : 0.15);
      float lit = step(0.55, hash12(floor(g) + vRoof.a * 97.0));
      // Far away the lights are points, not a glow over the whole wall.
      lit = mix(lit, 0.12, far);
      emit = vec3(1.0, 0.75, 0.42) * win * lit * night * (vStyle > 2.5 && vStyle < 3.5 ? 0.4 : 1.0);
    }
    float ndl = max(dot(n, sunDir), 0.0);
    vec3 col = albedo * (ambientColor + sunColor * ndl) + emit * 1.4;
    if (glassSpec > 0.0) {
      vec3 h = normalize(normalize(toCam) + sunDir);
      col += sunColor * glassSpec * pow(max(dot(n, h), 0.0), 60.0);
    }
    gl_FragColor = vec4(applyFog(col), 1.0);
    #include <colorspace_fragment>
  }
`;

const ROAD_VERTEX = /* glsl */ `
  ${COMMON_VERTEX}
  attribute vec2 roadUv;
  attribute vec4 roadInfo;
  uniform float depthBias;
  varying vec2 vRoad;
  varying vec4 vInfo;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormalW = vec3(0.0, 1.0, 0.0);
    vec4 mv = viewMatrix * wp;
    vDist = length(mv.xyz);
    vRoad = roadUv;
    vInfo = roadInfo;
    // Toward the camera along the view ray: the same pixels, a nearer
    // depth.  Bigger roads a little more, so they cover the side streets.
    mv.xyz *= 1.0 - depthBias * (1.0 + (12.0 - roadInfo.x) * 0.04);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;

const ROAD_FRAGMENT = /* glsl */ `
  ${COMMON_FRAGMENT}
  varying vec2 vRoad;
  varying vec4 vInfo;
  float aaw;
  float line(float x, float c, float hw) {
    return 1.0 - smoothstep(hw - aaw, hw + aaw, abs(x - c));
  }
  void main() {
    #include <logdepthbuf_fragment>
    float cls = floor(vInfo.x + 0.5);
    float width = vInfo.y / 4.0;
    float flags = floor(vInfo.z + 0.5);
    float lanes = floor(vInfo.w + 0.5);
    bool oneway = mod(floor(flags / 2.0), 2.0) > 0.5;
    float x = (vRoad.y - 0.5) * width;  // metres from the centre line
    float along = vRoad.x;
    float px = max(fwidth(vRoad.y) * width, fwidth(along)); // metres a pixel
    aaw = max(px * 0.7, 0.02);
    float detail = 1.0 - smoothstep(0.2, 0.6, px);
    vec3 col;
    vec3 emit = vec3(0.0);
    if (vRoad.y > 1.5) {
      col = vec3(0.2);  // a bridge deck's side: concrete
    } else if (cls > 10.5) {
      // Railway: ballast, sleepers, two rails.
      col = vec3(0.13, 0.115, 0.1);
      float sleeper = step(abs(x), 1.3) * step(fract(along / 0.65), 0.38);
      col = mix(col, vec3(0.06, 0.045, 0.035), sleeper * detail);
      float rails = max(line(x, -0.72, 0.04), line(x, 0.72, 0.04));
      col = mix(col, vec3(0.25, 0.25, 0.27), rails * detail);
    } else {
      col = cls < 1.5 ? vec3(0.19, 0.19, 0.185) : cls < 8.5 ? vec3(0.145, 0.145, 0.15) : vec3(0.165, 0.165, 0.17);
      float mark = 0.0, yellow = 0.0;
      if (cls < 7.5) {
        float e = width * 0.5 - 0.45;
        mark = max(line(x, -e, 0.08), line(x, e, 0.08));
        float n = lanes > 0.5 ? lanes : max(1.0, floor(width / (oneway ? 3.4 : 3.6)));
        float dash = step(fract(along / 12.0), 0.3);
        if (oneway) {
          for (int k = 1; k < 8; k++) {
            if (float(k) >= n) break;
            mark = max(mark, line(x, -e + 2.0 * e * float(k) / n, 0.07) * dash);
          }
        } else if (cls < 4.5) {
          yellow = max(line(x, -0.16, 0.06), line(x, 0.16, 0.06));
          float side = floor(n / 2.0);
          for (int k = 1; k < 4; k++) {
            if (float(k) >= side) break;
            float c = e * float(k) / side;
            mark = max(mark, max(line(x, -c, 0.07), line(x, c, 0.07)) * dash);
          }
        }
      }
      col = mix(col, vec3(0.75, 0.75, 0.72), mark * detail);
      col = mix(col, vec3(0.75, 0.55, 0.08), yellow * detail);
      // Street lights in town and on the ramps.
      if (cls > 4.5 && cls < 7.5 || cls > 8.5) emit = vec3(1.0, 0.6, 0.25) * 0.05;
    }
    float sunUp = max(dot(upDir, sunDir), 0.0);
    col = col * (ambientColor + sunColor * sunUp) + emit * night;
    gl_FragColor = vec4(applyFog(col), 1.0);
    #include <colorspace_fragment>
  }
`;

function createMaterials() {
  const buildings = new THREE.ShaderMaterial({
    name: "osm-buildings", uniforms: sceneryBaseUniforms(),
    vertexShader: BUILDING_VERTEX, fragmentShader: BUILDING_FRAGMENT, side: THREE.FrontSide,
  });
  const roads = new THREE.ShaderMaterial({
    name: "osm-roads", uniforms: { ...sceneryBaseUniforms(), depthBias: { value: 0.0012 } },
    vertexShader: ROAD_VERTEX, fragmentShader: ROAD_FRAGMENT, side: THREE.DoubleSide,
  });
  return { buildings, roads };
}

/** Batches from osmdata.js's buildMeshes -> three.js meshes. */
function toMeshes(batches, material, attrs, name) {
  return batches.map((b) => {
    const geo = new THREE.BufferGeometry();
    for (const [key, [size, normalized]] of Object.entries(attrs)) {
      geo.setAttribute(key, new THREE.BufferAttribute(b[key], size, normalized));
    }
    geo.setIndex(new THREE.BufferAttribute(b.index, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    return mesh;
  });
}

const BUILDING_ATTRS = { position: [3, false], wallColor: [4, true], roofColor: [4, true], facade: [2, false] };
const ROAD_ATTRS = { position: [3, false], roadUv: [2, false], roadInfo: [4, false] };

export class OsmLayer {
  /** scenery: the SceneryManager (its worker builds the chunks). */
  constructor(scenery, { mobile = false } = {}) {
    this.scenery = scenery;
    this.materials = createMaterials();
    this.nearKm = mobile ? 2.5 : 4.5;
    this.showBuildings = true;
    this.showRoads = true;
    this.tiles = new Map(); // tile id -> {tile, group, chunks: Map(chunk -> {group|null, pending})}
    this.pending = 0;
  }

  /** Buildings and roads on or off (the meshes stay). */
  setVisible({ buildings = this.showBuildings, roads = this.showRoads } = {}) {
    this.showBuildings = buildings;
    this.showRoads = roads;
    for (const e of this.tiles.values()) this.applyVisibility(e.group);
  }

  applyVisibility(group) {
    group.traverse((o) => {
      if (o.isMesh) o.visible = o.name === "osm-buildings" ? this.showBuildings : this.showRoads;
    });
  }

  meshes(group, m) {
    for (const mesh of toMeshes(m.buildings, this.materials.buildings, BUILDING_ATTRS, "osm-buildings")) group.add(mesh);
    for (const mesh of toMeshes(m.roads, this.materials.roads, ROAD_ATTRS, "osm-roads")) group.add(mesh);
    this.applyVisibility(group);
  }

  /** A loaded tile (SceneryManager.onTileLoaded): its landmarks' meshes. */
  addTile(tile) {
    const m = tile.osm;
    if (!m) return;
    tile.osm = null;
    const group = new THREE.Group();
    group.name = "osm";
    group.matrixAutoUpdate = false;
    this.meshes(group, m);
    tile.group.add(group);
    this.tiles.set(tile.info.id, { tile, group, chunks: new Map() });
  }

  removeTile(tile) {
    const e = this.tiles.get(tile.info.id);
    if (!e) return;
    this.tiles.delete(tile.info.id);
    e.dead = true;
    e.group.removeFromParent();
    dispose(e.group);
    this.scenery.dropPlaced(tile.info.id);
  }

  /** Builds the chunks near (lat, lon), drops the far ones; once a second is plenty. */
  update(lat, lon) {
    const want = [];
    for (const e of this.tiles.values()) {
      const i = e.tile.info;
      const dLat = (i.lat1 - i.lat0) / CHUNKS, dLon = (i.lon1 - i.lon0) / CHUNKS;
      for (let c = 0; c < CHUNKS * CHUNKS; c++) {
        const cx = c % CHUNKS, cy = Math.floor(c / CHUNKS);
        const box = { lat0: i.lat0 + cy * dLat, lat1: i.lat0 + (cy + 1) * dLat, lon0: i.lon0 + cx * dLon, lon1: i.lon0 + (cx + 1) * dLon };
        const d = this.scenery.distanceKm(box, lat, lon);
        const have = e.chunks.get(c);
        if (d < this.nearKm && !have) want.push({ e, c, d });
        else if (have?.group && d > this.nearKm * 1.4) {
          have.group.removeFromParent();
          dispose(have.group);
          e.chunks.delete(c);
        }
      }
    }
    want.sort((a, b) => a.d - b.d);
    for (const { e, c } of want) {
      if (this.pending >= 2) break;
      const slot = { group: null, done: false };
      e.chunks.set(c, slot);
      this.pending++;
      this.scenery.requestChunk(e.tile.info.id, c).then((m) => {
        if (e.dead || e.chunks.get(c) !== slot) return;
        if (!m) return;
        const group = new THREE.Group();
        group.name = `osm-chunk-${c}`;
        group.matrixAutoUpdate = false;
        this.meshes(group, m);
        e.group.add(group);
        slot.group = group;
      }).catch((err) => {
        console.warn("osm chunk", e.tile.info.id, c, err.message);
      }).finally(() => {
        slot.done = true;
        this.pending--;
      });
    }
  }

  /** Waits until the chunks around (lat, lon) are built (before a flight starts). */
  async settle(lat, lon, timeoutMs = 15000) {
    const t0 = performance.now();
    for (;;) {
      this.update(lat, lon);
      let missing = 0;
      for (const e of this.tiles.values()) for (const s of e.chunks.values()) if (!s.done) missing++;
      if (!missing && !this.pending) return;
      if (performance.now() - t0 > timeoutMs) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

function dispose(group) {
  group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
}
