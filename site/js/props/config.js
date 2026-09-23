// Read-only view of a FlightGear PropertyList config tree (property rules,
// model XML, sound XML) as produced by tools/proplist.py:to_json().
// Mirrors the SGPropertyNode calls the FlightGear loaders use.

export class ConfigNode {
  constructor(json, parent = null) {
    this.j = json;
    this.parent = parent;
    this._children = null;
  }

  static from(json) {
    return new ConfigNode(json);
  }

  get name() {
    return this.j.n;
  }

  get index() {
    return this.j.i ?? 0;
  }

  get children() {
    if (!this._children) this._children = (this.j.c ?? []).map((c) => new ConfigNode(c, this));
    return this._children;
  }

  get nChildren() {
    return this.children.length;
  }

  get root() {
    let n = this;
    while (n.parent) n = n.parent;
    return n;
  }

  getChild(name, index = 0) {
    for (const c of this.children) if (c.name === name && c.index === index) return c;
    return null;
  }

  getChildren(name) {
    return this.children.filter((c) => c.name === name).sort((a, b) => a.index - b.index);
  }

  hasChild(name) {
    return this.children.some((c) => c.name === name);
  }

  /** Follows alias="..." (resolved relative to this node, as SimGear does). */
  resolve() {
    let n = this;
    for (let guard = 0; n.j.a && guard < 16; guard++) {
      const t = n.getNode(n.j.a);
      if (!t) break;
      n = t;
    }
    return n;
  }

  /** Relative/absolute path lookup inside the config tree ("../../params/x"). */
  getNode(path) {
    let n = path.startsWith("/") ? this.root : this;
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        n = n.parent;
      } else {
        const m = /^(.*?)(?:\[(\d+)\])?$/.exec(part);
        n = n.getChild(m[1], m[2] ? +m[2] : 0);
      }
      if (!n) return null;
    }
    return n;
  }

  /** Text value of this node or of child `name`. */
  getStringValue(name, def = "") {
    const n = name === undefined ? this : this.getNode(name);
    if (!n) return def;
    const r = n.resolve();
    return r.j.v ?? (r.j.c ? def : "");
  }

  getDoubleValue(name, def = 0) {
    const s = this.getStringValue(name, null);
    if (s === null || s === "") return def;
    if (s === "true") return 1;
    if (s === "false") return 0;
    const v = parseFloat(s);
    return Number.isNaN(v) ? def : v;
  }

  getIntValue(name, def = 0) {
    return Math.trunc(this.getDoubleValue(name, def));
  }

  getBoolValue(name, def = false) {
    const s = this.getStringValue(name, null);
    if (s === null || s === "") return def;
    const t = s.trim().toLowerCase();
    if (t === "true" || t === "yes") return true;
    if (t === "false" || t === "no") return false;
    const v = parseFloat(t);
    return Number.isNaN(v) ? def : v !== 0;
  }

  get type() {
    return this.resolve().j.t ?? "unspecified";
  }

  /** Path of this node inside its config tree (for debugging). */
  get path() {
    const parts = [];
    for (let n = this; n.parent; n = n.parent) parts.unshift(n.index ? `${n.name}[${n.index}]` : n.name);
    return "/" + parts.join("/");
  }
}
