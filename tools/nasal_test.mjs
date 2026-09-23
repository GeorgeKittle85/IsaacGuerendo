// Tests for the Nasal snippet translator (site/js/nasal/nasal.js) against
// the real property tree (JSBSim WebAssembly + the c172p).
//
// Usage: node tools/nasal_test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import createJSBSim from "../site/wasm/jsbsim.mjs";
import { JSBSim } from "../site/js/fdm/jsbsim.js";
import { Simulation } from "../site/js/sim.js";
import { NasalRuntime, sprintf, translate } from "../site/js/nasal/nasal.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const data = (p) => JSON.parse(readFileSync(path.join(here, "../site/data", p), "utf8"));

const jsb = await JSBSim.load(createJSBSim, { printErr: () => {} });
jsb.setGroundProvider(() => ({ elev: 4.0, nE: 0, nN: 0, nU: 1 }));
const sim = new Simulation(jsb, {
  fdm: data("fdm/c172p.json"),
  props: data("aircraft/c172p/props.json"),
  rules: data("aircraft/c172p/rules.json"),
});
sim.start({ lat: 37.6117, lon: -122.3583, headingDeg: 298, onGround: true, running: false });
const p = sim.props;
const tips = [];
const clicks = [];
const rt = new NasalRuntime(p, {
  popupTip: (m) => tips.push(m),
  namespaces: { c172p: { click: (n) => clicks.push(n) } },
});

let failures = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}: ${err.message}`);
  }
};

test("translate keywords", () => {
  const js = translate(`var m = arg[0]; if (m == nil or m == 1) return "a" ~ "b"; elsif (m and 1) return me;`);
  assert.match(js, /else if/);
  assert.match(js, /\|\|/);
  assert.match(js, /&&/);
  assert.match(js, /null/);
  assert.match(js, /"a" \+ "" \+ "b"/);
});

test("tooltip mapping script", () => {
  const f = rt.compile(`var m = arg[0];\n if (m == -1) return 'SPEAKER';\n if (m == 1) return 'HEADSET';\n return 'OFF';`);
  assert.equal(f(-1), "SPEAKER");
  assert.equal(f(1), "HEADSET");
  assert.equal(f(0), "OFF");
});

test("master switch logic (getprop/setprop, namespaces)", () => {
  p.set("/controls/switches/master-bat", false);
  p.set("/controls/switches/master-alt", true);
  rt.run(`var master_state = getprop("/controls/switches/master-bat");
          if (!master_state) setprop("/controls/switches/master-alt", 0);
          c172p.click("master");`);
  assert.equal(p.get("/controls/switches/master-alt"), 0);
  assert.deepEqual(clicks, ["master"]);
});

test("maketimer runs on simulation time", () => {
  rt.run(`setprop("instrumentation/heading-indicator/caged-flag", 1);
          var t = maketimer(1.0, func { setprop("instrumentation/heading-indicator/caged-flag", 0); });
          t.singleShot = 1;
          t.start();`);
  assert.equal(p.get("/instrumentation/heading-indicator/caged-flag"), 1);
  rt.update(0.5);
  assert.equal(p.get("/instrumentation/heading-indicator/caged-flag"), 1);
  rt.update(0.6);
  assert.equal(p.get("/instrumentation/heading-indicator/caged-flag"), 0);
  assert.equal(rt.timers.length, 0);
});

test("foreach / forindex", () => {
  assert.equal(rt.run(`var t = 0; foreach (var x; [1, 2, 3]) { t += x; } forindex (var i; [5, 6]) t += i; return t;`), 7);
});

test("gui.popupTip", () => {
  rt.run(`gui.popupTip("You can't refuel while in the air!", 2);`);
  assert.deepEqual(tips, ["You can't refuel while in the air!"]);
});

test("props.globals nodes", () => {
  assert.equal(rt.run(`var n = props.globals.getNode("/sim/test/value", 1); n.setValue(4); return getprop("/sim/test/value") * 2;`), 8);
});

test("sprintf", () => {
  assert.equal(sprintf("%04d|%5.1f|%-4s|%+d|%x|%%", 7, 3.14159, "ab", 5, 255), "0007|  3.1|ab  |+5|ff|%");
  assert.equal(sprintf("%3d", 50.1), " 50");
});

test("broken scripts do not throw", () => {
  assert.equal(rt.run(`this is not nasal ((`), null);
});

if (failures) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all Nasal tests passed");
