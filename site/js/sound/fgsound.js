// FlightGear's aircraft sound system (SimGear sound/xmlsound.cxx) on the
// Web Audio API.
//
// Each <fx> entry of the aircraft's sound XML plays a sample when its
// condition (or property) holds: looped, once, or "in-transit" (while a
// property keeps changing).  Volume and pitch are products of property
// terms with factor, offset, min, max and log/ln/sqrt/inv/abs functions,
// computed exactly as SGXmlSound does.  Distance attenuation follows
// OpenAL's inverse-distance-clamped model with each sound's reference and
// maximum distance, so the engine fades out in the external views.

import { ConfigNode } from "../props/config.js";
import { absPath, readCondition, readExpression } from "../props/sgexpr.js";

const FUNCTIONS = {
  inv: (v) => (v === 0 ? 1e99 : 1 / v),
  abs: (v) => Math.abs(v),
  sqrt: (v) => Math.sqrt(Math.abs(v)),
  log: (v) => Math.log10(Math.abs(v) + 1e-9),
  ln: (v) => Math.log(Math.abs(v) + 1e-9),
};
const MAX_TRANSIT_TIME = 0.1;

class Sample {
  constructor(mgr, file) {
    this.mgr = mgr;
    this.file = file;
    this.source = null;
    this.playing = false;
    this.gain = mgr.ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(mgr.master);
    this.volume = 0;
    this.pitch = 1;
  }

  start(loop) {
    const buffer = this.mgr.buffers.get(this.file);
    if (!(buffer instanceof AudioBuffer)) return; // still loading: try again later
    this.stop();
    const src = this.mgr.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = loop;
    src.playbackRate.value = Math.max(0.01, this.pitch);
    src.connect(this.gain);
    src.onended = () => {
      if (this.source === src) {
        this.playing = false;
        this.source = null;
      }
    };
    src.start();
    this.source = src;
    this.playing = true;
  }

  stop() {
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        // already stopped
      }
      this.source.disconnect();
    }
    this.source = null;
    this.playing = false;
  }

  apply(volume, pitch, attenuation) {
    this.volume = volume;
    this.pitch = pitch;
    const t = this.mgr.ctx.currentTime;
    this.gain.gain.setTargetAtTime(Math.max(0, volume) * attenuation, t, 0.02);
    if (this.source) this.source.playbackRate.setTargetAtTime(Math.max(0.01, pitch), t, 0.02);
  }
}

class XmlSound {
  constructor(mgr, cfg) {
    const props = mgr.props;
    this.name = cfg.getStringValue("name", "");
    const mode = cfg.getStringValue("mode", "").trim();
    this.mode = mode === "looped" || mode === "in-transit" ? mode : "once";
    const cond = cfg.getChild("condition");
    this.condition = cond ? readCondition(props, cond, "/") : null;
    const pp = cfg.getStringValue("property", "").trim();
    this.property = pp ? props.node(absPath(pp, "/")) : null;
    this.delay = cfg.getDoubleValue("delay-sec", 0);
    this.refDist = cfg.getDoubleValue("reference-dist", 500);
    this.maxDist = cfg.getDoubleValue("max-dist", 3000);
    this.volumeTerms = cfg.getChildren("volume").map((n) => this.readTerm(props, n, 0));
    this.pitchTerms = cfg.getChildren("pitch").map((n) => this.readTerm(props, n, 1));
    this.sample = new Sample(mgr, mgr.files[cfg.getStringValue("path", "").trim()]);
    this.active = false;
    this.dtPlay = 0;
    this.dtStop = 0;
    this.stopping = 0;
    this.prev = null;
  }

  readTerm(props, n, defOffset) {
    const ex = n.getChild("expression");
    const pp = n.getStringValue("property", "").trim();
    let factor = n.getDoubleValue("factor", 1);
    const subtract = factor < 0;
    factor = Math.abs(factor);
    const type = n.getStringValue("type", "").trim();
    return {
      expr: ex?.children?.length ? readExpression(props, ex.children[0], "/") : null,
      prop: pp ? props.node(absPath(pp, "/")) : null,
      intern: n.getStringValue("internal", "").trim(),
      factor,
      subtract,
      fn: FUNCTIONS[type] ?? null,
      offset: n.getDoubleValue("offset", defOffset),
      min: Math.max(0, n.getDoubleValue("min", 0)),
      max: n.getDoubleValue("max", 0),
    };
  }

  termValue(t) {
    let v = 1;
    if (t.prop) v = t.prop.get();
    else if (t.intern === "dt_play") v = this.dtPlay;
    else if (t.intern === "dt_stop") v = this.dtStop;
    if (t.fn) v = t.fn(v);
    v *= t.factor;
    if (t.max && v > t.max) v = t.max;
    else if (v < t.min) v = t.min;
    return v;
  }

