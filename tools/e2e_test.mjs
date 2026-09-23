// End-to-end browser test: serves site/, opens it in headless Chromium, starts
// on KSFO runway 28R, flies a takeoff through the page's test hook and checks
// the climb, then saves screenshots of the cockpit and chase views.
//
// Usage:
//   npm install            (playwright-core)
//   node tools/e2e_test.mjs [--out build/e2e] [--chromium /path/to/chrome]
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
mkdirSync(outDir, { recursive: true });

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm", ".webp": "image/webp", ".png": "image/png",
  ".gz": "application/gzip",
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

try {
  const t0 = Date.now();
  await page.goto(`${base}/?autostart&airport=KSFO&runway=28R&time=afternoon&wind=280@8`);
  await page.waitForFunction(() => window.__fg?.flying === true, null, { timeout: 300000, polling: 500 });
  check(true, `simulator running after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const start = await page.evaluate(() => {
    const p = window.__fg.sim.props;
    return { agl: p.get("/position/altitude-agl-ft"), wow: p.getBool("/gear/gear[1]/wow"), park: p.get("/controls/gear/brake-parking") };
  });
  check(start.wow && start.agl < 10, `on the runway (AGL ${start.agl.toFixed(1)} ft)`);
  check(start.park === 1, "parking brake set at the start");
  await page.screenshot({ path: path.join(outDir, "cockpit-runway.png") });

  // Take off: brake off, full power, rotate at 55 KIAS and hold 8 degrees.
  await page.evaluate(() => {
    const a = window.__fg;
    const p = a.sim.props;
    a.speedUp = 4;
    p.set("/controls/gear/brake-parking", 0);
    a.controls.setThrottle(1);
    const hdg0 = p.get("/orientation/heading-deg");
    a.onFrame = () => {
      const g = (k) => p.get(k);
      if (g("/velocities/airspeed-kt") > 55 || g("/position/altitude-agl-ft") > 5) {
        p.set("/controls/flight/elevator", Math.max(-1, Math.min(1, -0.06 * (8 - g("/orientation/pitch-deg")))));
      }
      p.set("/controls/flight/aileron", Math.max(-1, Math.min(1, -0.03 * g("/orientation/roll-deg"))));
      const e = ((hdg0 - g("/orientation/heading-deg") + 540) % 360) - 180;
      p.set("/controls/flight/rudder", Math.max(-1, Math.min(1, 0.08 * e)));
    };
  });
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
      };
    });
    console.log(`     t=${state.t.toFixed(0)}s agl=${state.agl.toFixed(0)}ft ias=${state.ias.toFixed(0)}kt vsi=${state.vsi.toFixed(0)}fpm fps=${state.fps}`);
    if (state.agl > 400 || state.crashed) break;
  }
  check(!state.crashed, "no crash");
  check(state.agl > 400, `climbed to ${state.agl.toFixed(0)} ft AGL`);
  check(state.ias > 60 && state.ias < 100, `climb speed ${state.ias.toFixed(0)} KIAS`);
  await page.evaluate(() => window.__fg.setView(2));
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(outDir, "chase-climb.png") });
  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
} catch (err) {
  check(false, err.message);
} finally {
  await browser.close();
  server.close();
}
console.log(ok ? `PASS (screenshots in ${outDir})` : "FAILED");
process.exit(ok ? 0 : 1);
