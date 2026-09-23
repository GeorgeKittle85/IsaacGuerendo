// AC3D (.ac) loader matching OpenSceneGraph's ac plugin as FlightGear uses it:
// object transforms (loc/rot) are baked into the vertices, every OBJECT
// becomes a named group (so FlightGear animations can find it by
// object-name), surfaces are smoothed by the object's crease angle, and the
// Y-up AC3D space is turned into FlightGear's model space (x aft, y right,
// z up): (x, y, z)_ac -> (x, -z, y).

import * as THREE from "three";

const SURF_TYPE_MASK = 0x0f;
const SURF_SMOOTH = 0x10;
const SURF_TWOSIDED = 0x20;

class Lines {
  constructor(text) {
    this.lines = text.split(/\r?\n/);
    this.i = 0;
  }

  next() {
    while (this.i < this.lines.length) {
      const l = this.lines[this.i++];
      if (l.trim() !== "") return l;
    }
    return null;
  }
}

function tokenize(line) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

function parseMaterial(tokens) {
  // MATERIAL "name" rgb r g b amb r g b emis r g b spec r g b shi n trans t
  const m = { name: tokens[1] };
  for (let i = 2; i < tokens.length; i++) {
    const k = tokens[i];
    if (k === "rgb" || k === "amb" || k === "emis" || k === "spec") {
      m[k] = [+tokens[i + 1], +tokens[i + 2], +tokens[i + 3]];
      i += 3;
    } else if (k === "shi" || k === "trans") {
      m[k] = +tokens[++i];
    }
  }
  return m;
}

/** An object's local transform: rot is a row-major 3x3 (AC3D spec), loc a translation. */
function objectMatrix(rot, loc) {
  const m = new THREE.Matrix4();
  if (rot) m.set(rot[0], rot[1], rot[2], 0, rot[3], rot[4], rot[5], 0, rot[6], rot[7], rot[8], 0, 0, 0, 0, 1);
  if (loc) m.setPosition(loc[0], loc[1], loc[2]);
  return m;
}

/** Parses AC3D text into a plain object tree (no three.js yet). */
export function parseAC(text) {
  const L = new Lines(text);
  const header = L.next();
  if (!header || !header.startsWith("AC3D")) throw new Error("not an AC3D file");
  const materials = [];
  let line;

  const readObject = (firstLine, parentMatrix) => {
    const tokens = tokenize(firstLine);
    const obj = { type: tokens[1], name: "", texture: null, texrep: [1, 1], texoff: [0, 0], crease: 61,
      verts: [], surfs: [], kids: [], data: null };
    let rot = null;
    let loc = null;
    let nkids = 0;
    for (;;) {
      line = L.next();
      if (line === null) break;
      const t = tokenize(line);
      const k = t[0];
      if (k === "name") obj.name = t[1] ?? "";
      else if (k === "data") {
        // Skip the data block (may span lines).
        let len = +t[1];
        let s = "";
        while (s.length < len) {
          const l = L.lines[L.i++];
          if (l === undefined) break;
          s += (s ? "\n" : "") + l;
        }
        obj.data = s;
      } else if (k === "texture") obj.texture = t[1];
      else if (k === "texrep") obj.texrep = [+t[1], +t[2]];
      else if (k === "texoff") obj.texoff = [+t[1], +t[2]];
      else if (k === "rot") rot = t.slice(1, 10).map(Number);
      else if (k === "loc") loc = t.slice(1, 4).map(Number);
      else if (k === "crease") obj.crease = +t[1];
      else if (k === "url" || k === "subdiv" || k === "hidden" || k === "locked" || k === "folded") { /* ignored */ }
      else if (k === "numvert") {
        const n = +t[1];
        // Object transform: v' = parent * (rot * v + loc), AC3D row-major rot.
        const full = new THREE.Matrix4().multiplyMatrices(parentMatrix, objectMatrix(rot, loc));
        const v = new THREE.Vector3();
        for (let i = 0; i < n; i++) {
          const p = L.next().trim().split(/\s+/).map(Number);
          v.set(p[0], p[1], p[2]).applyMatrix4(full);
          obj.verts.push(v.x, -v.z, v.y); // AC3D Y-up -> FlightGear z-up
        }
      } else if (k === "numsurf") {
        const n = +t[1];
        for (let s = 0; s < n; s++) {
          const surfLine = tokenize(L.next());
          const flags = parseInt(surfLine[1], 16);
          let mat = 0;
          let refs = [];
          for (;;) {
            const l = tokenize(L.next());
            if (l[0] === "mat") mat = +l[1];
            else if (l[0] === "refs") {
              const nr = +l[1];
              refs = new Array(nr);
              for (let r = 0; r < nr; r++) {
                const q = L.next().trim().split(/\s+/);
                refs[r] = [+q[0], +q[1] || 0, +q[2] || 0];
              }
              break;
            }
          }
          obj.surfs.push({ flags, mat, refs });
        }
      } else if (k === "kids") {
        nkids = +t[1];
        const childMatrix = new THREE.Matrix4().multiplyMatrices(parentMatrix, objectMatrix(rot, loc));
        for (let c = 0; c < nkids; c++) {
          const l = L.next();
          if (l === null) break;
          obj.kids.push(readObject(l, childMatrix));
        }
        break; // "kids" ends an object
      }
    }
    return obj;
  };

  let world = null;
  while ((line = L.next()) !== null) {
    if (line.startsWith("MATERIAL")) materials.push(parseMaterial(tokenize(line)));
    else if (line.startsWith("OBJECT")) {
      world = readObject(line, new THREE.Matrix4());
      break;
    }
  }
  return { materials, world };
}

