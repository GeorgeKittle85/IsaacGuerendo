// FlightGear's autopilot / property-rule engine (src/Autopilot/*) in JS.
//
// Aircraft describe much of their logic as <filter>, <logic>, <flipflop>,
// <pid-controller> and <state-machine> components in PropertyList XML.  Each
// component is compiled once and then updated every frame in document order.

import {
  absPath, readCondition, readInputValue, readInputValueList, readBindings, normalizePeriod,
} from "../props/sgexpr.js";

class Component {
  constructor(props, cfg, base) {
    this.props = props;
    this.cfg = cfg;
    this.base = base;
    this.name = cfg.getStringValue("name", cfg.name);
    this.interval = cfg.getDoubleValue("update-interval-secs", 0);
    this.accum = 0;
    this.wasEnabled = false;
    const en = cfg.getChild("enable");
    if (en) {
      if (en.getChild("condition")) {
        this.enable = readCondition(props, en.getChild("condition"), base);
      } else {
        const p = en.getChild("property") ?? en.getChild("prop");
        if (p) {
          const path = absPath(p.getStringValue(), base);
          const val = en.getChild("value") ? en.getStringValue("value").trim() : null;
          this.enable = val === null ? () => props.getBool(path) : () => {
            const s = props.getString(path).trim();
            return s === val || (s !== "" && Number(s) === Number(val));
          };
        }
      }
    }
    this.outputs = readOutputs(props, cfg, base);
  }

  isEnabled() {
    return this.enable ? this.enable() : true;
  }

  update(dt) {
    if (this.interval > 0) {
      this.accum += dt;
      if (this.accum < this.interval) return;
      dt = this.accum;
      this.accum = 0;
    }
    const enabled = this.isEnabled();
    const first = enabled && !this.wasEnabled;
    this.wasEnabled = enabled;
    this.step(enabled, first, dt);
  }
}

function readOutputs(props, cfg, base) {
  const out = [];
  for (const o of cfg.getChildren("output")) {
    const inverted = o.getBoolValue("inverted", false);
    const ps = o.getChildren("property").concat(o.getChildren("prop"));
    if (ps.length) {
      for (const p of ps) out.push({ node: props.node(absPath(p.getStringValue(), base)), inverted });
    } else if (o.getStringValue().trim()) {
      out.push({ node: props.node(absPath(o.getStringValue(), base)), inverted });
    }
  }
  return out;
}

// ------------------------------------------------------------ analog / filter

class DigitalFilter extends Component {
  constructor(props, cfg, base) {
    super(props, cfg, base);
    this.type = cfg.getStringValue("type", "gain").trim();
    this.input = readInputValueList(props, cfg.getChildren("input"), base);
    this.reference = readInputValueList(props, cfg.getChildren("reference"), base);
    this.gain = readInputValueList(props, cfg.getChildren("gain"), base, 1);
    this.tf = readInputValueList(props, cfg.getChildren("filter-time"), base, 0);
    this.rate = readInputValueList(props, cfg.getChildren("max-rate-of-change"), base, 1);
    this.minRate = readInputValueList(props, cfg.getChildren("min-rate-of-change"), base, 0);
    this.samples = cfg.getIntValue("samples", 1);
    this.min = readInputValueList(props, cfg.getChildren("u_min").concat(cfg.getChildren("min")), base, -Infinity);
    this.max = readInputValueList(props, cfg.getChildren("u_max").concat(cfg.getChildren("max")), base, Infinity);
    const per = cfg.getChild("period");
    this.period = per ? { min: readInputValue(props, per.getChild("min"), base), max: readInputValue(props, per.getChild("max"), base) } : null;
    this.initializeTo = cfg.getStringValue("initialize-to", "input").trim(); // FG default
    this.out1 = 0;
    this.in1 = 0;
    this.buf = [];
  }

  outputValue() {
    return this.outputs.length ? this.outputs[0].node.get() : this.out1;
  }

  init(v) {
    this.out1 = v;
    this.in1 = v;
    this.buf = new Array(this.samples).fill(v);
  }

