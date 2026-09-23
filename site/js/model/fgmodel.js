// FlightGear model XML loader and animation engine
// (simgear/scene/model/modellib.cxx, SGReaderWriterXML.cxx, animation.cxx).
//
// A model XML names an .ac mesh, submodels (<model>) with offsets and
// conditions, and <animation>s that transform, show/hide, recolour or make
// clickable the objects they name.  Animations are installed exactly the way
// SimGear does it: each one splices a new group above the named objects, so
// later animations nest inside earlier ones.

import * as THREE from "three";
import { parseAC, buildAC } from "./ac3d.js";
import { ConfigNode } from "../props/config.js";
import { absPath, readCondition, readExpression, readInterpTable, readBindings } from "../props/sgexpr.js";
import { sprintf } from "../nasal/nasal.js";
import { effectChain, effectParameters, proceduralLightMaterial } from "./effects.js";

const D2R = Math.PI / 180;

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  if (url.endsWith(".gz")) {
    return new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text();
  }
  return res.text();
}

const dirOf = (p) => p.slice(0, p.lastIndexOf("/"));

function normalizePath(p) {
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "..") out.pop();
    else if (seg && seg !== ".") out.push(seg);
  }
  return out.join("/");
}

export class ModelLibrary {
  /** baseUrl: directory holding model.json (tools/build_model.py output). */
  constructor(baseUrl, manifest, renderer) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.manifest = manifest;
    this.renderer = renderer;
    this.textures = new Map();
    this.materials = new Map();
    this.acText = new Map();
  }

  static async load(baseUrl, renderer) {
    const res = await fetch(`${baseUrl}/model.json`);
    return new ModelLibrary(baseUrl, await res.json(), renderer);
  }

  texture(relPath) {
    if (!relPath) return null;
    const key = normalizePath(relPath);
    if (this.textures.has(key)) return this.textures.get(key);
    let info = this.manifest.textures[key];
    if (info === undefined) {
      // FlightGear falls back to other extensions (e.g. .rgb vs .png).
      const stem = key.replace(/\.[^./]+$/, "");
      const alt = Object.keys(this.manifest.textures).find((k) => k.replace(/\.[^./]+$/, "") === stem);
      info = alt ? this.manifest.textures[alt] : null;
    }
    let tex = null;
    if (info) {
      // Clones made for texture animations before the image arrived are
      // flagged for upload once it does (they share the image source).
      tex = new THREE.TextureLoader().load(`${this.baseUrl}/${info.file}`, (t) => {
        for (const c of t.pendingClones) c.needsUpdate = true;
        t.pendingClones.length = 0;
      });
      // Not in userData: Texture.clone() deep-copies userData through JSON.
      Object.defineProperty(tex, "pendingClones", { value: [] });
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = Math.min(8, this.renderer?.capabilities.getMaxAnisotropy?.() ?? 1);
      tex.userData.alpha = info.alpha;
    }
    this.textures.set(key, tex);
    return tex;
  }

  /** Material for an AC3D material + texture, like OSG's ac plugin. */
  material(ac, texPath, { twoSided }) {
    const key = `${ac.name}|${JSON.stringify(ac.rgb)}|${ac.trans}|${texPath}|${twoSided}`;
    let m = this.materials.get(key);
    if (m) return m;
    const tex = this.texture(texPath);
    const trans = ac.trans ?? 0;
    const alphaTex = !!tex?.userData.alpha;
    const rgb = ac.rgb ?? [0.8, 0.8, 0.8];
    const spec = ac.spec ?? [0, 0, 0];
    const emis = ac.emis ?? [0, 0, 0];
    m = new THREE.MeshPhongMaterial({
      name: ac.name,
      color: new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace),
      specular: new THREE.Color().setRGB(spec[0], spec[1], spec[2], THREE.SRGBColorSpace),
      emissive: new THREE.Color().setRGB(emis[0], emis[1], emis[2], THREE.SRGBColorSpace),
      shininess: Math.max(1, ac.shi ?? 30),
      map: tex,
      side: twoSided ? THREE.DoubleSide : THREE.FrontSide,
      transparent: trans > 0.001 || alphaTex,
      opacity: 1 - trans,
      alphaTest: alphaTex ? 0.02 : 0,
      depthWrite: trans < 0.5,
    });
    m.userData.ac = ac;
    this.materials.set(key, m);
    return m;
  }

  async acNode(relPath) {
    let text = this.acText.get(relPath);
    if (text === undefined) {
      text = fetchText(`${this.baseUrl}/files/${relPath}.gz`);
      this.acText.set(relPath, text);
    }
    const parsed = parseAC(await text);
    const dir = dirOf(relPath);
    return buildAC(parsed, (ac, tex, opts) => this.material(ac, tex ? `${dir}/${tex}` : null, opts)).root;
  }
}

