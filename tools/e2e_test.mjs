// End-to-end browser test: serves site/, opens it in headless Chromium, starts
// on KSFO runway 28R, flies a takeoff through the page's test hook and checks
// the climb, then saves screenshots of the cockpit and chase views.
//
// With --gate, it starts at that KSFO gate instead and works the ground
// side: the ATC menu (' key), a pushback by the tug, and Ground's taxi
// clearance with the route drawn on the ground.
//
// Usage:
//   npm install            (playwright-core)
//   node tools/e2e_test.mjs [--aircraft c172p|f16|747] [--gate D55] [--out build/e2e] [--chromium /path/to/chrome]
//
// Without a GPU, Chromium renders with SwiftShader: it is slow but works.

import http from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../site");
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
};
const outDir = arg("--out", path.join(here, "../build/e2e"));
const executablePath = arg("--chromium", process.env.CHROMIUM || undefined);
const aircraft = arg("--aircraft", "c172p");
const gate = arg("--gate", null);
// Takeoff: rotate speed and climb attitude, and the climb speeds to expect.
const TAKEOFF = {
  c172p: { rotateKt: 55, pitch: 8, gain: 0.06, ias: [60, 100], restAgl: 10 },
  f16: { rotateKt: 150, pitch: 12, gain: 0.08, ias: [150, 500], gearUp: true, restAgl: 10 },
  // The 747's reference point is mid-fuselage, 19 ft above the runway.
  747: { rotateKt: 150, pitch: 10, gain: 0.1, ias: [140, 260], gearUp: true, restAgl: 25 },
}[aircraft];
if (!TAKEOFF) throw new Error(`unknown aircraft ${aircraft}`);
mkdirSync(outDir, { recursive: true });

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm", ".webp": "image/webp", ".png": "image/png",
  ".gz": "application/gzip", ".glb": "model/gltf-binary", ".wav": "audio/wav",
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

let ok = true;
const check = (cond, msg) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) ok = false;
};

