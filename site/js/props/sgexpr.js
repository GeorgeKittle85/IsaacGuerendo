// SimGear's condition, expression, input-value and binding semantics
// (simgear/props/condition.cxx, simgear/structure/SGExpression.cxx,
// src/Autopilot/inputvalue.cxx, fg_commands.cxx) on top of PropertyTree.
//
// Everything compiles a ConfigNode into a small closure once, so evaluation
// every frame is just a few property reads.

import { joinPath } from "./props.js";

/** Resolves a FlightGear-style property path against a base (default "/"). */
export function absPath(path, base = "/") {
  path = path.trim();
  if (path.startsWith("/")) return path;
  return joinPath(base, path);
}

const isNumeric = (s) => s !== "" && !Number.isNaN(Number(s));

// ---------------------------------------------------------------- conditions

/** sgReadCondition: all condition children of `node` ANDed together. */
export function readCondition(props, node, base = "/") {
  if (!node) return () => true;
  return readAnd(props, node, base);
}

function readAnd(props, node, base) {
  const parts = node.children.map((c) => readConditionElement(props, c, base)).filter(Boolean);
  if (parts.length === 0) return () => true;
  if (parts.length === 1) return parts[0];
  return () => {
    for (const p of parts) if (!p()) return false;
    return true;
  };
}

function readOr(props, node, base) {
  const parts = node.children.map((c) => readConditionElement(props, c, base)).filter(Boolean);
  return () => {
    for (const p of parts) if (p()) return true;
    return false;
  };
}

function readConditionElement(props, node, base) {
  switch (node.name) {
    case "property": {
      const p = absPath(node.getStringValue(), base);
      const n = props.node(p);
      return () => n.getBool();
    }
    case "not": {
      const inner = node.children.map((c) => readConditionElement(props, c, base)).find(Boolean);
      return inner ? () => !inner() : () => true;
    }
    case "and":
      return readAnd(props, node, base);
    case "or":
      return readOr(props, node, base);
    case "less-than":
      return readComparison(props, node, base, (c) => c < 0);
    case "less-than-equals":
      return readComparison(props, node, base, (c) => c <= 0);
    case "greater-than":
      return readComparison(props, node, base, (c) => c > 0);
    case "greater-than-equals":
      return readComparison(props, node, base, (c) => c >= 0);
    case "equals":
      return readComparison(props, node, base, (c) => c === 0);
    case "not-equals":
      return readComparison(props, node, base, (c) => c !== 0);
    case "true":
      return () => true;
    case "false":
      return () => false;
    default:
      return null;
  }
}

function readOperand(props, node, base) {
  switch (node.name) {
    case "property": {
      const path = absPath(node.getStringValue(), base);
      const n = props.node(path);
      return { num: () => n.get(), str: () => props.getString(path) };
    }
    case "value": {
      const s = node.getStringValue().trim();
      const v = isNumeric(s) ? Number(s) : s === "true" ? 1 : s === "false" ? 0 : NaN;
      return { num: () => v, str: () => s, isString: !isNumeric(s) && s !== "true" && s !== "false" };
    }
    case "expression": {
      const e = readExpression(props, node.children[0], base);
      return { num: e, str: () => String(e()) };
    }
    default:
      return null;
  }
}

function readComparison(props, node, base, pred) {
  const ops = node.children.map((c) => readOperand(props, c, base)).filter(Boolean);
  if (ops.length < 2) return () => false;
  const [l, r] = ops;
  const precision = ops[2] ? ops[2].num : null;
  if (l.isString || r.isString) {
    // String comparison (e.g. livery or season names).
    return () => {
      const a = l.str().trim();
      const b = r.str().trim();
      return pred(a < b ? -1 : a > b ? 1 : 0);
    };
  }
  return () => {
    let a = l.num();
    let b = r.num();
    if (precision) {
      const p = precision();
      if (p > 0) {
        a = Math.round(a / p) * p;
        b = Math.round(b / p) * p;
      }
    }
    return pred(a < b ? -1 : a > b ? 1 : 0);
  };
}

// --------------------------------------------------------------- expressions

