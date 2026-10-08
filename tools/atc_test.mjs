// Ground operations test, headless: the airports' ground networks and taxi
// routing (site/js/atc/groundnet.js), the pushback tug (pushback.js) and the
// ATC (atc.js) with the real flight models.  A scripted pilot follows the
// clearances: at KSFO it pushes back from a gate, taxis the route Ground
// gives to the hold short point, gets its takeoff clearance, takes off and
// is handed to Departure; then it lands back and taxis in to a gate.
//
// Usage: node tools/atc_test.mjs [--aircraft c172p|f16|747|737] [--verbose]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import createJSBSim from "../site/wasm/jsbsim.mjs";
import { JSBSim } from "../site/js/fdm/jsbsim.js";
import { Simulation } from "../site/js/sim.js";
import { C172P } from "../site/js/aircraft/c172p.js";
import { F16, F16_PROPS, F16_RULES } from "../site/js/aircraft/f16.js";
import { B744 } from "../site/js/aircraft/b744.js";
import { B738M } from "../site/js/aircraft/b738m.js";
import { GroundNet, activeRunway, sayTaxiway, sayRunway, sayFrequency } from "../site/js/atc/groundnet.js";
import { Pushback } from "../site/js/atc/pushback.js";
import { ATC } from "../site/js/atc/atc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(path.join(here, "../site", p), "utf8"));
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
};
const verbose = process.argv.includes("--verbose");
let failed = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failed++;
};
const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// The aircraft as registry.js defines them (without its three.js models).
const AIRCRAFT = {
  c172p: {
    id: "c172p", Systems: C172P, engines: 2, wingspanM: 11, noseGearM: 1.05,
    data: { fdm: "data/fdm/c172p.json", props: "data/aircraft/c172p/props.json", rules: "data/aircraft/c172p/rules.json" },
    tug: { type: "towbar", maxSteerDeg: 30, speedKmh: 4 }, parking: ["ga", "tie-down", "tie_down"],
    callsign: { text: "N85KG", spoken: "Skyhawk eight five kilo golf" },
    taxiKt: 12, look: 15, rotateKt: 55, pitch: 8, gain: 0.06, gate: "GA ramp 1",
  },
  f16: {
    id: "f16", Systems: F16, engines: 1, wingspanM: 9.96, noseGearM: 3.04,
    data: { fdm: "data/fdm/f16.json", props: F16_PROPS, rules: F16_RULES },
    tug: { type: "pushback", maxSteerDeg: 80, speedKmh: 6 }, parking: ["mil-fighter", "ga", "cargo"],
    callsign: { text: "VIPER85", spoken: "Viper eight five" },
    taxiKt: 15, look: 20, rotateKt: 150, pitch: 12, gain: 0.08,
  },
  747: {
    id: "747", Systems: B744, engines: 4, wingspanM: 64.4, noseGearM: 22.05,
    data: { fdm: "data/fdm/747-400.json", props: "data/aircraft/747-400/props.json", rules: "data/aircraft/747-400/rules.json" },
    tug: { type: "autopush", speedKmh: 8 }, parking: ["gate", "cargo"], takeoffFlaps: { min: 0.3, say: "flaps 10 or 20" },
    callsign: { text: "FTH85", spoken: "Faithful eight five heavy" },
    taxiKt: 15, look: 45, rotateKt: 150, pitch: 10, gain: 0.1, gate: "D55", flaps: 0.667, taxiThr: 0.45,
  },
  737: {
    id: "737", Systems: B738M, engines: 2, wingspanM: 35.9, noseGearM: 15.72,
    data: { fdm: "data/fdm/737-8.json", props: "data/aircraft/737-8/props.json", rules: "data/aircraft/737-8/rules.json" },
    tug: { type: "autopush", speedKmh: 8 }, parking: ["gate", "cargo"], takeoffFlaps: { min: 0.1, say: "flaps 5" },
    callsign: { text: "GLD85", spoken: "Gold Rush eight five" },
    taxiKt: 15, look: 35, rotateKt: 145, pitch: 10, gain: 0.08, gate: "E66", flaps: 0.375, taxiThr: 0.45,
  },
};

