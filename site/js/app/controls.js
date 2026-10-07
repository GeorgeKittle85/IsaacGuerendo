// Pilot controls: a port of FlightGear's Nasal/controls.nas (the functions
// its keyboard, mouse and joystick bindings call) with the c172p's overrides
// from Aircraft/c172p/Nasal/{c172p,engine}.nas.  The same object serves as
// the `controls` namespace for Nasal snippets in the aircraft's bindings.

import { interpolateProperty } from "../props/sgexpr.js";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const FULL_BRAKE_TIME = 0.5; // controls.fullBrakeTime

export class Controls {
  /** app: {sim, aircraft, message(text), frameDt} */
  constructor(app) {
    this.app = app;
  }

  get p() {
    return this.app.sim.props;
  }

  adjust(path, d, lo = -1, hi = 1) {
    const v = clamp(this.p.get(path) + d, lo, hi);
    this.p.set(path, v);
    return v;
  }

  // ------------------------------------------------------------- flight
  incElevator(d) { return this.adjust("/controls/flight/elevator", d); }
  incAileron(d) { return this.adjust("/controls/flight/aileron", d); }
  incRudder(d) { return this.adjust("/controls/flight/rudder", d); }

  centerFlightControls() {
    for (const s of ["elevator", "aileron", "rudder"]) this.p.set(`/controls/flight/${s}`, 0);
  }

  elevatorTrim(d) { return this.adjust("/controls/flight/elevator-trim", d); }
  aileronTrim(d) { return this.adjust("/controls/flight/aileron-trim", d); }
  rudderTrim(d) { return this.adjust("/controls/flight/rudder-trim", d); }

  clearTrims() {
    for (const s of ["elevator", "aileron", "rudder"]) this.p.set(`/controls/flight/${s}-trim`, 0);
  }

  /**
   * controls.flapsDown(): one detent of /sim/flaps/setting at a time (the
   * 747's 0, 1, 5, 10, 20, 25, 30), or FlightGear's hard-coded three equal
   * steps without one (the c172p's 0/10/20/30°).
   */
  flapsDown(step) {
    if (!step) return;
    const def = this.app.def;
    if (def?.autoFlaps) {
      this.app.message?.("The F-16's flaps are automatic (flaperons and leading edge flaps)");
      return;
    }
    if (def?.flaps) {
      const s = def.flaps.settings;
      const i = clamp(this.flapDetent() + Math.sign(step), 0, s.length - 1);
      this.p.set("/controls/flight/flaps", s[i]);
      this.app.message?.(`Flaps ${def.flaps.names[i]}`);
      return;
    }
    const v = clamp(0.3333334 * step + this.p.get("/controls/flight/flaps"), 0, 1);
    this.p.set("/controls/flight/flaps", v);
    this.app.message?.(`Flaps ${Math.round(v * 3) * 10}°`);
  }

  /** The detent of /sim/flaps/setting nearest the flap lever. */
  flapDetent() {
    const s = this.app.def.flaps.settings;
    const cur = this.p.get("/controls/flight/flaps");
    return s.reduce((best, v, k) => (Math.abs(v - cur) < Math.abs(s[best] - cur) ? k : best), 0);
  }

  /** The flap detent's name for the flight data strip ("20"), or null. */
  flapName() {
    return this.app.def?.flaps ? this.app.def.flaps.names[this.flapDetent()] : null;
  }

  /** controls.gearDown(): the gear does not come up with weight on the wheels. */
  gearDown(v) {
    if (!this.app.def?.retractableGear) return;
    const p = this.p;
    if (v < 0) {
      if ([0, 1, 2, 3, 4].some((i) => p.getBool(`/gear/gear[${i}]/wow`))) {
        this.app.message?.("Gear: weight on wheels, staying down");
        return;
      }
      p.set("/controls/gear/gear-down", 0);
      this.app.message?.("Gear up");
    } else if (v > 0) {
      p.set("/controls/gear/gear-down", 1);
      this.app.message?.("Gear down");
    }
  }

  toggleGear() {
    this.gearDown(this.p.getBool("/controls/gear/gear-down") ? -1 : 1);
  }