const UNARY = {
  abs: Math.abs, sqr: (x) => x * x, sqrt: Math.sqrt, log: Math.log, ln: Math.log, log10: Math.log10,
  exp: Math.exp, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos,
  atan: Math.atan, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, ceil: Math.ceil,
  floor: Math.floor, rad2deg: (x) => (x * 180) / Math.PI, deg2rad: (x) => (x * Math.PI) / 180,
  neg: (x) => -x, "float-to-int": Math.trunc, trunc: Math.trunc, round: Math.round,
};

/** SGReadDoubleExpression for one expression element. */
export function readExpression(props, node, base = "/") {
  if (!node) return () => 0;
  const name = node.name;
  const args = () => node.children.map((c) => readExpression(props, c, base));
  if (name === "value") {
    const v = node.getDoubleValue();
    return () => v;
  }
  if (name === "property") {
    const n = props.node(absPath(node.getStringValue(), base));
    return () => n.get();
  }
  if (UNARY[name]) {
    const f = UNARY[name];
    const a = args()[0] ?? (() => 0);
    return () => f(a());
  }
  switch (name) {
    case "sum": case "add": {
      const a = args();
      return () => { let s = 0; for (const f of a) s += f(); return s; };
    }
    case "difference": case "dif": case "sub": {
      const a = args();
      return () => { let s = a[0] ? a[0]() : 0; for (let i = 1; i < a.length; i++) s -= a[i](); return s; };
    }
    case "product": case "prod": case "mul": {
      const a = args();
      return () => { let s = 1; for (const f of a) s *= f(); return s; };
    }
    case "div": {
      const [a, b] = args();
      return () => a() / b();
    }
    case "mod": {
      const [a, b] = args();
      return () => a() % b();
    }
    case "pow": {
      const [a, b] = args();
      return () => Math.pow(a(), b());
    }
    case "atan2": {
      const [a, b] = args();
      return () => Math.atan2(a(), b());
    }
    case "min": {
      const a = args();
      return () => Math.min(...a.map((f) => f()));
    }
    case "max": {
      const a = args();
      return () => Math.max(...a.map((f) => f()));
    }
    case "clip": {
      const lo = node.getDoubleValue("clipMin", -Infinity);
      const hi = node.getDoubleValue("clipMax", Infinity);
      const inner = node.children.filter((c) => c.name !== "clipMin" && c.name !== "clipMax")
        .map((c) => readExpression(props, c, base))[0] ?? (() => 0);
      return () => Math.min(hi, Math.max(lo, inner()));
    }
    case "table": case "interpolate": {
      const input = node.children.filter((c) => c.name !== "entry").map((c) => readExpression(props, c, base))[0] ?? (() => 0);
      const table = readInterpTable(node);
      return () => table(input());
    }
    case "not": {
      const a = args()[0];
      return () => (a() ? 0 : 1);
    }
    case "and": {
      const a = args();
      return () => (a.every((f) => f()) ? 1 : 0);
    }
    case "or": {
      const a = args();
      return () => (a.some((f) => f()) ? 1 : 0);
    }
    case "equal": case "equals": {
      const [a, b] = args();
      return () => (a() === b() ? 1 : 0);
    }
    case "less": case "less-than": {
      const [a, b] = args();
      return () => (a() < b() ? 1 : 0);
    }
    case "greater": case "greater-than": {
      const [a, b] = args();
      return () => (a() > b() ? 1 : 0);
    }
    case "cond": {
      const cond = readCondition(props, node.getChild("condition"), base);
      const vals = node.children.filter((c) => c.name !== "condition").map((c) => readExpression(props, c, base));
      return () => (cond() ? (vals[0] ? vals[0]() : 0) : vals[1] ? vals[1]() : 0);
    }
    default: {
      // Unknown operator: behave like SimGear and fall back to the text value.
      const v = node.getDoubleValue();
      return () => v;
    }
  }
}

/** SGInterpTable from <entry><ind/><dep/></entry> children (clamped at ends). */
export function readInterpTable(node) {
  const pts = node.getChildren("entry")
    .map((e) => [e.getDoubleValue("ind"), e.getDoubleValue("dep")])
    .sort((a, b) => a[0] - b[0]);
  return (x) => interp(pts, x);
}

