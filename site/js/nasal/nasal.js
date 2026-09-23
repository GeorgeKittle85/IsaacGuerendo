// A small Nasal runtime for the scripts embedded in aircraft XML.
//
// FlightGear aircraft put short Nasal snippets in their model and dialog
// bindings (switch logic, door toggles, tooltip formatting).  Nasal's syntax
// is close to JavaScript's, so each snippet is tokenised and rewritten into
// JavaScript (func -> function, ~ -> string concatenation, and/or, elsif,
// foreach, nil) and run against a small library: getprop/setprop,
// interpolate, settimer/maketimer, sprintf, math, std, props.globals, and
// aircraft-specific namespaces supplied by the caller (e.g. c172p.*).
//
// The aircraft's large Nasal modules (electrical.nas, engine.nas, ...) are
// ported by hand in js/aircraft; this runtime is for the snippets.

import { interpolateProperty } from "../props/sgexpr.js";

// `var` stays `var`: Nasal allows redeclaring a variable, and a var inside
// the generated function still shadows the library object used by `with`.
const KEYWORD_MAP = {
  elsif: "else if",
  and: "&&",
  or: "||",
  nil: "null",
  me: "this",
};

function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "#") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (/\s/.test(c)) {
      let j = i;
      while (j < n && /\s/.test(src[j])) j++;
      out.push({ t: "ws", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let s = "";
      while (j < n && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < n) {
          const e = src[j + 1];
          if (c === "'") s += e === "'" ? "'" : "\\" + e;
          else s += { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" }[e] ?? e;
          j += 2;
        } else {
          s += src[j++];
        }
      }
      // Nasal backquotes are character constants.
      out.push(c === "`" ? { t: "num", v: String(s.charCodeAt(0) || 0) } : { t: "str", v: JSON.stringify(s) });
      i = j + 1;
      continue;
    }
    const num = /^(0x[0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(src.slice(i, i + 40));
    if (num) {
      out.push({ t: "num", v: num[1] });
      i += num[1].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 80));
    if (id) {
      out.push({ t: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    const op = /^(\.\.\.|==|!=|<=|>=|~=|\+=|-=|\*=|\/=|[-+*/~!<>=?:()[\]{},;.])/.exec(src.slice(i, i + 3));
    if (op) {
      out.push({ t: "op", v: op[1] });
      i += op[1].length;
      continue;
    }
    throw new Error(`Nasal: unexpected character '${c}'`);
  }
  return out;
}

/** Rewrites Nasal source into a JavaScript function body. */
export function translate(src) {
  const toks = tokenize(src);
  const out = [];
  const next = (k) => {
    for (let j = k + 1; j < toks.length; j++) if (toks[j].t !== "ws") return j;
    return -1;
  };
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.t === "id") {
      // foreach (var x; list) / forindex (var i; list)
      if (tk.v === "foreach" || tk.v === "forindex") {
        const p = next(k);
        let j = next(p);
        if (toks[j]?.v === "var") j = next(j);
        const name = toks[j].v;
        const semi = next(j);
        out.push(tk.v === "foreach" ? `for (var ${name} of (` : `for (var ${name} of __keys(`);
        k = semi;
        // The loop header ends at the matching ')', which stays as-is; close
        // our extra parenthesis just before it.
        let depth = 1;
        let m = k + 1;
        for (; m < toks.length; m++) {
          if (toks[m].v === "(") depth++;
          else if (toks[m].v === ")" && --depth === 0) break;
        }
        toks.splice(m, 0, { t: "op", v: ")" });
        continue;
      }
      if (tk.v === "func") {
        const j = next(k);
        out.push("function");
        if (toks[j]?.v === "{") out.push("(...arg)");
        continue;
      }
      if (tk.v === "var") {
        // var (a, b) = ... -> var [a, b] = ...
        const j = next(k);
        if (toks[j]?.v === "(") {
          out.push("var [");
          let m = j + 1;
          for (; m < toks.length && toks[m].v !== ")"; m++) out.push(toks[m].v);
          out.push("]");
          k = m;
          continue;
        }
      }
      out.push(KEYWORD_MAP[tk.v] ?? tk.v);
      continue;
    }
    if (tk.t === "op") {
      if (tk.v === "~") { out.push('+ "" +'); continue; }
      if (tk.v === "~=") { out.push('+= "" +'); continue; }
      out.push(tk.v);
      continue;
    }
    out.push(tk.v);
  }
  return out.join("");
}

/** Minimal C-style sprintf covering what aircraft scripts use. */
export function sprintf(fmt, ...args) {
  let ai = 0;
  return String(fmt).replace(/%([-+ 0#]*)(\d+|\*)?(?:\.(\d+))?([diufFeEgGxXosc%])/g, (m, flags, width, prec, conv) => {
    if (conv === "%") return "%";
    if (width === "*") width = args[ai++];
    let v = args[ai++];
    let s;
    switch (conv) {
      case "d": case "i": case "u": {
        const x = Math.trunc(Number(v) || 0);
        s = String(Math.abs(x));
        if (prec !== undefined) s = s.padStart(+prec, "0");
        s = (x < 0 ? "-" : flags.includes("+") ? "+" : flags.includes(" ") ? " " : "") + s;
        break;
      }
      case "f": case "F": {
        const x = Number(v) || 0;
        s = x.toFixed(prec === undefined ? 6 : +prec);
        if (x >= 0 && flags.includes("+")) s = "+" + s;
        break;
      }
      case "e": case "E": s = (Number(v) || 0).toExponential(prec === undefined ? 6 : +prec); break;
      case "g": case "G": s = String(Number((Number(v) || 0).toPrecision(prec === undefined ? 6 : +prec || 1))); break;
      case "x": s = (Math.trunc(Number(v)) >>> 0).toString(16); break;
      case "X": s = (Math.trunc(Number(v)) >>> 0).toString(16).toUpperCase(); break;
      case "o": s = (Math.trunc(Number(v)) >>> 0).toString(8); break;
      case "c": s = String.fromCharCode(Number(v) || 32); break;
      default: s = v === null || v === undefined ? "nil" : String(v);
    }
    if (conv === "s" && prec !== undefined) s = s.slice(0, +prec);
    if (width !== undefined && s.length < +width) {
      if (flags.includes("-")) s = s.padEnd(+width);
      else if (flags.includes("0") && conv !== "s") {
        const sign = /^[+-]/.test(s) ? s[0] : "";
        s = sign + s.slice(sign.length).padStart(+width - sign.length, "0");
      } else s = s.padStart(+width);
    }
    return s;
  });
}

const absolute = (p) => {
  p = String(p);
  return p.startsWith("/") ? p : "/" + p;
};

/**
 * props: PropertyTree; opts: {namespaces: {name: object}, popupTip(msg)}.
 * Timers run on simulation time: call update(dt) every frame.
 */
export class NasalRuntime {
  constructor(props, { namespaces = {}, popupTip = () => {}, fgcommand = () => {} } = {}) {
    this.props = props;
    this.timers = [];
    this.cache = new Map();
    this.warned = new Set();
    const rt = this;

    const getprop = (...parts) => {
      const path = absolute(parts.join("/"));
      const jsb = props.jsb;
      const h = jsb.handle(path, false);
      if (h < 0) return null;
      const type = jsb.propType(h);
      if (type === 4) return jsb.getString(h);
      if (type === 0) return null;
      return jsb.get(h);
    };
    const setprop = (...parts) => {
      const v = parts.pop();
      props.set(absolute(parts.join("/")), typeof v === "string" && v !== "" && !isNaN(+v) ? +v : v);
    };
    const makeTimer = (interval, fn) => {
      const t = {
        singleShot: 0, _left: -1, _interval: interval, _fn: fn,
        start() { this._left = this._interval; if (!rt.timers.includes(this)) rt.timers.push(this); },
        stop() { this._left = -1; rt.timers = rt.timers.filter((x) => x !== this); },
        restart(iv) { this._interval = iv; this.start(); },
      };
      Object.defineProperty(t, "isRunning", { get() { return this._left >= 0; } });
      return t;
    };

    const nodeWrapper = (path) => ({
      getName: () => path.split("/").pop().replace(/\[\d+\]$/, ""),
      getPath: () => path,
      getValue: () => getprop(path),
      getBoolValue: () => !!getprop(path),
      getIntValue: () => Math.trunc(getprop(path) || 0),
      getDoubleValue: () => Number(getprop(path)) || 0,
      setValue: (v) => setprop(path, v),
      setBoolValue: (v) => props.set(path, !!v),
      setIntValue: (v) => props.set(path, Math.trunc(v)),
      setDoubleValue: (v) => props.set(path, +v),
      getNode: (rel) => nodeWrapper((path + "/" + rel).replace(/\/+/g, "/")),
    });

    this.env = {
      getprop,
      setprop,
      interpolate: (path, ...pairs) => {
        const p = typeof path === "string" ? absolute(path) : path.getPath();
        for (let i = 0; i + 1 < pairs.length; i += 2) interpolateProperty(props, p, +pairs[i], +pairs[i + 1]);
      },
      settimer: (fn, sec) => {
        const t = makeTimer(sec, fn);
        t.singleShot = 1;
        t.start();
      },
      maketimer: (sec, a, b) => {
        const t = makeTimer(sec, b ? () => b.call(a) : a);
        return t;
      },
      sprintf,
      print: (...a) => console.log("[nasal]", ...a),
      printf: (fmt, ...a) => console.log("[nasal]", sprintf(fmt, ...a)),
      size: (x) => (x === null || x === undefined ? 0 : typeof x === "object" && !Array.isArray(x) ? Object.keys(x).length : x.length),
      num: (x) => { const v = Number(x); return Number.isFinite(v) ? v : null; },
      int: (x) => Math.trunc(Number(x)),
      abs: Math.abs,
      substr: (s, a, l) => String(s).substr(a, l),
      find: (needle, hay) => String(hay).indexOf(needle),
      split: (sep, s) => String(s).split(sep),
      typeof: (x) => (x === null || x === undefined ? "nil" : typeof x === "number" ? "scalar" : typeof x === "string" ? "scalar" : typeof x === "function" ? "func" : Array.isArray(x) ? "vector" : "hash"),
      contains: (h, k) => h !== null && typeof h === "object" && k in h,
      keys: (h) => Object.keys(h ?? {}),
      die: (msg) => { throw new Error(msg); },
      cmdarg: () => nodeWrapper("/sim/nasal-cmdarg"),
      fgcommand: (name, node) => fgcommand(name, node),
      __keys: (v) => (Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v ?? {})),
      math: {
        floor: Math.floor, ceil: Math.ceil, round: Math.round, abs: Math.abs, sqrt: Math.sqrt,
        sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan2: Math.atan2,
        exp: Math.exp, ln: Math.log, log10: Math.log10, pow: Math.pow, pi: Math.PI, e: Math.E,
        mod: (a, b) => a - b * Math.floor(a / b), clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
        min: Math.min, max: Math.max, fmod: (a, b) => a % b, trunc: Math.trunc,
      },
      std: { max: Math.max, min: Math.min },
      props: { globals: nodeWrapper("") , Node: { new: (h) => h } },
      gui: {
        popupTip: (msg) => popupTip(String(msg)),
        showDialog: () => {},
        showHelpDialog: () => {},
        showWeightDialog: () => {},
        property_browser: () => {},
      },
      ...namespaces,
    };
  }

  /** Compiles a snippet into fn(...args) (the Nasal `arg` vector). */
  compile(source) {
    let fn = this.cache.get(source);
    if (fn) return fn;
    try {
      const js = translate(source);
      // eslint-disable-next-line no-new-func
      const factory = new Function("env", `with (env) { return function(...arg) {\n${js}\n}; }`);
      fn = factory(this.env);
    } catch (err) {
      this.warnOnce(source, err);
      fn = () => null;
    }
    const safe = (...args) => {
      try {
        return fn(...args);
      } catch (err) {
        this.warnOnce(source, err);
        return null;
      }
    };
    this.cache.set(source, safe);
    return safe;
  }

  warnOnce(source, err) {
    const key = source.slice(0, 200);
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn("Nasal:", err.message, "\n", source.trim().slice(0, 300));
  }

  /** readBinding hook: a <binding><command>nasal</command><script>... node. */
  binding(node) {
    const src = node.getStringValue("script", "");
    if (!src.trim()) return () => {};
    const fn = this.compile(src);
    return () => fn();
  }

  run(source, ...args) {
    return this.compile(source)(...args);
  }

  /** Advances settimer/maketimer timers by dt seconds of simulation time. */
  update(dt) {
    if (!this.timers.length) return;
    for (const t of [...this.timers]) {
      if (t._left < 0) continue;
      t._left -= dt;
      if (t._left > 0) continue;
      if (t.singleShot) t.stop();
      else t._left += Math.max(t._interval, 1e-3);
      try {
        t._fn();
      } catch (err) {
        console.warn("Nasal timer:", err.message);
      }
    }
  }

  reset() {
    this.timers = [];
  }
}
