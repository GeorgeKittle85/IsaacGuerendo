// Headless smoke test for the simulation core the website uses:
// JSBSim (WebAssembly) + FlightGear's c172p + property rules + instruments.
// Starts on a flat runway with the engine running, applies full power,
// rotates at 55 KIAS and holds a climb attitude.
//
// Usage: node tools/fdm_smoke_test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import createJSBSim from "../site/wasm/jsbsim.mjs";
import { JSBSim } from "../site/js/fdm/jsbsim.js";
import { Simulation } from "../site/js/sim.js";

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