export function interp(pts, x) {
  const n = pts.length;
  if (n === 0) return x;
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[n - 1][0]) return pts[n - 1][1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid][0] <= x) lo = mid;
    else hi = mid;
  }
  const [x0, y0] = pts[lo];
  const [x1, y1] = pts[hi];
  return x1 === x0 ? y0 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
}

// -------------------------------------------------------------- input values

/** FGInputValue: <property>/<value>/<expression> with scale, offset, min, max, abs, period. */
export function readInputValue(props, node, base = "/", defValue = 0, defScale = 1, defOffset = 0) {
  if (!node) return { get: () => defValue, cond: null };
  let value = defValue;
  const condNode = node.getChild("condition");
  const cond = condNode ? readCondition(props, condNode, base) : null;
  const scale = node.getChild("scale") ? readInputValue(props, node.getChild("scale"), base, defScale) : null;
  const offset = node.getChild("offset") ? readInputValue(props, node.getChild("offset"), base, defOffset) : null;
  const max = node.getChild("max") ? readInputValue(props, node.getChild("max"), base) : null;
  const min = node.getChild("min") ? readInputValue(props, node.getChild("min"), base) : null;
  const abs = node.getChild("abs") ? node.getBoolValue("abs") : false;
  const periodNode = node.getChild("period");
  const period = periodNode
    ? { min: readInputValue(props, periodNode.getChild("min"), base), max: readInputValue(props, periodNode.getChild("max"), base) }
    : null;
  const valueNode = node.getChild("value");
  if (valueNode) value = valueNode.getDoubleValue();

  let source = null;
  const exprNode = node.getChild("expression");
  const propNode = node.getChild("property") ?? node.getChild("prop");
  if (exprNode) {
    source = readExpression(props, exprNode.children[0], base);
  } else if (propNode) {
    const path = absPath(propNode.getStringValue(), base);
    const pn = props.node(path);
    if (valueNode) {
      // Both <property> and <value>: initialise the property with the value.
      const s = scale ? scale.get() : 1;
      pn.set(s !== 0 ? (value - (offset ? offset.get() : 0)) / s : 0);
    }
    source = () => pn.get();
  } else if (!valueNode && !node.children.length) {
    const text = node.getStringValue().trim();
    if (text && !isNumeric(text)) {
      const pn = props.node(absPath(text, base));
      source = () => pn.get();
    } else if (text) {
      value = Number(text);
    }
  }

  const get = () => {
    let v = source ? source() : value;
    if (scale) v *= scale.get();
    if (offset) v += offset.get();
    if (min) v = Math.max(v, min.get());
    if (max) v = Math.min(v, max.get());
    if (period) v = normalizePeriod(v, period.min.get(), period.max.get());
    return abs ? Math.abs(v) : v;
  };
  return { get, cond };
}

export function normalizePeriod(v, lo, hi) {
  const range = hi - lo;
  if (range <= 0) return v;
  return lo + ((((v - lo) % range) + range) % range);
}

/** InputValueList: the first entry whose <condition> passes. */
export function readInputValueList(props, nodes, base = "/", defValue = 0) {
  const list = nodes.map((n) => readInputValue(props, n, base, defValue));
  if (list.length === 0) return { get: () => defValue, empty: true };
  return {
    empty: false,
    get: () => {
      for (const iv of list) if (!iv.cond || iv.cond()) return iv.get();
      return list[list.length - 1].get();
    },
  };
}

// ----------------------------------------------------------------- bindings

/** Active property-interpolate tweens, advanced by updateTweens(dt). */
const tweens = new Map();

export function updateTweens(props, dt) {
  for (const [path, tw] of tweens) {
    tw.t += dt;
    const f = tw.dur > 0 ? Math.min(1, tw.t / tw.dur) : 1;
    props.set(path, tw.from + (tw.to - tw.from) * f);
    if (f >= 1) tweens.delete(path);
  }
}

export function interpolateProperty(props, path, to, seconds) {
  const from = props.get(path);
  if (seconds <= 0) {
    tweens.delete(path);
    props.set(path, to);
  } else {
    tweens.set(path, { from, to, dur: seconds, t: 0 });
  }
}

/**
 * Compiles an SGBinding (<command>property-assign</command> ...) into a
 * function. `ctx` may supply {commands: {name: fn(node)}} for extra commands.
 */
