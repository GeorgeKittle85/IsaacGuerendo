// Headless smoke test for the simulation core the website uses:
// JSBSim (WebAssembly) + FlightGear's c172p + property rules + instruments.
// Starts on a flat runway with the engine running, applies full power,
// rotates at 55 KIAS and holds a climb attitude.  Then the same for JSBSim's
// F-16: afterburner, rotate at 150 KIAS, gear up, and a cold engine start;
// and for FlightGear's 747-400: flaps 20, rotate at 150 KIAS, gear up, and
// a cold autostart of all four engines.
//
// Usage: node tools/fdm_smoke_test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import createJSBSim from "../site/wasm/jsbsim.mjs";
import { JSBSim } from "../site/js/fdm/jsbsim.js";
import { Simulation } from "../site/js/sim.js";
import { F16, F16_PROPS, F16_RULES } from "../site/js/aircraft/f16.js";
import { B744 } from "../site/js/aircraft/b744.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const data = (p) => JSON.parse(readFileSync(path.join(here, "../site/data", p), "utf8"));

const jsb = await JSBSim.load(createJSBSim, { printErr: (s) => process.env.VERBOSE && console.error(s) });
jsb.setGroundProvider(() => ({ elev: 4.0, nE: 0, nN: 0, nU: 1 }));
const sim = new Simulation(jsb, {
  fdm: data("fdm/c172p.json"),
  props: data("aircraft/c172p/props.json"),
  rules: data("aircraft/c172p/rules.json"),
});

const t0 = performance.now();
sim.start({ lat: 37.6117, lon: -122.3583, headingDeg: 298, onGround: true, running: true });
const props = sim.props;
console.log(`JSBSim ${jsb.version}: c172p ready in ${(performance.now() - t0).toFixed(0)} ms, ` +
  `${sim.rules.reduce((n, r) => n + r.components.length, 0)} rule components, ` +
  `${sim.instruments.items.length} systems/instruments`);

const g = (p) => props.get(p);
const log = (t) => console.log(
  `t=${t.toFixed(0).padStart(3)}s alt=${g("/position/altitude-ft").toFixed(0).padStart(5)}ft ` +
  `agl=${g("/position/altitude-agl-ft").toFixed(0).padStart(4)}ft ias=${g("/instrumentation/airspeed-indicator/indicated-speed-kt").toFixed(1).padStart(5)}kt ` +
  `rpm=${g("/engines/engine[0]/rpm").toFixed(0).padStart(4)} pitch=${g("/orientation/pitch-deg").toFixed(1).padStart(5)} ` +
  `hdg=${g("/orientation/heading-deg").toFixed(1)} alti=${g("/instrumentation/altimeter/indicated-altitude-ft").toFixed(0)} ` +
  `vsi=${g("/instrumentation/vertical-speed-indicator/indicated-speed-fpm").toFixed(0).padStart(5)}fpm ` +
  `HI=${g("/instrumentation/heading-indicator/indicated-heading-deg").toFixed(0)} ` +
  `volts=${g("/systems/electrical/volts").toFixed(1)} ` +
  `wow=${+props.getBool("/gear/gear[0]/wow")}${+props.getBool("/gear/gear[1]/wow")}${+props.getBool("/gear/gear[2]/wow")} ` +
  `fuel=${(g("/consumables/fuel/tank[0]/level-gal_us") + g("/consumables/fuel/tank[1]/level-gal_us")).toFixed(1)}gal`
);

props.set("/controls/engines/engine[0]/throttle", 1);
props.set("/controls/engines/engine[1]/throttle", 1);