  step(enabled, first, dt) {
    if (!enabled) return;
    if (first) {
      if (this.initializeTo === "input") this.init(this.input.get());
      else if (this.initializeTo === "output") this.init(this.outputValue());
      else this.init(0);
    }
    const input = this.input.get() - (this.reference.empty ? 0 : this.reference.get());
    let out;
    switch (this.type) {
      case "gain":
        out = this.gain.get() * input;
        break;
      case "exponential": {
        const tf = this.tf.get();
        const alpha = tf > 0 && dt > 0 ? 1 / (tf / dt + 1) : 1;
        out = alpha * input + (1 - alpha) * this.out1;
        break;
      }
      case "double-exponential": {
        const tf = this.tf.get();
        const alpha = tf > 0 && dt > 0 ? 1 / (tf / dt + 1) : 1;
        this.mid = alpha * input + (1 - alpha) * (this.mid ?? this.out1);
        out = alpha * this.mid + (1 - alpha) * this.out1;
        break;
      }
      case "noise-spike":
      case "rate-limit": {
        let delta = input - this.out1;
        if (this.period) delta = symmetric(delta, this.period.min.get(), this.period.max.get());
        const up = this.rate.get() * dt;
        const down = (this.minRate.empty ? this.rate.get() : Math.abs(this.minRate.get())) * dt;
        if (delta > up) out = this.out1 + up;
        else if (delta < -down) out = this.out1 - down;
        else out = input;
        break;
      }
      case "moving-average": {
        this.buf.push(input);
        while (this.buf.length > Math.max(1, this.samples)) this.buf.shift();
        out = this.buf.reduce((a, b) => a + b, 0) / this.buf.length;
        break;
      }
      case "derivative":
        out = dt > 0 ? ((input - this.in1) * this.tf.get()) / dt : 0;
        break;
      case "integrator":
        out = this.out1 + input * dt * this.gain.get();
        break;
      case "reciprocal":
        out = input !== 0 ? this.gain.get() / input : this.out1;
        break;
      case "high-pass": {
        const tf = this.tf.get();
        const alpha = tf > 0 ? tf / (tf + dt) : 0;
        out = alpha * (this.out1 + input - this.in1);
        break;
      }
      default:
        out = input;
    }
    this.in1 = input;
    out = Math.min(this.max.get(), Math.max(this.min.get(), out));
    if (this.period) out = normalizePeriod(out, this.period.min.get(), this.period.max.get());
    this.out1 = out;
    for (const o of this.outputs) o.node.set(out);
  }
}

function symmetric(d, lo, hi) {
  const range = hi - lo;
  if (range <= 0) return d;
  d = ((d % range) + range) % range;
  return d > range / 2 ? d - range : d;
}

// --------------------------------------------------------------- PID family

class PIDController extends Component {
  constructor(props, cfg, base) {
    super(props, cfg, base);
    const c = cfg.getChild("config") ?? cfg;
    this.input = readInputValueList(props, cfg.getChildren("input"), base);
    this.reference = readInputValueList(props, cfg.getChildren("reference"), base);
    this.kp = readInputValueList(props, c.getChildren("Kp"), base, 0);
    this.ti = readInputValueList(props, c.getChildren("Ti"), base, 0);
    this.td = readInputValueList(props, c.getChildren("Td"), base, 0);
    this.ki = readInputValueList(props, c.getChildren("Ki"), base, 0);
    this.min = readInputValueList(props, c.getChildren("u_min").concat(c.getChildren("min")), base, -Infinity);
    this.max = readInputValueList(props, c.getChildren("u_max").concat(c.getChildren("max")), base, Infinity);
    this.simple = cfg.name === "pi-simple-controller";
    this.integral = 0;
    this.prevErr = 0;
  }

  step(enabled, first, dt) {
    if (!enabled || dt <= 0) {
      this.integral = 0;
      return;
    }
    const err = this.reference.get() - this.input.get();
    let u;
    if (this.simple) {
      this.integral += this.ki.get() * err * dt;
      u = this.kp.get() * err + this.integral;
    } else {
      const ti = this.ti.get();
      if (ti > 0) this.integral += (err * dt) / ti;
      const deriv = first ? 0 : (err - this.prevErr) / dt;
      u = this.kp.get() * (err + this.integral + this.td.get() * deriv);
    }
    const lo = this.min.get();
    const hi = this.max.get();
    if (u > hi || u < lo) {
      // simple anti-windup
      this.integral -= this.simple ? this.ki.get() * err * dt : this.ti.get() > 0 ? (err * dt) / this.ti.get() : 0;
      u = Math.min(hi, Math.max(lo, u));
    }
    this.prevErr = err;
    for (const o of this.outputs) o.node.set(u);
  }
}

// ------------------------------------------------------------- digital logic

class Logic extends Component {
  constructor(props, cfg, base) {
    super(props, cfg, base);
    this.input = readCondition(props, cfg.getChild("input"), base);
    this.inverted = cfg.getBoolValue("inverted", false);
  }

  step(enabled) {
    if (!enabled) return;
    let q = this.input();
    if (this.inverted) q = !q;
    for (const o of this.outputs) o.node.set(o.inverted ? !q : q);
  }
}