export function readBinding(props, node, base = "/", ctx = {}) {
  const cmd = node.getStringValue("command").trim();
  const propNodes = node.getChildren("property");
  const paths = propNodes.map((p) => absPath(p.getStringValue(), base));
  const target = paths[0];
  const valueOf = (n) => {
    const t = n.type;
    const s = n.getStringValue().trim();
    if (t === "bool") return s === "true" || s === "1";
    if (t === "string") return n.getStringValue();
    return isNumeric(s) ? Number(s) : s === "true" ? true : s === "false" ? false : s;
  };
  const clampWrap = (v) => {
    const mn = node.getChild("min") ? node.getDoubleValue("min") : null;
    const mx = node.getChild("max") ? node.getDoubleValue("max") : null;
    if (node.getBoolValue("wrap") && mn !== null && mx !== null) return normalizePeriod(v, mn, mx);
    if (mn !== null) v = Math.max(mn, v);
    if (mx !== null) v = Math.min(mx, v);
    return v;
  };
  switch (cmd) {
    case "property-assign": {
      const vn = node.getChild("value");
      if (vn) {
        const v = valueOf(vn);
        return () => props.set(target, v);
      }
      if (paths[1]) return () => props.set(target, props.get(paths[1]));
      return () => {};
    }
    case "property-toggle": {
      const vals = node.getChildren("value").map(valueOf);
      if (vals.length >= 2) {
        return () => props.set(target, props.get(target) === Number(vals[0]) ? vals[1] : vals[0]);
      }
      return () => props.toggle(target);
    }
    case "property-adjust": {
      const step = node.getDoubleValue("step", 0);
      const offsetNode = node.getChild("offset");
      const factor = node.getDoubleValue("factor", 1);
      const mask = node.getStringValue("mask", "");
      return (settingDelta = null) => {
        let d = step;
        if (offsetNode) d = node.getDoubleValue("offset") * factor;
        if (settingDelta !== null) d = settingDelta * factor;
        let v = props.get(target) + d;
        if (mask === "integer") v = Math.round(v);
        props.set(target, clampWrap(v));
      };
    }
    case "property-multiply": {
      const factor = node.getDoubleValue("factor", 1);
      return () => props.set(target, clampWrap(props.get(target) * factor));
    }
    case "property-scale": {
      const offset = node.getDoubleValue("offset", 0);
      const factor = node.getDoubleValue("factor", 1);
      const squared = node.getBoolValue("squared", false);
      const power = node.getDoubleValue("power", 1);
      return (setting = 0) => {
        let s = setting;
        if (squared) s = Math.sign(s) * s * s;
        if (power !== 1) s = Math.sign(s) * Math.pow(Math.abs(s), power);
        props.set(target, (s + offset) * factor);
      };
    }
    case "property-swap": {
      return () => {
        const a = props.get(paths[0]);
        props.set(paths[0], props.get(paths[1]));
        props.set(paths[1], a);
      };
    }
    case "property-cycle": {
      const vals = node.getChildren("value").map(valueOf);
      return () => {
        const cur = props.get(target);
        const i = vals.findIndex((v) => Number(v) === cur);
        props.set(target, vals[(i + 1) % vals.length]);
      };
    }
    case "property-interpolate": {
      const vn = node.getChild("value");
      const time = node.getDoubleValue("time", 0);
      const rate = node.getDoubleValue("rate", 0);
      return () => {
        const to = vn ? vn.getDoubleValue() : props.get(paths[1]);
        const dur = rate > 0 ? Math.abs(to - props.get(target)) / rate : time;
        interpolateProperty(props, target, to, dur);
      };
    }
    case "nasal":
      return ctx.nasal ? ctx.nasal(node) : () => {};
    default: {
      const handler = ctx.commands?.[cmd];
      return handler ? () => handler(node, props) : () => {};
    }
  }
}

/** Compiles all <binding> children of `node` into one function. */
export function readBindings(props, nodes, base = "/", ctx = {}) {
  const fns = nodes.map((b) => {
    const cond = b.getChild("condition") ? readCondition(props, b.getChild("condition"), base) : null;
    const fn = readBinding(props, b, base, ctx);
    return (...args) => { if (!cond || cond()) fn(...args); };
  });
  return (...args) => { for (const f of fns) f(...args); };
}