/** SimGear's offsets matrix: rotate pitch (y), roll (x), heading (z), then translate. */
function offsetsMatrix(cfg) {
  if (!cfg) return null;
  const p = cfg.getDoubleValue("pitch-deg", 0) * D2R;
  const r = cfg.getDoubleValue("roll-deg", 0) * D2R;
  const h = cfg.getDoubleValue("heading-deg", 0) * D2R;
  const m = new THREE.Matrix4().makeRotationZ(h)
    .multiply(new THREE.Matrix4().makeRotationX(r))
    .multiply(new THREE.Matrix4().makeRotationY(p));
  m.setPosition(cfg.getDoubleValue("x-m", 0), cfg.getDoubleValue("y-m", 0), cfg.getDoubleValue("z-m", 0));
  return m;
}

function fixedGroup(name, matrix) {
  const g = new THREE.Group();
  g.name = name ?? "";
  if (matrix) {
    g.matrixAutoUpdate = false;
    g.matrix.copy(matrix);
  }
  return g;
}

/** SimGear read_value(): property/expression with interpolation, step, factor, offset, clip. */
function readValue(props, cfg, unit, base, { defMin = -Infinity, defMax = Infinity } = {}) {
  const ex = cfg.getChild("expression");
  if (ex) return readExpression(props, ex.children[0], base);
  const name = cfg.getStringValue("property", "").trim();
  let v;
  if (!name) {
    const init = cfg.getDoubleValue(`starting-position${unit}`, 0);
    v = () => init;
  } else {
    const n = props.node(absPath(name, base));
    v = () => n.get();
  }
  const interp = cfg.getChild("interpolation");
  if (interp) {
    const t = readInterpTable(interp);
    const src = v;
    return () => t(src());
  }
  const step = cfg.getDoubleValue("step", 0);
  if (step) {
    const scroll = cfg.getDoubleValue("scroll", 0);
    const src = v;
    v = () => {
      const x = src();
      let mod = Math.floor(x / step) * step;
      const rem = x <= 0 ? -(x % step) : step - (x % step);
      if (rem > 0 && rem < scroll) mod += ((scroll - rem) / scroll) * step;
      return mod;
    };
  }
  const factor = cfg.getDoubleValue("factor", 1);
  const offset = cfg.getDoubleValue(`offset${unit}`, 0);
  if (factor !== 1 || offset !== 0) {
    const src = v;
    v = () => src() * factor + offset;
  }
  if (cfg.hasChild(`min${unit}`) || cfg.hasChild(`max${unit}`)) {
    const lo = cfg.getDoubleValue(`min${unit}`, defMin);
    const hi = cfg.getDoubleValue(`max${unit}`, defMax);
    const src = v;
    v = () => Math.min(hi, Math.max(lo, src()));
  }
  return v;
}

