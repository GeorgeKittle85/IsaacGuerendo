// FlightGear-style property tree on top of JSBSim's own SGPropertyNode tree.
//
// JSBSim roots its properties at /fdm/jsbsim inside a global tree, exactly
// where FlightGear mounts them, so FlightGear's absolute paths (/controls/...,
// /engines/...) and the aircraft's JSBSim-relative ones (fcs/...) live in one
// tree just like on the desktop.  Relative paths resolve under /fdm/jsbsim.

export class PropertyTree {
  constructor(jsbsim) {
    this.jsb = jsbsim;
    this.cache = new Map();
    this.gen = jsbsim.generation;
    this.listeners = new Map(); // path -> Set(fn), fired by set() from JS
  }

  _h(path) {
    if (this.gen !== this.jsb.generation) {
      this.cache.clear();
      this.gen = this.jsb.generation;
    }
    let h = this.cache.get(path);
    if (h === undefined) {
      h = this.jsb.handle(path, true);
      this.cache.set(path, h);
    }
    return h;
  }

  /** Numeric value (bools read as 0/1, missing nodes as 0). */
  get(path) {
    return this.jsb.get(this._h(path));
  }

  getBool(path) {
    return this.jsb.get(this._h(path)) !== 0;
  }

  getString(path) {
    return this.jsb.getString(this._h(path));
  }

  set(path, value) {
    const h = this._h(path);
    if (typeof value === "string") this.jsb.setString(h, value);
    else if (typeof value === "boolean") this.jsb.setBool(h, value ? 1 : 0);
    else this.jsb.set(h, value);
    const ls = this.listeners.get(path);
    if (ls) for (const fn of ls) fn(value);
  }

  /** Adds v to a numeric property and returns the new value. */
  add(path, v) {
    const nv = this.get(path) + v;
    this.set(path, nv);
    return nv;
  }

  toggle(path) {
    const nv = !this.getBool(path);
    this.set(path, nv);
    return nv;
  }

  alias(path, target) {
    this.cache.delete(path);
    return this.jsb.alias(path, target);
  }

  /** Fast accessor object for hot loops. */
  node(path) {
    const tree = this;
    let h = -1;
    let gen = -1;
    const resolve = () => {
      if (gen !== tree.jsb.generation) {
        h = tree._h(path);
        gen = tree.jsb.generation;
      }
      return h;
    };
    return {
      path,
      get: () => tree.jsb.get(resolve()),
      getBool: () => tree.jsb.get(resolve()) !== 0,
      set: (v) => (typeof v === "boolean" ? tree.jsb.setBool(resolve(), v ? 1 : 0) : tree.jsb.set(resolve(), v)),
    };
  }

  /** Called when JS code sets `path` through this tree (not for FDM writes). */
  listen(path, fn) {
    if (!this.listeners.has(path)) this.listeners.set(path, new Set());
    this.listeners.get(path).add(fn);
    return () => this.listeners.get(path).delete(fn);
  }

  /** Applies {values:[[path, v]], aliases:[[path, target]]} from build_props.py. */
  applyInitial({ values = [], aliases = [] }) {
    for (const [p, v] of values) this.set(p, v);
    for (const [p, t] of aliases) this.alias(p, t);
  }
}

/** Joins a relative property path onto a base the way SimGear does. */
export function joinPath(base, rel) {
  if (!rel) return base;
  if (rel.startsWith("/")) return rel;
  const parts = base ? base.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return (base.startsWith("/") ? "/" : "") + parts.filter(Boolean).join("/");
}