/** Face normal of a polygon (Newell's method, robust for concave faces). */
function faceNormal(verts, refs) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < refs.length; i++) {
    const a = refs[i][0] * 3;
    const b = refs[(i + 1) % refs.length][0] * 3;
    nx += (verts[a + 1] - verts[b + 1]) * (verts[a + 2] + verts[b + 2]);
    ny += (verts[a + 2] - verts[b + 2]) * (verts[a] + verts[b]);
    nz += (verts[a] - verts[b]) * (verts[a + 1] + verts[b + 1]);
  }
  const l = Math.hypot(nx, ny, nz);
  return l > 1e-20 ? [nx / l, ny / l, nz / l] : [0, 0, 1];
}

/**
 * Turns a parsed AC3D tree into three.js objects.
 *  getMaterial(acMaterial, textureName|null, {twoSided, flat}) -> THREE.Material
 */
export function buildAC(parsed, getMaterial) {
  const lineObjects = new Map(); // name -> [x0,y0,z0,x1,y1,z1] (for axis definitions)

  const build = (obj) => {
    const group = new THREE.Group();
    group.name = obj.name;
    if (obj.verts.length && obj.surfs.length) {
      const polys = obj.surfs.filter((s) => (s.flags & SURF_TYPE_MASK) === 0 && s.refs.length >= 3);
      const lines = obj.surfs.filter((s) => (s.flags & SURF_TYPE_MASK) !== 0 && s.refs.length >= 2);
      if (polys.length) group.add(buildMesh(obj, polys, parsed.materials, getMaterial));
      if (lines.length) {
        const pos = [];
        for (const s of lines) {
          const closed = (s.flags & SURF_TYPE_MASK) === 1;
          for (let i = 0; i < s.refs.length - (closed ? 0 : 1); i++) {
            const a = s.refs[i][0] * 3;
            const b = s.refs[(i + 1) % s.refs.length][0] * 3;
            pos.push(obj.verts[a], obj.verts[a + 1], obj.verts[a + 2], obj.verts[b], obj.verts[b + 1], obj.verts[b + 2]);
          }
        }
        lineObjects.set(obj.name, pos.slice(0, 6));
        group.userData.linePoints = pos.slice(0, 6);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        const m = parsed.materials[lines[0].mat] ?? { rgb: [1, 1, 1] };
        const seg = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: new THREE.Color(...m.rgb) }));
        seg.userData.acLines = true;
        // FlightGear models use named line objects as rotation axes; never draw those.
        if (/axis/i.test(obj.name)) seg.visible = false;
        group.add(seg);
      }
    }
    for (const kid of obj.kids) group.add(build(kid));
    return group;
  };

  const root = build(parsed.world);
  return { root, lineObjects };
}

function buildMesh(obj, polys, materials, getMaterial) {
  const verts = obj.verts;
  const cosCrease = Math.cos(((obj.crease ?? 61) * Math.PI) / 180);
  const [ru, rv] = obj.texrep;
  const [ou, ov] = obj.texoff;
  // Face normals and per-vertex incident faces for crease smoothing.
  const fn = polys.map((s) => faceNormal(verts, s.refs));
  const incident = new Map();
  polys.forEach((s, fi) => {
    if (!(s.flags & SURF_SMOOTH)) return;
    for (const r of s.refs) {
      let l = incident.get(r[0]);
      if (!l) incident.set(r[0], (l = []));
      l.push(fi);
    }
  });

  // Bucket triangles by (material, two-sided, flat) so each gets one material.
  const buckets = new Map();
  polys.forEach((s, fi) => {
    const twoSided = !!(s.flags & SURF_TWOSIDED);
    const smooth = !!(s.flags & SURF_SMOOTH);
    const key = `${s.mat}|${twoSided}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { mat: s.mat, twoSided, pos: [], nrm: [], uv: [] }));
    const corner = (r) => {
      const vi = r[0] * 3;
      b.pos.push(verts[vi], verts[vi + 1], verts[vi + 2]);
      let n = fn[fi];
      if (smooth) {
        let x = 0, y = 0, z = 0;
        for (const f of incident.get(r[0]) ?? []) {
          const m = fn[f];
          if (m[0] * n[0] + m[1] * n[1] + m[2] * n[2] >= cosCrease) { x += m[0]; y += m[1]; z += m[2]; }
        }
        const l = Math.hypot(x, y, z);
        if (l > 1e-12) n = [x / l, y / l, z / l];
      }
      b.nrm.push(n[0], n[1], n[2]);
      b.uv.push(r[1] * ru + ou, r[2] * rv + ov);
    };
    // Fan triangulation (AC3D polygons are convex in practice).
    for (let i = 1; i < s.refs.length - 1; i++) {
      corner(s.refs[0]);
      corner(s.refs[i]);
      corner(s.refs[i + 1]);
    }
  });

  const geo = new THREE.BufferGeometry();
  let total = 0;
  for (const b of buckets.values()) total += b.pos.length / 3;
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const mats = [];
  let start = 0;
  for (const b of buckets.values()) {
    pos.set(b.pos, start * 3);
    nrm.set(b.nrm, start * 3);
    uv.set(b.uv, start * 2);
    const count = b.pos.length / 3;
    geo.addGroup(start, count, mats.length);
    start += count;
    mats.push(getMaterial(materials[b.mat] ?? { rgb: [0.8, 0.8, 0.8] }, obj.texture, { twoSided: b.twoSided }));
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, mats.length === 1 ? mats[0] : mats);
  // Only the object's group carries the name (as in OSG): naming the mesh too
  // would let object-name match twice and apply animations twice.
  mesh.userData.acName = obj.name;
  mesh.userData.acMesh = true;
  return mesh;
}