const airports = read("data/scenery/airports.json").airports;
const ksfo = airports.find((a) => a.icao === "KSFO");
const nets = {};
for (const icao of Object.keys(read("data/scenery/groundnets/index.json"))) {
  nets[icao] = new GroundNet(read(`data/scenery/groundnets/${icao}.json`), airports.find((a) => a.icao === icao));
}

// ------------------------------------------------------------ routing

{
  const net = nets.KSFO;
  check(net.parking.length > 150 && net.hasTaxiways, `KSFO: ${net.parking.length} parking positions and a taxiway network`);
  const d55 = net.parkingByName("D55");
  const push = net.pushbackPath(d55);
  check(push && push.length >= 3, `D55 has a pushback route (${push?.length} points)`);
  check(net.parkingFor(64.4).every((p) => p.radius >= 29) && net.parkingFor(64.4).length > 10, "gates for a 747 are big enough");
  const end = push.at(-1);
  const from = { x: end.x, y: end.y, heading: (GroundNet.course(push.at(-2), end) + 180) % 360 };
  for (const rw of ["28R", "28L", "01R", "01L", "10L", "10R", "19L", "19R"]) {
    const r = net.routeToRunway(from, rw);
    const ok = r && r.via.length > 0 && r.hold && r.hold.at < r.length;
    check(ok, `KSFO D55 to ${rw}: ${r ? `${(r.length / 1000).toFixed(1)} km via ${r.via.join(" ")}, ${r.crossings.length} crossings, hold short at ${r.hold?.at.toFixed(0)} m` : "no route"}`);
    // The hold point is clear of the runway, and the route ends on it.
    if (ok) {
      const rwy = net.runway(rw);
      check(GroundNet.runwayDistance(rwy, r.hold) > 15 && GroundNet.runwayDistance(rwy, r.points.at(-1)) === 0,
        `  holds ${GroundNet.runwayDistance(rwy, r.hold).toFixed(0)} m from runway ${rw}, lines up on it`);
    }
  }
  // Rolling out on 28R, near its far end.
  const r28 = net.runway("28R");
  const fromRunway = { x: r28.x + r28.ux * 2600, y: r28.y + r28.uy * 2600, heading: r28.heading };
  const park = net.arrivalParking(fromRunway, 64.4, ["gate"]);
  const r = park && net.routeToParking(fromRunway, park);
  check(r && r.parking === park, `taxi in from runway 28L to ${park?.name} via ${r?.via.join(" ")}`);
}
for (const [icao, net] of Object.entries(nets)) {
  if (!net.hasTaxiways) continue;
  const p = net.parking[0];
  const rw = activeRunway(net.airport, 280, 8).id;
  const r = net.routeToRunway({ x: net.nodes[p.node].x, y: net.nodes[p.node].y, heading: p.heading }, rw)
    ?? net.routeToRunway({ x: net.nodes[p.node].x, y: net.nodes[p.node].y, heading: (p.heading + 180) % 360 }, rw);
  check(!!r, `${icao}: ${p.name} to runway ${rw}${r ? ` via ${r.via.join(" ") || "(apron)"}` : ""}`);
}
check(sayTaxiway("F1") === "Foxtrot One" && sayTaxiway("Z") === "Zulu", "taxiway names in the phonetic alphabet");
check(sayRunway("01L") === "one left" && sayRunway("28R") === "two eight right", "runways read out");
check(sayFrequency(120.5) === "one two zero point five" && sayFrequency(128.65) === "one two eight point six five", "frequencies read out");

// ------------------------------------------------------- flights

const jsb = await JSBSim.load(createJSBSim, { printErr: () => {} });
jsb.setGroundProvider(() => ({ elev: ksfo.elevationFt * 0.3048, nE: 0, nN: 0, nU: 1 }));

