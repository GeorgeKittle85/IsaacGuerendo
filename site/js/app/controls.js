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

  /** Hard-coded flaps movement in 3 equal steps (the c172p has 0/10/20/30°). */
  flapsDown(step) {
    if (!step) return;
    const v = clamp(0.3333334 * step + this.p.get("/controls/flight/flaps"), 0, 1);
    this.p.set("/controls/flight/flaps", v);
    this.app.message?.(`Flaps ${Math.round(v * 3) * 10}°`);
  }

  // ------------------------------------------------------------- engine
  incThrottle(d) {
    let v = 0;
    for (let i = 0; i < 2; i++) v = this.adjust(`/controls/engines/engine[${i}]/throttle`, d, 0, 1);
    return v;
  }

  setThrottle(v) {
    for (let i = 0; i < 2; i++) this.p.set(`/controls/engines/engine[${i}]/throttle`, clamp(v, 0, 1));
  }

  /** controls.adjMixture (c172p override): speed * THROTTLE_RATE * frame time. */
  adjMixture(speed) {
    this.app.aircraft.adjustMixture(speed, this.app.frameDt ?? 1 / 60);
  }

  setMixture(v) {
    this.p.set("/controls/engines/current-engine/mixture", clamp(v, 0, 1));
  }

  stepMagnetos(change) {
    if (!change) return;
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