/** At a gate: ATC menu, pushback, taxi clearance. */
async function gateScenario() {
  const t0 = Date.now();
  await page.goto(`${base}/?autostart&aircraft=${aircraft}&airport=KSFO&runway=28R&position=gate&gate=${encodeURIComponent(gate)}&time=afternoon&wind=280@8&range=15`);
  await page.waitForFunction(() => window.__fg?.flying === true, null, { timeout: 300000, polling: 500 });
  check(true, `simulator running after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const at = await page.evaluate(() => ({ phase: window.__fg.atc.phase, park: window.__fg.atc.parking?.name,
    park0: window.__fg.sim.props.get("/controls/gear/brake-parking") }));
  check(at.phase === "parked" && at.park === gate && at.park0 === 1, `parked at gate ${at.park}, parking brake set`);
  await page.keyboard.press("'");
  const menu = await page.evaluate(() => [...document.querySelectorAll("#atc-menu button")].map((b) => b.textContent));
  check(/Request pushback/.test(menu[0] ?? ""), `ATC menu: ${menu.join(" | ")}`);
  await page.keyboard.press("Digit1");
  await page.waitForFunction(() => ["connected", "pushing"].includes(window.__fg.atc.pushback.state), null, { timeout: 120000, polling: 500 });
  const start = await page.evaluate(() => [window.__fg.sim.props.get("/position/latitude-deg"), window.__fg.sim.props.get("/position/longitude-deg"), window.__fg.sim.props.get("/orientation/heading-deg")]);
  await page.keyboard.press("B"); // release the parking brake: the tug pushes
  await page.evaluate(() => { window.__fg.speedUp = 2; });
  let moved = 0, back = false;
  const t1 = Date.now();
  while (Date.now() - t1 < 300000 && moved < 8) {
    await page.waitForTimeout(3000);
    const now = await page.evaluate(() => [window.__fg.sim.props.get("/position/latitude-deg"), window.__fg.sim.props.get("/position/longitude-deg")]);
    const dn = (now[0] - start[0]) * 111195, de = (now[1] - start[1]) * 111195 * Math.cos((start[0] * Math.PI) / 180);
    moved = Math.hypot(dn, de);
    // Moving backwards: against the heading the aircraft started with.
    back = dn * Math.cos((start[2] * Math.PI) / 180) + de * Math.sin((start[2] * Math.PI) / 180) < 0;
  }
  check(moved >= 8 && back, `the tug pushed the aircraft back ${moved.toFixed(1)} m`);
  await page.evaluate(() => window.__fg.setView(1));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(outDir, `${aircraft}-pushback.png`) });
  // Stop the push where it is, set the brake, and ask for taxi.
  await page.evaluate(() => window.__fg.atc.pushback.cancel());
  await page.keyboard.press("B");
  await page.waitForFunction(() => window.__fg.atc.phase === "ready", null, { timeout: 300000, polling: 1000 });
  await page.keyboard.press("'");
  await page.keyboard.press("Digit1");
  await page.waitForFunction(() => document.getElementById("atc-next").textContent.length > 0, null, { timeout: 60000, polling: 500 });
  const taxi = await page.evaluate(() => ({
    phase: window.__fg.atc.phase, lines: window.__fg.routeView.group.children.length,
    log: [...document.querySelectorAll("#atc-log li")].map((l) => l.textContent), next: document.getElementById("atc-next").textContent,
  }));
  const clr = taxi.log.find((l) => /taxi via/.test(l) && /Ground/.test(l));
  check(taxi.phase === "taxi-out" && !!clr, `taxi clearance: ${clr}`);
  check(taxi.lines > 0 && taxi.next.length > 0, `route drawn on the ground; guidance: ${taxi.next}`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(outDir, `${aircraft}-taxi-route.png`) });
}

/** On runway 28R: a takeoff and climb. */
async function takeoffScenario() {
  const t0 = Date.now();
  await page.goto(`${base}/?autostart&aircraft=${aircraft}&airport=KSFO&runway=28R&time=afternoon&wind=280@8`);
  await page.waitForFunction(() => window.__fg?.flying === true, null, { timeout: 300000, polling: 500 });
  check(true, `simulator running after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const start = await page.evaluate(() => {
    const p = window.__fg.sim.props;
    return { agl: p.get("/position/altitude-agl-ft"), wow: p.getBool("/gear/gear[1]/wow"), park: p.get("/controls/gear/brake-parking") };
  });
  check(start.wow && start.agl < TAKEOFF.restAgl, `on the runway (AGL ${start.agl.toFixed(1)} ft)`);
  check(start.park === 1, "parking brake set at the start");
  check(await page.evaluate(() => window.__fg.def.id) === aircraft, `flying the ${aircraft}`);
  await page.screenshot({ path: path.join(outDir, `${aircraft}-cockpit-runway.png`) });

  // Take off: brake off, full power, rotate and hold the climb attitude.
  await page.evaluate((to) => {
    const a = window.__fg;
    const p = a.sim.props;
    a.speedUp = 4;
    p.set("/controls/gear/brake-parking", 0);
    a.controls.setThrottle(1);
    const hdg0 = p.get("/orientation/heading-deg");
    a.onFrame = () => {
      const g = (k) => p.get(k);
      if (g("/velocities/airspeed-kt") > to.rotateKt || g("/position/altitude-agl-ft") > 5) {
        p.set("/controls/flight/elevator", Math.max(-1, Math.min(1, -to.gain * (to.pitch - g("/orientation/pitch-deg")))));
      }
      if (to.gearUp && g("/position/altitude-agl-ft") > 60) a.controls.gearDown(-1);
      p.set("/controls/flight/aileron", Math.max(-1, Math.min(1, -0.03 * g("/orientation/roll-deg"))));
      const e = ((hdg0 - g("/orientation/heading-deg") + 540) % 360) - 180;
      p.set("/controls/flight/rudder", Math.max(-1, Math.min(1, 0.08 * e)));
    };
  }, TAKEOFF);
  let state = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 600000) {
    await page.waitForTimeout(3000);
    state = await page.evaluate(() => {
      const a = window.__fg;
      const g = (k) => a.sim.props.get(k);
      return {
        t: a.sim.elapsed, agl: g("/position/altitude-agl-ft"), ias: g("/instrumentation/airspeed-indicator/indicated-speed-kt"),
        vsi: g("/instrumentation/vertical-speed-indicator/indicated-speed-fpm"), crashed: a.sim.fdm.crashed, fps: a.hud.fps,
        gearDown: g("/controls/gear/gear-down"),
      };
    });
    console.log(`     t=${state.t.toFixed(0)}s agl=${state.agl.toFixed(0)}ft ias=${state.ias.toFixed(0)}kt vsi=${state.vsi.toFixed(0)}fpm fps=${state.fps}`);
    if (state.agl > 400 || state.crashed) break;
  }
  check(!state.crashed, "no crash");
  check(state.agl > 400, `climbed to ${state.agl.toFixed(0)} ft AGL`);
  check(state.ias > TAKEOFF.ias[0] && state.ias < TAKEOFF.ias[1], `climb speed ${state.ias.toFixed(0)} KIAS`);
  if (TAKEOFF.gearUp) check(state.gearDown === 0, "gear coming up");
  if (aircraft === "f16") {
    // glTF model: every animated bone must stay finite (a NaN hides the wheels).
    const bad = await page.evaluate(() => [...window.__fg.model.bones.values()]
      .filter((b) => ![...b.quaternion.toArray(), ...b.position.toArray()].every(Number.isFinite)).map((b) => b.name));
    check(bad.length === 0, `model bones finite${bad.length ? ": " + bad.join(", ") : ""}`);
    check(await page.evaluate(() => window.__fg.fighterHud.shown), "head-up display drawn in the cockpit view");
  }
  await page.evaluate(() => window.__fg.setView(2));
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(outDir, `${aircraft}-chase-climb.png`) });
}

try {
  if (gate) await gateScenario();
  else await takeoffScenario();
  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
} catch (err) {
  check(false, err.message);
} finally {
  await browser.close();
  server.close();
}
console.log(ok ? `PASS (screenshots in ${outDir})` : "FAILED");
process.exit(ok ? 0 : 1);