  /**
   * Speed brake: FlightGear's k/K steps and Ctrl+B toggle.  The F-16's opens
   * fully or not at all; the 747's lever has four positions (its Ctrl+B
   * binding cycles /autopilot/autospoilers/step: down, armed, flight
   * detent, up).
   */
  speedbrake(v) {
    const mode = this.app.def?.speedbrake;
    if (!mode) return;
    if (mode === "autospoilers") {
      const cur = this.p.get("/autopilot/autospoilers/step");
      const step = v === undefined ? (cur + 1) % 4 : clamp(cur + Math.sign(v), 0, 3);
      this.p.set("/autopilot/autospoilers/step", step);
      this.app.message?.(`Speedbrake lever: ${["DOWN", "ARMED", "FLIGHT DETENT", "UP"][step]}`);
      return;
    }
    const on = v === undefined ? this.p.get("/controls/flight/speedbrake") < 0.5 : v > 0;
    this.p.set("/controls/flight/speedbrake", on ? 1 : 0);
    this.app.message?.(`Speed brake ${on ? "out" : "in"}`);
  }

  /** Delete: thrust reversers (747). */
  toggleReversers() {
    const msg = this.app.aircraft?.toggleReversers?.();
    if (msg) this.app.message?.(msg);
  }

  toggleCanopy() {
    const msg = this.app.aircraft?.toggleCanopy?.();
    if (msg) this.app.message?.(msg);
  }

  // ------------------------------------------------------------- engine
  /** Throttles moved together (FlightGear's selected engines). */
  get throttles() {
    return this.app.def?.engines ?? 2;
  }

  incThrottle(d) {
    let v = 0;
    for (let i = 0; i < this.throttles; i++) v = this.adjust(`/controls/engines/engine[${i}]/throttle`, d, 0, 1);
    return v;
  }

  setThrottle(v) {
    for (let i = 0; i < this.throttles; i++) this.p.set(`/controls/engines/engine[${i}]/throttle`, clamp(v, 0, 1));
  }

  /** controls.adjMixture (c172p override): speed * THROTTLE_RATE * frame time. */
  adjMixture(speed) {
    this.app.aircraft.adjustMixture?.(speed, this.app.frameDt ?? 1 / 60);
  }

  setMixture(v) {
    this.p.set("/controls/engines/current-engine/mixture", clamp(v, 0, 1));
  }

  stepMagnetos(change) {
    if (!change || !this.app.aircraft.stepMagnetos) return;
    this.app.aircraft.stepMagnetos(change);
    const names = ["OFF", "RIGHT", "LEFT", "BOTH"];
    this.app.message?.(`Magnetos: ${names[this.p.get("/controls/switches/magnetos")] ?? "?"}`);
    this.app.nasal?.env.c172p?.click(change > 0 ? "magneto-forward" : "magneto-back");
  }

  startEngine(v = 1) {
    this.app.aircraft.setStarter(!!v);
  }

  // ------------------------------------------------------------- brakes
  /** c172p.nas override: no braking on a broken main gear leg. */
  applyBrakes(v, which = 0) {
    const p = this.p;
    if (which <= 0 && !p.getBool("/fdm/jsbsim/gear/unit[1]/broken")) {
      interpolateProperty(p, "/controls/gear/brake-left", v, FULL_BRAKE_TIME);
    }
    if (which >= 0 && !p.getBool("/fdm/jsbsim/gear/unit[2]/broken")) {
      interpolateProperty(p, "/controls/gear/brake-right", v, FULL_BRAKE_TIME);
    }
  }

  toggleParkingBrake() {
    const on = !this.p.getBool("/controls/gear/brake-parking");
    this.p.set("/controls/gear/brake-parking", on ? 1 : 0);
    this.app.message?.(`Parking brake ${on ? "ON" : "OFF"}`);
  }

  // ------------------------------------------------------------- sim
  speedup(dir) {
    let t = this.app.speedUp;
    t = dir < 0 ? (t > 1 / 32 ? t / 2 : 1 / 32) : t < 32 ? t * 2 : 32;
    this.app.speedUp = t;
    this.p.set("/sim/speed-up", t);
    this.app.message?.(`Time speed-up: ${t}`);
  }
}