/** Installs an animation group above the named objects (SGAnimation::apply). */
function install(root, names, makeGroup) {
  const installed = new Set();
  const groups = [];
  const inGroup = (group, name) => {
    let anim = null;
    for (let i = group.children.length - 1; i >= 0; i--) {
      const child = group.children[i];
      if (installed.has(child) || child.userData.animGroup === makeGroup) continue;
      if (name === "" || child.name === name) {
        if (!anim) {
          anim = makeGroup();
          anim.userData.animGroup = makeGroup;
          group.add(anim);
          groups.push(anim);
        }
        anim.add(child);
        installed.add(child);
      }
    }
  };
  if (names.length === 0) {
    inGroup(root, "");
  } else {
    const visit = (g) => {
      for (const c of [...g.children]) if (c.isGroup || c.children.length) visit(c);
      for (const n of names) inGroup(g, n);
    };
    visit(root);
  }
  return groups;
}

function findLinePoints(root, name) {
  let pts = null;
  root.traverse((o) => {
    if (!pts && o.name === name && o.userData.linePoints) {
      pts = o.userData.linePoints;
      o.visible = false; // SimGear hides the axis object once used
    }
  });
  return pts;
}

/** Rotation centre and axis (SGAnimation::readRotationCenterAndAxis). */
function readCenterAxis(cfg, root) {
  const center = new THREE.Vector3();
  const axis = new THREE.Vector3(0, 0, 1);
  const axisCfg = cfg.getChild("axis");
  const objName = axisCfg?.getStringValue("object-name", "").trim();
  let fromObject = false;
  if (objName) {
    const pts = findLinePoints(root, objName);
    if (pts) {
      const a = new THREE.Vector3(pts[0], pts[1], pts[2]);
      const b = new THREE.Vector3(pts[3], pts[4], pts[5]);
      center.addVectors(a, b).multiplyScalar(0.5);
      axis.subVectors(b, a);
      fromObject = true;
    }
  }
  if (!fromObject && axisCfg) {
    if (axisCfg.hasChild("x1-m")) {
      const a = new THREE.Vector3(axisCfg.getDoubleValue("x1-m", 0), axisCfg.getDoubleValue("y1-m", 0), axisCfg.getDoubleValue("z1-m", 0));
      const b = new THREE.Vector3(axisCfg.getDoubleValue("x2-m", 0), axisCfg.getDoubleValue("y2-m", 0), axisCfg.getDoubleValue("z2-m", 0));
      center.addVectors(a, b).multiplyScalar(0.5);
      axis.subVectors(b, a);
    } else {
      axis.set(axisCfg.getDoubleValue("x", 0), axisCfg.getDoubleValue("y", 0), axisCfg.getDoubleValue("z", 0));
    }
  }
  if (axis.lengthSq() > 1e-20) axis.normalize();
  const c = cfg.getChild("center");
  if (c) center.set(c.getDoubleValue("x-m", center.x), c.getDoubleValue("y-m", center.y), c.getDoubleValue("z-m", center.z));
  return { center, axis };
}

function rotationAbout(center, axis, angleRad, out) {
  out.makeRotationAxis(axis, angleRad);
  // T(c) * R * T(-c)
  const e = out.elements;
  const cx = center.x, cy = center.y, cz = center.z;
  e[12] = cx - (e[0] * cx + e[4] * cy + e[8] * cz);
  e[13] = cy - (e[1] * cx + e[5] * cy + e[9] * cz);
  e[14] = cz - (e[2] * cx + e[6] * cy + e[10] * cz);
  return out;
}

/** Clones the materials below `groups` once so per-object changes stay local. */
function ownMaterials(groups, cloneTextures = false) {
  const mats = [];
  const seen = new Map();
  for (const g of groups) {
    g.traverse((o) => {
      if (!o.isMesh) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      const next = list.map((m) => {
        let c = seen.get(m);
        if (!c) {
          c = m.clone();
          if (cloneTextures && c.map) {
            const src = m.map;
            c.map = src.clone();
            if (!src.image && src.pendingClones) {
              // Upload once the shared image has loaded, not before.
              c.map.version = 0;
              src.pendingClones.push(c.map);
            }
          }
          seen.set(m, c);
          mats.push(c);
        }
        return c;
      });
      o.material = Array.isArray(o.material) ? next : next[0];
    });
  }
  return mats;
}