/** A scripted pilot taxiing along ATC's route: steer for a point ahead, hold a speed, stop at the hold line. */
function taxi(atc, def, p, net) {
  const r = atc.route;
  const w = atc.where();
  let want = 0;
  let rudder = 0;
  if (r) {
    const n = atc.nose(w);
    const s = atc.track.s;
    const look = net.pointAt(r.points, r.cum, Math.min(r.length, s + def.look));
    const err = wrap180(GroundNet.course(n, look) - w.heading);
    rudder = clamp(err / 30, -1, 1);
    const stopAt = (r.hold ? r.hold.at : r.length) - s;
    want = Math.min(def.taxiKt, Math.max(2, stopAt / 6));
    if (Math.abs(err) > 20) want = Math.min(want, 7);
    if (stopAt < 6) want = 0;
  }
  p.set("/controls/flight/rudder", rudder);
  const gs = w.gsKt;
  const thr = want === 0 ? 0 : clamp(0.15 + (want - gs) * 0.06, 0, def.taxiThr ?? 0.6);
  for (let i = 0; i < def.engines; i++) p.set(`/controls/engines/engine[${i}]/throttle`, thr);
  const brake = want === 0 ? 1 : gs > want + 2 ? 0.4 : 0;
  p.set("/controls/gear/brake-left", brake);
  p.set("/controls/gear/brake-right", brake);
}