  /** SGXmlSound::volume() */
  volume() {
    let volume = 1;
    let offset = 0;
    let expr = false;
    for (const t of this.volumeTerms) {
      if (t.expr) {
        const e = t.expr();
        if (e >= 0) volume *= e;
        expr = true;
        continue;
      }
      if (t.prop && expr) continue;
      let v = this.termValue(t);
      if (t.subtract) {
        v += t.offset;
        if (v >= 0) volume *= v;
      } else if (v >= 0) {
        offset += t.offset;
        volume *= v;
      }
    }
    return Math.min(1, offset + volume);
  }

  /** SGXmlSound::pitch() */
  pitch() {
    let pitch = 1;
    let offset = 0;
    let expr = false;
    for (const t of this.pitchTerms) {
      if (t.expr) {
        pitch *= t.expr();
        expr = true;
        continue;
      }
      if (t.prop && expr) continue;
      const p = this.termValue(t);
      if (t.subtract) pitch = t.offset - p;
      else {
        offset += t.offset;
        pitch *= p;
      }
    }
    return offset + pitch;
  }

  /** SGXmlSound::update(); distance is from the listener to the aircraft. */
  update(dt, distance) {
    const s = this.sample;
    let condition = false;
    if (this.condition) condition = this.condition();
    else if (this.property) {
      if (this.mode === "in-transit") {
        const cur = this.property.get();
        condition = this.prev !== null && cur !== this.prev;
        this.prev = cur;
      } else {
        condition = this.property.getBool();
      }
    }
    if (!condition) {
      if (this.mode !== "in-transit" || this.stopping > MAX_TRANSIT_TIME) {
        if (s.playing) s.stop();
        this.active = false;
        this.dtStop += dt;
        this.dtPlay = 0;
      } else {
        this.stopping += dt;
      }
      return;
    }
    const outOfRange = distance > this.maxDist;
    if (outOfRange && s.playing) s.stop();
    if (this.active && this.mode === "once") {
      if (!s.playing) {
        this.dtStop += dt;
        this.dtPlay = 0;
      } else {
        this.dtPlay += dt;
      }
    } else {
      this.dtPlay += dt;
      this.stopping = 0;
    }
    if (this.dtPlay < this.delay) return;
    if (!this.active) {
      if (!outOfRange) s.start(this.mode !== "once");
      this.active = s.playing || this.mode !== "once";
      this.dtStop = 0;
    }
    if (!s.playing && this.mode !== "once" && !outOfRange) s.start(true);
    if (s.playing) {
      // OpenAL AL_INVERSE_DISTANCE_CLAMPED with a roll-off factor of 1.
      const d = Math.min(Math.max(distance, this.refDist), this.maxDist);
      const att = this.refDist / (this.refDist + (d - this.refDist));
      s.apply(this.volume(), this.pitch(), att);
    }
  }
}

export class SoundSystem {
  /** baseUrl: directory with sound.json (tools/build_sound.py). */
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.ctx = null;
    this.sounds = [];
    this.buffers = new Map();
    this.muted = false;
    this.volume = 0.8;
  }

  async load() {
    const res = await fetch(`${this.baseUrl}/sound.json`);
    const data = await res.json();
    this.config = ConfigNode.from(data.config);
    this.files = data.files;
  }

  /** Call from a user gesture: browsers only start audio after one. */
  unlock() {
    if (!this.config) return;
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
      for (const file of new Set(Object.values(this.files))) {
        this.buffers.set(file, fetch(`${this.baseUrl}/${file}`)
          .then((r) => r.arrayBuffer())
          .then((b) => this.ctx.decodeAudioData(b))
          .then((buf) => { this.buffers.set(file, buf); })
          .catch((err) => console.warn("sound", file, err.message)));
      }
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  /** (Re)binds the sounds to the property tree after a simulation start. */
  attach(props) {
    this.props = props;
    for (const s of this.sounds) s.sample.stop();
    this.sounds = [];
    if (!this.ctx) return;
    const fx = this.config.getChild("fx");
    for (const n of fx?.children ?? []) {
      try {
        this.sounds.push(new XmlSound(this, n));
      } catch (err) {
        console.warn("sound", n.name, err.message);
      }
    }
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  /** Pauses everything (sim paused or menu open). */
  suspend(on) {
    if (!this.ctx) return;
    if (on && this.ctx.state === "running") this.ctx.suspend();
    else if (!on && this.ctx.state === "suspended") this.ctx.resume();
  }

  update(dt, distance) {
    if (!this.ctx || !this.props) return;
    if (!this.sounds.length) this.attach(this.props);
    for (const s of this.sounds) s.update(dt, distance);
  }
}