const dt = 1 / 60;
const t1 = performance.now();
let maxAgl = 0;
for (let frame = 0; frame <= 60 * 90; frame++) {
  const t = frame * dt;
  if (g("/velocities/airspeed-kt") > 55 || g("/position/altitude-agl-ft") > 5) {
    const err = 8 - g("/orientation/pitch-deg");
    props.set("/controls/flight/elevator", Math.max(-1, Math.min(1, -0.06 * err)));
  }
  props.set("/controls/flight/aileron", Math.max(-1, Math.min(1, -0.03 * g("/orientation/roll-deg"))));
  const hdgErr = ((298 - g("/orientation/heading-deg") + 540) % 360) - 180;
  props.set("/controls/flight/rudder", Math.max(-1, Math.min(1, 0.08 * hdgErr)));
  if (frame % (60 * 10) === 0) log(t);
  sim.update(dt);
  maxAgl = Math.max(maxAgl, g("/position/altitude-agl-ft"));
}
const ms = performance.now() - t1;
console.log(`90 s simulated in ${ms.toFixed(0)} ms (${(ms / (60 * 90)).toFixed(2)} ms per 60 Hz frame)`);
if (sim.fdm.crashed) console.log("CRASHED");
if (maxAgl < 300) {
  console.error(`FAIL: expected to climb above 300 ft AGL, reached ${maxAgl.toFixed(0)} ft`);
  process.exit(1);
}
console.log(`PASS: climbed to ${maxAgl.toFixed(0)} ft AGL`);

// ------------------------------------------------------------------ F-16

const f16 = new Simulation(jsb, { fdm: data("fdm/f16.json"), props: F16_PROPS, rules: F16_RULES }, F16);
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
const q = (p) => f16.props.get(p);
const logF16 = (t) => console.log(
  `t=${t.toFixed(0).padStart(3)}s agl=${q("/position/altitude-agl-ft").toFixed(0).padStart(5)}ft ` +
  `ias=${q("/instrumentation/airspeed-indicator/indicated-speed-kt").toFixed(0).padStart(4)}kt ` +
  `mach=${q("/velocities/mach").toFixed(2)} n2=${q("/engines/engine[0]/n2").toFixed(0).padStart(3)}% ` +
  `ab=${+f16.props.getBool("/engines/engine[0]/augmentation")} thrust=${q("/engines/engine[0]/thrust_lb").toFixed(0).padStart(5)}lb ` +
  `pitch=${q("/orientation/pitch-deg").toFixed(1).padStart(5)} gear=${q("/gear/gear[0]/position-norm").toFixed(2)}`);

f16.start({ lat: 37.6117, lon: -122.3583, headingDeg: 298, onGround: true, running: true });
console.log(`F-16 ready: ${f16.fdm.turbine ? "turbine" : "no turbine"}, trim ${f16.fdm.trimmed ? "ok" : "failed"}`);
f16.props.set("/controls/engines/engine[0]/throttle", 1);
let maxAglF16 = 0;
for (let frame = 0; frame <= 60 * 40; frame++) {
  if (q("/velocities/airspeed-kt") > 150 || q("/position/altitude-agl-ft") > 10) {
    f16.props.set("/controls/flight/elevator", Math.max(-1, Math.min(1, -0.08 * (12 - q("/orientation/pitch-deg")))));
  }
  if (q("/position/altitude-agl-ft") > 100) f16.props.set("/controls/gear/gear-down", 0);
  f16.props.set("/controls/flight/aileron", Math.max(-1, Math.min(1, -0.03 * q("/orientation/roll-deg"))));
  if (frame % (60 * 10) === 0) logF16(frame / 60);
  f16.update(dt);
  maxAglF16 = Math.max(maxAglF16, q("/position/altitude-agl-ft"));
}
if (f16.fdm.crashed) fail("F-16 crashed");
if (maxAglF16 < 2000) fail(`F-16 expected above 2000 ft AGL, reached ${maxAglF16.toFixed(0)} ft`);
if (q("/gear/gear[0]/position-norm") > 0.01) fail("F-16 gear did not retract");
console.log(`PASS: F-16 climbed to ${maxAglF16.toFixed(0)} ft AGL with the gear up`);

f16.start({ lat: 37.6117, lon: -122.3583, headingDeg: 298, onGround: true, running: false });
console.log(f16.aircraft.autostart());
let startedAt = null;
for (let frame = 0; frame <= 60 * 60 && startedAt === null; frame++) {
  f16.update(dt);
  if (f16.props.getBool("/engines/engine[0]/running")) startedAt = frame / 60;
}
if (startedAt === null) fail("F-16 engine did not start");
logF16(startedAt);
console.log(`PASS: F-16 engine started in ${startedAt.toFixed(0)} s`);