export class FGModel {
  constructor() {
    this.root = null;
    this.animations = [];
    this.picks = [];
    this.stats = { models: 0, animations: 0, unsupported: {} };
  }

  update(dt, camera) {
    for (const a of this.animations) a.update(dt, camera);
  }
}

/**
 * Loads a model (by manifest key) with all submodels and animations.
 * ctx: {props, base, nasal (NasalRuntime), commands}
 */
export async function loadModel(lib, key, ctx) {
  const model = new FGModel();
  model.root = await loadEntry(lib, key, ctx, model);
  return model;
}

async function loadEntry(lib, key, ctx, model) {
  const entry = lib.manifest.models[key];
  if (!entry) throw new Error(`model ${key} missing from manifest`);
  model.stats.models++;
  const cfg = entry.config ? ConfigNode.from(entry.config) : null;
  const content = new THREE.Group();
  content.name = "";
  if (entry.ac) content.add(await lib.acNode(entry.ac));
  else if (entry.base) content.add(await loadEntry(lib, entry.base, ctx, model));
  if (!cfg) return content;

  // Submodels, each under its offsets transform (named after <name>) and
  // an optional condition switch.
  const subs = cfg.getChildren("model");
  const loaded = await Promise.all(subs.map(async (s) => {
    const resolved = s.getStringValue("resolved", "");
    if (!resolved) return null;
    try {
      return await loadEntry(lib, resolved, ctx, model);
    } catch (err) {
      console.warn("submodel", resolved, err);
      return null;
    }
  }));
  subs.forEach((s, i) => {
    const node = loaded[i];
    if (!node) return;
    const align = fixedGroup(s.getStringValue("name", ""), offsetsMatrix(s.getChild("offsets")) ?? new THREE.Matrix4());
    align.add(node);
    const condCfg = s.getChild("condition");
    if (condCfg) {
      const sw = new THREE.Group();
      const cond = readCondition(ctx.props, condCfg, ctx.base);
      model.animations.push({ update: () => { sw.visible = cond(); } });
      sw.add(align);
      content.add(sw);
    } else {
      content.add(align);
    }
  });

  const actx = { ...ctx, lib, modelDir: entry.dir };
  // SGReaderWriterXML: effects are instantiated before the animations.
  for (const e of cfg.getChildren("effect")) {
    try {
      applyEffect(e, content, actx, model);
    } catch (err) {
      console.warn("effect", e.getStringValue("inherits-from"), err);
    }
  }
  for (const a of cfg.getChildren("animation")) {
    try {
      createAnimation(a, content, actx, model);
    } catch (err) {
      console.warn("animation", a.getStringValue("type"), err);
    }
  }

  const mainOffsets = offsetsMatrix(cfg.getChild("offsets"));
  if (mainOffsets) {
    const align = fixedGroup("Align Main Model", mainOffsets);
    align.add(content);
    return align;
  }
  return content;
}

/**
 * <effect> on named objects.  Only procedural lights change how things are
 * drawn here; other effects (glass, light maps, ...) keep the AC material.
 */
function applyEffect(cfg, root, ctx, model) {
  const effects = ctx.lib.manifest.effects ?? {};
  const key = cfg.getStringValue("resolved", "");
  if (!key || !effects[key]) return;
  if (!effectChain(effects, key).includes("Effects/procedural-light")) return;
  const params = effectParameters(effects, key);
  const names = new Set(cfg.getChildren("object-name").map((n) => n.getStringValue().trim()).filter(Boolean));
  const targets = [];
  root.traverse((o) => {
    if (names.has(o.name)) targets.push(o);
  });
  const use = params.intensity_scale?.use;
  const scale = use ? ctx.props.node(use) : null;
  for (const t of targets) {
    t.traverse((m) => {
      if (!m.isMesh) return;
      const mat = proceduralLightMaterial(params);
      m.material = mat;
      m.renderOrder = 10;
      if (scale) model.animations.push({ update: () => { mat.uniforms.intensityScale.value = scale.get(); } });
      model.stats.lights = (model.stats.lights ?? 0) + 1;
    });
  }
}