function flight(id) {
  const def = AIRCRAFT[id];
  const get = (v) => (typeof v === "string" ? read(v) : v);
  const sim = new Simulation(jsb, { fdm: get(def.data.fdm), props: get(def.data.props), rules: get(def.data.rules) }, def.Systems);
  const net = nets.KSFO;
  const spots = net.parkingFor(def.wingspanM);
  const park = net.parkingByName(def.gate) ?? spots.find((s) => s.pushback >= 0 && s.type === "ga") ?? spots[0];
  const rwy = ksfo.runways.find((r) => r.id === "28R");
  const cfg = { lat: park.lat, lon: park.lon, headingDeg: park.heading, onGround: true, running: true, parking: park,
    airport: ksfo, runway: rwy, wind: { fromDeg: 280, kt: 8 }, visibilityM: 35000, fuel: 0.75 };
  sim.start(cfg);
  const p = sim.props;
  p.set("/controls/gear/brake-parking", 1);
  const radio = [];
  const msgs = [];
  const app = {
    sim, def, airports, groundnet: async (icao) => nets[icao] ?? null,
    radio: {
      transmit: (m) => { radio.push(m); if (verbose) console.log(`     [${m.station}] ${m.text}`); },
      setStation() {}, setGuidance() {}, clearGuidance() {},
    },
    routeView: { show() {}, showPath() {}, clear() {}, progress() {} },
    message: (t) => msgs.push(t),
  };
  const atc = new ATC(app);
  atc.begin({ ...cfg, position: "gate" }, net);
  const said = (re) => radio.some((m) => re.test(m.text));
  const dt = 1 / 60;
  let t = 0;
  const step = () => {
    atc.update(dt);
    sim.update(dt);
    t += dt;
  };
  const run = (seconds, each, until) => {
    for (let k = 0; k < seconds * 60; k++) {
      each?.();
      step();
      if (until?.()) return true;
    }
    return false;
  };
  console.log(`--- ${id} at KSFO ${park.name} (${park.type})`);

  // Pushback.
  const push = atc.options().find((o) => /pushback/.test(o.label));
  check(!!push && atc.phase === "parked", `${id}: parked, pushback offered`);
  push.run();
  check(atc.phase === "pushback" && said(/push back approved/), `${id}: Ground approves the pushback`);
  run(5);
  p.set("/controls/gear/brake-parking", 0);
  const pushed = run(240, null, () => atc.phase !== "pushback");
  check(pushed && atc.phase === "ready", `${id}: pushback complete after ${t.toFixed(0)} s (${radio.filter((m) => m.crew).map((m) => m.text).join(" / ")})`);
  p.set("/controls/gear/brake-parking", 1);
  run(3);

  // Taxi clearance.
  atc.options().find((o) => /Request taxi/.test(o.label)).run();
  const clr = radio.findLast((m) => /taxi via/.test(m.text) && !m.pilot);
  check(atc.phase === "taxi-out" && !!atc.route && !!clr, `${id}: ${clr?.text}`);
  check(/hold short of runway 28R/.test(clr?.text ?? "") && /Foxtrot|Charlie|Quebec|Alpha|Bravo/.test(clr?.speech ?? ""), `${id}: spoken with the phonetic alphabet`);
  p.set("/controls/gear/brake-parking", 0);
  const t0 = t;
  const held = run(900, () => taxi(atc, def, p, net), () => atc.phase === "holding");
  const progressive = radio.filter((m) => /turn (left|right) on|continue on|cross runway/.test(m.text) && !/taxi via/.test(m.text));
  check(held, `${id}: taxied to the hold short point in ${(t - t0).toFixed(0)} s, ${progressive.length} progressive calls`);
  check(said(/contact tower/), `${id}: Ground hands over to Tower at the hold line`);
  check(!said(/not cleared onto runway/), `${id}: no runway incursion`);

  // Takeoff.
  atc.options().find((o) => /Ready for departure/.test(o.label)).run();
  check(atc.phase === "cleared" && said(/cleared for takeoff/), `${id}: cleared for takeoff`);
  if (def.flaps) p.set("/controls/flight/flaps", def.flaps);
  // Line up, then full power along the runway.
  const rw = net.runway("28R");
  let airborne = false;
  const tTake = t;
  run(400, () => {
    const w = atc.where();
    const c = GroundNet.runwayCoords(rw, atc.nose(w));
    const ahead = { x: rw.x + rw.ux * (c.along + (w.gsKt > 40 ? 300 : 60)), y: rw.y + rw.uy * (c.along + (w.gsKt > 40 ? 300 : 60)) };
    const err = wrap180(GroundNet.course(atc.nose(w), ahead) - w.heading);
    const hdgErr = wrap180(rw.heading - w.heading);
    p.set("/controls/flight/rudder", w.wow && w.gsKt < 40 ? clamp(err / 25, -1, 1) : clamp(0.08 * hdgErr, -1, 1));
    p.set("/controls/gear/brake-left", 0);
    p.set("/controls/gear/brake-right", 0);
    const lined = Math.abs(wrap180(w.heading - rw.heading)) < 10;
    for (let i = 0; i < def.engines; i++) p.set(`/controls/engines/engine[${i}]/throttle`, lined ? 1 : 0.3);
    if (p.get("/velocities/airspeed-kt") > def.rotateKt || w.agl > 5) {
      p.set("/controls/flight/elevator", clamp(-def.gain * (def.pitch - p.get("/orientation/pitch-deg")), -1, 1));
    }
    p.set("/controls/flight/aileron", clamp(-0.03 * p.get("/orientation/roll-deg"), -1, 1));
    if (w.agl > 100) p.set("/controls/gear/gear-down", 0);
    airborne ||= !w.wow && w.agl > 50;
    if (verbose && Math.round(t * 60) % (60 * 20) === 0) {
      console.log(`     t=${t.toFixed(0)} gs=${w.gsKt.toFixed(0)} hdg=${w.heading.toFixed(0)} along=${c.along.toFixed(0)} across=${c.across.toFixed(0)} agl=${w.agl.toFixed(0)} err=${err.toFixed(0)}`);
    }
  }, () => atc.phase === "airborne");
  check(airborne && atc.phase === "airborne" && said(/contact NorCal Departure/), `${id}: airborne ${(t - tTake).toFixed(0)} s after the clearance, over to NorCal Departure`);
  check(!sim.fdm.crashed, `${id}: no crash`);
  return { radio };
}