class FlipFlop extends Component {
  constructor(props, cfg, base) {
    super(props, cfg, base);
    const c = (n) => (cfg.getChild(n) ? readCondition(props, cfg.getChild(n), base) : null);
    this.type = cfg.getStringValue("type", "RS").trim().toUpperCase();
    this.S = c("S");
    this.R = c("R");
    this.J = c("J");
    this.K = c("K");
    this.D = c("D");
    this.clock = c("clock");
    this.time = cfg.getChild("time") ? readInputValue(props, cfg.getChild("time"), base) : { get: () => 0 };
    this.inverted = cfg.getBoolValue("inverted", false);
    this.q = false;
    this.lastClock = false;
    this.timer = 0;
  }

  step(enabled, first, dt) {
    if (!enabled) return;
    const s = this.S ? this.S() : false;
    const r = this.R ? this.R() : false;
    const clk = this.clock ? this.clock() : true;
    const rising = clk && !this.lastClock;
    this.lastClock = clk;
    switch (this.type) {
      case "SR": if (s) this.q = true; else if (r) this.q = false; break;
      case "JK": if (rising) { const j = this.J?.() ?? false, k = this.K?.() ?? false; this.q = j && k ? !this.q : j ? true : k ? false : this.q; } break;
      case "D": if (rising) this.q = this.D?.() ?? this.q; break;
      case "T": if (rising) this.q = !this.q; break;
      case "MONOSTABLE":
        if (s && !this.q) { this.q = true; this.timer = 0; }
        if (this.q) { this.timer += dt; if (this.timer >= this.time.get() || r) this.q = false; }
        break;
      default: if (r) this.q = false; else if (s) this.q = true; // RS: reset dominates
    }
    const q = this.inverted ? !this.q : this.q;
    for (const o of this.outputs) o.node.set(o.inverted ? !q : q);
  }
}

// ------------------------------------------------------------- state machine

class StateMachine extends Component {
  constructor(props, cfg, base) {
    super(props, cfg, base);
    this.branch = absPath(cfg.getStringValue("branch", `/autopilot/fsm/${this.name}`), base);
    this.states = cfg.getChildren("state").map((s) => ({
      name: s.getStringValue("name").trim(),
      enter: readBindings(props, s.getChildren("enter"), base),
      exit: readBindings(props, s.getChildren("exit"), base),
      update: readBindings(props, s.getChildren("update"), base),
    }));
    this.transitions = cfg.getChildren("transition").map((t) => ({
      sources: t.getChildren("source").map((s) => s.getStringValue().trim()),
      target: t.getStringValue("target").trim(),
      cond: readCondition(props, t.getChild("condition"), base),
      bindings: readBindings(props, t.getChildren("binding"), base),
      excludeTarget: t.getBoolValue("exclude-target", true),
    }));
    this.current = null;
  }

  enter(state) {
    if (this.current) this.current.exit();
    this.current = state;
    this.props.set(`${this.branch}/current-name`, state.name);
    this.props.set(`${this.branch}/current-index`, this.states.indexOf(state));
    state.enter();
  }

  step(enabled) {
    if (!enabled || this.states.length === 0) return;
    if (!this.current) {
      this.enter(this.states[0]);
      return;
    }
    for (const t of this.transitions) {
      if (t.sources.length && !t.sources.includes(this.current.name)) continue;
      if (t.excludeTarget && t.target === this.current.name) continue;
      if (!t.cond()) continue;
      const target = this.states.find((s) => s.name === t.target);
      if (!target) continue;
      t.bindings();
      this.enter(target);
      return;
    }
    this.current.update();
  }
}

const FACTORY = {
  filter: DigitalFilter,
  "pid-controller": PIDController,
  "pi-simple-controller": PIDController,
  logic: Logic,
  flipflop: FlipFlop,
  "state-machine": StateMachine,
};

/** One <autopilot>/<property-rule> file: its components in document order. */
export class PropertyRuleGroup {
  constructor(props, cfg, base = "/", name = "") {
    this.name = name;
    this.components = [];
    this.errors = [];
    for (const c of cfg.children) {
      const Ctor = FACTORY[c.name];
      if (!Ctor) continue; // <params>, <switch> and friends are data, not components
      try {
        this.components.push(new Ctor(props, c, base));
      } catch (err) {
        this.errors.push(`${name}: ${c.name} ${c.getStringValue("name")}: ${err.message}`);
      }
    }
  }

  update(dt) {
    for (const c of this.components) c.update(dt);
  }
}