function createAnimation(cfg, root, ctx, model) {
  const { props, base } = ctx;
  const type = cfg.getStringValue("type", "").trim();
  const names = cfg.getChildren("object-name").map((n) => n.getStringValue().trim()).filter(Boolean);
  const animName = cfg.getStringValue("name", "").trim();
  const condCfg = cfg.getChild("condition");
  const cond = condCfg ? readCondition(props, condCfg, base) : null;
  const newGroup = (manual = false) => () => {
    const g = new THREE.Group();
    g.name = animName;
    if (manual) g.matrixAutoUpdate = false;
    return g;
  };
  model.stats.animations++;

  switch (type) {
    case "select": {
      const groups = install(root, names, newGroup());
      const c = cond ?? (() => true);
      model.animations.push({ update: () => { const v = c(); for (const g of groups) g.visible = v; } });
      return;
    }
    case "rotate":
    case "spin":
    case "knob": {
      const groups = install(root, names, newGroup(true));
      const { center, axis } = readCenterAxis(cfg, root);
      const value = readValue(props, cfg, type === "spin" ? "" : "-deg", base);
      const m = new THREE.Matrix4();
      let angle = type === "spin" ? cfg.getDoubleValue("starting-position-deg", 0) : 0;
      model.animations.push({
        update: (dt) => {
          if (cond && !cond()) return;
          if (type === "spin") angle = (angle + dt * value() * 6) % 360; // rpm -> deg/s
          else angle = value();
          rotationAbout(center, axis, angle * D2R, m);
          for (const g of groups) { g.matrix.copy(m); g.matrixWorldNeedsUpdate = true; }
        },
      });
      if (type === "knob") addPick(cfg, groups, ctx, model, true);
      return;
    }
    case "translate":
    case "slider": {
      const groups = install(root, names, newGroup(true));
      const a = cfg.getChild("axis");
      const axis = new THREE.Vector3(a?.getDoubleValue("x", 0) ?? 0, a?.getDoubleValue("y", 0) ?? 0, a?.getDoubleValue("z", 0) ?? 0);
      if (a?.getStringValue("object-name", "")) {
        const pts = findLinePoints(root, a.getStringValue("object-name").trim());
        if (pts) axis.set(pts[3] - pts[0], pts[4] - pts[1], pts[5] - pts[2]);
      }
      if (axis.lengthSq() > 1e-20) axis.normalize();
      const value = readValue(props, cfg, "-m", base);
      model.animations.push({
        update: () => {
          if (cond && !cond()) return;
          const v = value();
          for (const g of groups) {
            g.matrix.makeTranslation(axis.x * v, axis.y * v, axis.z * v);
            g.matrixWorldNeedsUpdate = true;
          }
        },
      });
      if (type === "slider") addPick(cfg, groups, ctx, model, true);
      return;
    }
    case "scale": {
      const groups = install(root, names, newGroup(true));
      const c = cfg.getChild("center");
      const center = new THREE.Vector3(c?.getDoubleValue("x-m", 0) ?? 0, c?.getDoubleValue("y-m", 0) ?? 0, c?.getDoubleValue("z-m", 0) ?? 0);
      const pn = cfg.getStringValue("property", "").trim();
      const src = pn ? props.node(absPath(pn, base)) : null;
      const comp = (k) => {
        const f = cfg.getDoubleValue(`${k}-factor`, 0);
        const o = cfg.getDoubleValue(`${k}-offset`, 1);
        const lo = cfg.getDoubleValue(`${k}-min`, -Infinity);
        const hi = cfg.getDoubleValue(`${k}-max`, Infinity);
        return () => Math.min(hi, Math.max(lo, (src ? src.get() : 0) * f + o));
      };
      const sx = comp("x"), sy = comp("y"), sz = comp("z");
      model.animations.push({
        update: () => {
          if (cond && !cond()) return;
          const m = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z)
            .multiply(new THREE.Matrix4().makeScale(sx(), sy(), sz()))
            .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
          for (const g of groups) { g.matrix.copy(m); g.matrixWorldNeedsUpdate = true; }
        },
      });
      return;
    }
    case "textranslate":
    case "texrotate": {
      const groups = install(root, names, newGroup());
      const mats = ownMaterials(groups, true);
      const value = readValue(props, cfg, type === "texrotate" ? "-deg" : "", base);
      const a = cfg.getChild("axis");
      const ax = a?.getDoubleValue("x", 0) ?? 0;
      const ay = a?.getDoubleValue("y", 0) ?? 0;
      const c = cfg.getChild("center");
      const cx = c?.getDoubleValue("x", 0) ?? 0;
      const cy = c?.getDoubleValue("y", 0) ?? 0;
      model.animations.push({
        update: () => {
          if (cond && !cond()) return;
          const v = value();
          for (const m of mats) {
            if (!m.map) continue;
            if (type === "textranslate") m.map.offset.set(ax * v, ay * v);
            else {
              m.map.center.set(cx, cy);
              m.map.rotation = (a?.getDoubleValue("z", -1) ?? -1) * v * D2R;
            }
          }
        },
      });
      return;
    }
    case "material": {
      const groups = install(root, names, newGroup());
      const mats = ownMaterials(groups, false);
      const color = (key, set) => {
        const c = cfg.getChild(key);
        if (!c) return null;
        const comp = (k) => {
          const pp = c.getStringValue(`${k}-prop`, "").trim();
          if (pp) {
            const n = props.node(absPath(pp, base));
            return () => n.get();
          }
          const v = c.getDoubleValue(k, -1);
          return v >= 0 ? () => v : null;
        };
        const fp = c.getStringValue("factor-prop", "").trim();
        const factor = fp ? props.node(absPath(fp, base)) : null;
        const r = comp("red"), g = comp("green"), b = comp("blue");
        if (!r && !g && !b) return null;
        return () => {
          const f = factor ? factor.get() : 1;
          for (const m of mats) set(m, r ? r() * f : null, g ? g() * f : null, b ? b() * f : null);
        };
      };
      const setters = [
        color("emission", (m, r, g, b) => m.emissive && m.emissive.setRGB(r ?? m.emissive.r, g ?? m.emissive.g, b ?? m.emissive.b, THREE.SRGBColorSpace)),
        color("diffuse", (m, r, g, b) => m.color && m.color.setRGB(r ?? m.color.r, g ?? m.color.g, b ?? m.color.b, THREE.SRGBColorSpace)),
        color("specular", (m, r, g, b) => m.specular && m.specular.setRGB(r ?? m.specular.r, g ?? m.specular.g, b ?? m.specular.b, THREE.SRGBColorSpace)),
      ].filter(Boolean);
      const tr = cfg.getChild("transparency");
      if (tr) {
        const ap = tr.getStringValue("alpha-prop", "").trim();
        const an = ap ? props.node(absPath(ap, base)) : null;
        const av = tr.getDoubleValue("alpha", 1);
        const f = tr.getDoubleValue("factor", 1), o = tr.getDoubleValue("offset", 0);
        const lo = tr.getDoubleValue("min", 0), hi = tr.getDoubleValue("max", 1);
        for (const m of mats) m.transparent = true;
        setters.push(() => {
          const a = Math.min(hi, Math.max(lo, (an ? an.get() : av) * f + o));
          for (const m of mats) m.opacity = a;
        });
      }
      const texProp = cfg.getStringValue("texture-prop", "").trim();
      const texStatic = cfg.getStringValue("texture", "").trim();
      const modelDir = ctx.modelDir ?? "";
      if (texStatic && !texProp) {
        const t = ctx.lib?.texture(`${modelDir}/${texStatic}`);
        if (t) for (const m of mats) { m.map = t; m.needsUpdate = true; }
      }
      if (setters.length) {
        model.animations.push({ update: () => { if (cond && !cond()) return; for (const s of setters) s(); } });
      }
      return;
    }
    case "range": {
      const groups = install(root, names, newGroup());
      const minP = cfg.getStringValue("min-property", "").trim();
      const maxP = cfg.getStringValue("max-property", "").trim();
      const minN = minP ? props.node(absPath(minP, base)) : null;
      const maxN = maxP ? props.node(absPath(maxP, base)) : null;
      const lo = cfg.getDoubleValue("min-m", 0);
      const hi = cfg.getDoubleValue("max-m", Infinity);
      const f = cfg.getDoubleValue("min-factor", 1);
      const tmp = new THREE.Vector3();
      model.animations.push({
        update: (dt, camera) => {
          if (!camera) return;
          for (const g of groups) {
            g.getWorldPosition(tmp);
            const d = tmp.distanceTo(camera.position);
            const mn = minN ? minN.get() * f : lo;
            const mx = maxN ? maxN.get() : hi;
            g.visible = d >= mn && d <= mx;
          }
        },
      });
      return;
    }
    case "dist-scale": {
      // Scale with the distance to the viewer (e.g. lights stay visible far away).
      const groups = install(root, names, newGroup(true));
      const interp = cfg.getChild("interpolation");
      const table = interp ? readInterpTable(interp) : null;
      const factor = cfg.getDoubleValue("factor", 1);
      const offset = cfg.getDoubleValue("offset", 0);
      const c = cfg.getChild("center");
      const center = new THREE.Vector3(c?.getDoubleValue("x-m", 0) ?? 0, c?.getDoubleValue("y-m", 0) ?? 0, c?.getDoubleValue("z-m", 0) ?? 0);
      const lo = cfg.getDoubleValue("min", 0);
      const hi = cfg.getDoubleValue("max", Infinity);
      const world = new THREE.Vector3();
      model.animations.push({
        update: (dt, camera) => {
          if (!camera) return;
          for (const g of groups) {
            world.copy(center).applyMatrix4(g.parent.matrixWorld);
            const d = world.distanceTo(camera.position);
            const f = Math.min(hi, Math.max(lo, table ? table(d) : d * factor + offset));
            g.matrix.makeScale(f, f, f).setPosition(center.x * (1 - f), center.y * (1 - f), center.z * (1 - f));
            g.matrixWorldNeedsUpdate = true;
          }
        },
      });
      return;
    }
    case "billboard": {
      const groups = install(root, names, newGroup(true));
      const spherical = cfg.getBoolValue("spherical", true);
      const q = new THREE.Quaternion();
      const inv = new THREE.Matrix4();
      const camLocal = new THREE.Vector3();
      model.animations.push({
        update: (dt, camera) => {
          if (!camera) return;
          for (const g of groups) {
            inv.copy(g.parent.matrixWorld).invert();
            camLocal.copy(camera.position).applyMatrix4(inv).normalize();
            if (!spherical) camLocal.z = 0;
            // Model billboards face -y toward the viewer in FlightGear's frame.
            q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), camLocal.normalize());
            g.matrix.makeRotationFromQuaternion(q);
            g.matrixWorldNeedsUpdate = true;
          }
        },
      });
      return;
    }
    case "pick":
    case "touch": {
      const groups = install(root, names, newGroup());
      addPick(cfg, groups, ctx, model, false);
      return;
    }
    case "noshadow":
    case "shader":
    case "effect":
    case "light":
    case "alpha-test":
    case "blend":
    case "flash":
    case "interaction":
    case "lod":
    case "trigger":
    case "timed":
    case "enable-hot":
    case "tag":
    default:
      model.stats.unsupported[type] = (model.stats.unsupported[type] ?? 0) + 1;
  }
}