// ------------------------------------------------------------------ 747-400

const b744 = new Simulation(jsb, {
  fdm: data("fdm/747-400.json"),
  props: data("aircraft/747-400/props.json"),
  rules: data("aircraft/747-400/rules.json"),
}, B744);
const r = (p) => b744.props.get(p);
const log744 = (t) => console.log(
  `t=${t.toFixed(0).padStart(3)}s agl=${r("/position/altitude-agl-ft").toFixed(0).padStart(5)}ft ` +
  `ias=${r("/instrumentation/airspeed-indicator/indicated-speed-kt").toFixed(0).padStart(4)}kt ` +
  `n1=${r("/engines/engine[0]/n1").toFixed(0).padStart(3)}% thrust=${(4 * r("/engines/engine[0]/thrust_lb")).toFixed(0).padStart(6)}lb ` +
  `flaps=${r("/surface-positions/flap-pos-norm").toFixed(2)} pitch=${r("/orientation/pitch-deg").toFixed(1).padStart(5)} ` +
  `hyd=${r("/systems/hydraulic/pressure[0]").toFixed(0)}psi gear=${r("/gear/gear[0]/position-norm").toFixed(2)}`);

b744.start({ lat: 37.6117, lon: -122.3583, headingDeg: 298, onGround: true, running: true, flaps: 0.667 });
console.log(`747-400 ready: ${b744.fdm.engines} engines (4 + APU), ${(r("inertia/weight-lbs") / 1000).toFixed(0)}k lb, ` +
  `trim ${b744.fdm.trimmed ? "ok" : "failed"}`);
for (let i = 0; i < 4; i++) b744.props.set(`/controls/engines/engine[${i}]/throttle`, 1);
let maxAgl744 = 0;
for (let frame = 0; frame <= 60 * 90; frame++) {
  if (r("/velocities/airspeed-kt") > 150 || r("/position/altitude-agl-ft") > 30) {
    b744.props.set("/controls/flight/elevator", Math.max(-1, Math.min(1, -0.1 * (10 - r("/orientation/pitch-deg")))));
  }
  if (r("/position/altitude-agl-ft") > 100) b744.props.set("/controls/gear/gear-down", 0);
  b744.props.set("/controls/flight/aileron", Math.max(-1, Math.min(1, -0.03 * r("/orientation/roll-deg"))));
  const hdgErr744 = ((298 - r("/orientation/heading-deg") + 540) % 360) - 180;
  b744.props.set("/controls/flight/rudder", Math.max(-1, Math.min(1, 0.08 * hdgErr744)));
  if (frame % (60 * 15) === 0) log744(frame / 60);
  b744.update(dt);
  maxAgl744 = Math.max(maxAgl744, r("/position/altitude-agl-ft"));
}
if (b744.fdm.crashed) fail("747 crashed");
if (maxAgl744 < 1000) fail(`747 expected above 1000 ft AGL, reached ${maxAgl744.toFixed(0)} ft`);
if (r("/gear/gear[0]/position-norm") > 0.5) fail("747 gear did not start retracting");
console.log(`PASS: 747-400 climbed to ${maxAgl744.toFixed(0)} ft AGL with the gear coming up`);

b744.start({ lat: 37.6117, lon: -122.3583, headingDeg: 298, onGround: true, running: false });
if (r("/systems/hydraulic/pressure[0]") > 0) fail("747 cold start with hydraulic pressure");
console.log(b744.aircraft.autostart());
let started744 = null;
for (let frame = 0; frame <= 60 * 120 && started744 === null; frame++) {
  b744.update(dt);
  if (b744.aircraft.running) started744 = frame / 60;
}
if (started744 === null) fail("747 engines did not start");
for (let frame = 0; frame < 60 * 3; frame++) b744.update(dt);
log744(started744);
if (r("/systems/hydraulic/pressure[0]") < 2500) fail("747 hydraulics not pressurised after the start");
console.log(`PASS: 747-400 engines started in ${started744.toFixed(0)} s`);