/** After landing: rolling out on 28R, cleared to land, then taxi in to a gate. */
function arrival(id) {
  const def = AIRCRAFT[id];
  const get = (v) => (typeof v === "string" ? read(v) : v);
  const sim = new Simulation(jsb, { fdm: get(def.data.fdm), props: get(def.data.props), rules: get(def.data.rules) }, def.Systems);
  const net = nets.KSFO;
  const r28 = net.runway("28R");
  const at = net.latlon(r28.x + r28.ux * 2400, r28.y + r28.uy * 2400);
  const rwy = ksfo.runways.find((r) => r.id === "28R");
  const cfg = { lat: at.lat, lon: at.lon, headingDeg: rwy.heading, onGround: true, running: true,
    airport: ksfo, runway: rwy, wind: { fromDeg: 280, kt: 8 }, visibilityM: 35000, fuel: 0.75 };
  sim.start(cfg);
  const p = sim.props;
  const radio = [];
  const app = {
    sim, def, airports, groundnet: async (icao) => nets[icao] ?? null,
    radio: { transmit: (m) => { radio.push(m); if (verbose) console.log(`     [${m.station}] ${m.text}`); }, setStation() {}, setGuidance() {}, clearGuidance() {} },
    routeView: { show() {}, showPath() {}, clear() {}, progress() {} },
    message() {},
  };
  const atc = new ATC(app);
  atc.begin({ ...cfg, position: "air" }, net);
  atc.requestLanding(ksfo);
  console.log(`--- ${id} landing at KSFO 28R`);
  check(atc.phase === "landing" && radio.some((m) => /cleared to land/.test(m.text)), `${id}: cleared to land runway 28R`);
  const dt = 1 / 60;
  let t = 0;
  const run = (seconds, each, until) => {
    for (let k = 0; k < seconds * 60; k++) {
      each?.();
      atc.update(dt);
      sim.update(dt);
      t += dt;
      if (until?.()) return true;
    }
    return false;
  };
  p.set("/controls/gear/brake-parking", 0);
  run(5, null, () => atc.phase === "landed");
  check(atc.phase === "landed" && radio.some((m) => /contact ground/.test(m.text)), `${id}: Tower: exit the runway, contact Ground`);
  atc.options().find((o) => /taxi to the gate/.test(o.label)).run();
  const clr = radio.findLast((m) => /taxi to/.test(m.text) && !m.pilot);
  check(atc.phase === "taxi-in" && atc.route?.parking, `${id}: ${clr?.text}`);
  const fits = atc.route?.parking.radius >= def.wingspanM / 2 * 0.92;
  check(fits, `${id}: the gate fits a ${def.wingspanM} m span (radius ${atc.route?.parking.radius} m)`);
  const parked = run(1200, () => taxi(atc, def, p, net), () => atc.phase === "parked");
  check(parked && radio.some((m) => /welcome to San Francisco/.test(m.text)), `${id}: taxied in and parked at ${atc.parking?.name} after ${t.toFixed(0)} s`);
  check(!sim.fdm.crashed, `${id}: no crash`);
}

const only = arg("--aircraft", null);
for (const id of only ? [only] : ["c172p", "747", "737", "f16"]) flight(id);
for (const id of only ? [only] : ["c172p", "747", "737"]) arrival(id);

// The pushback tug alone, cold and dark, at a gate each airliner fits.
for (const [id, gate] of [["747", "G98"], ["737", "F72"]]) {
  if (only && only !== id) continue;
  const def = AIRCRAFT[id];
  const sim = new Simulation(jsb, { fdm: read(def.data.fdm), props: read(def.data.props), rules: read(def.data.rules) }, def.Systems);
  const g = nets.KSFO.parkingByName(gate);
  sim.start({ lat: g.lat, lon: g.lon, headingDeg: g.heading, onGround: true, running: false });
  const pb = new Pushback(sim, def.tug);
  const path = nets.KSFO.pushbackPath(g).slice(1);
  pb.connect(path.map((n) => nets.KSFO.latlon(n.x, n.y)));
  for (let k = 0; k < 60 * 200 && pb.active; k++) {
    pb.update(1 / 60);
    sim.update(1 / 60);
  }
  const pos = nets.KSFO.xy(sim.props.get("/position/latitude-deg"), sim.props.get("/position/longitude-deg"));
  const d = Math.hypot(pos.x - path.at(-1).x, pos.y - path.at(-1).y);
  check(!pb.active && d < 10, `${id} cold and dark pushed back from ${gate}, ${d.toFixed(1)} m from the pushback point`);
}

console.log(failed ? `FAILED (${failed})` : "PASS");
process.exit(failed ? 1 : 0);