/** set-tooltip hover binding -> () => text (FlightGear's tooltip command). */
function readTooltip(props, base, bnode, nasal) {
  if (!bnode || bnode.getStringValue("command", "").trim() !== "set-tooltip") return null;
  const label = bnode.getStringValue("label", "");
  const pn = bnode.getChild("property");
  const path = pn ? absPath(pn.getStringValue().trim(), base) : null;
  const mapping = bnode.getStringValue("mapping", "").trim();
  const script = mapping === "nasal" ? bnode.getStringValue("script", "") : "";
  const fn = script && nasal ? nasal.compile(script) : null;
  return () => {
    let v = path ? (props.jsb.propType(props.jsb.handle(path, false)) === 4 ? props.getString(path) : props.get(path)) : null;
    if (mapping === "percent") v = Math.round(v * 100);
    else if (mapping === "heading") v = ((Math.round(v) % 360) + 360) % 360;
    else if (mapping === "on-off") v = v ? "ON" : "OFF";
    else if (mapping === "arm-disarm") v = v ? "ARMED" : "DISARMED";
    else if (fn) v = fn(v);
    if (v === null || !/%/.test(label)) return label.replace(/%%/g, "%");
    return sprintf(label, v);
  };
}

/**
 * Clickable objects (SGPickAnimation): plain picks fire <action> bindings
 * for their buttons (repeating while held when repeatable, <mod-up> on
 * release); knobs and sliders increase/decrease on click, wheel and drag.
 */
function addPick(cfg, groups, ctx, model, isKnob) {
  const { props, base } = ctx;
  const cond = cfg.getChild("condition") ? readCondition(props, cfg.getChild("condition"), base) : null;
  const bctx = { nasal: ctx.nasal ? (n) => ctx.nasal.binding(n) : null, commands: ctx.commands };
  const list = (node) => readBindings(props, node?.getChildren("binding") ?? [], base, bctx);
  let actions = null;
  let knob = null;
  if (isKnob) {
    const shiftRepeat = cfg.getIntValue("shift-repeat", 10);
    const action = list(cfg.getChild("action"));
    const increase = list(cfg.getChild("increase"));
    const decrease = list(cfg.getChild("decrease"));
    const explicitShift = cfg.hasChild("shift-action") || cfg.hasChild("shift-increase") || cfg.hasChild("shift-decrease");
    const sAction = list(cfg.getChild("shift-action"));
    const sIncrease = list(cfg.getChild("shift-increase"));
    const sDecrease = list(cfg.getChild("shift-decrease"));
    const once = (dir, a, inc, dec) => {
      if (dir > 0) { a(1); inc(); } else { a(-1); dec(); }
    };
    knob = {
      fire(dir, shifted) {
        if (!shifted) once(dir, action, increase, decrease);
        else if (explicitShift) once(dir, sAction, sIncrease, sDecrease);
        else for (let i = 0; i < shiftRepeat; i++) once(dir, action, increase, decrease);
      },
      release: list(cfg.getChild("release")),
      interval: cfg.getDoubleValue("interval-sec", 0.1),
      dragScale: cfg.getDoubleValue("drag-scale-px", 10),
      dragDirection: cfg.getStringValue("drag-direction", "horizontal").trim() || "horizontal",
    };
  } else {
    actions = cfg.getChildren("action").map((a) => ({
      buttons: new Set(a.getChildren("button").map((b) => b.getIntValue())),
      repeatable: a.getBoolValue("repeatable", false),
      interval: a.getDoubleValue("interval-sec", 0.1),
      down: list(a),
      up: list(a.getChild("mod-up")),
    }));
  }
  const tooltip = readTooltip(props, base, cfg.getChild("hovered")?.getChild("binding"), ctx.nasal);
  for (const g of groups) {
    const pick = { group: g, actions, knob, tooltip, enabled: () => !cond || cond() };
    g.userData.pick = pick;
    model.picks.push(pick);
  }
}
