// Aircraft glue for the Boeing 737 MAX 8 of the 737-family project
// (naviat-dev/737-family: Israel Emmanuel, Josh Davidson and the 737 MAX
// team, GPL-2.0).  Its JSBSim flight model (Michael Soitanen, YV3399,
// Octal450 and sriemmanuel787) is the project's own; the project is still a
// work in progress and its Nasal does not compute everything the flight
// model and the 3D model read, so this file does, the way b744.js ports the
// 747's Nasal:
//
//   - the brakes and speedbrake the FCS reads (fcs/brake-*-cmd,
//     /controls/flight/speedbrake-output), with the speedbrake lever's
//     four positions and the ground spoilers' automatic deployment,
//   - the autobrakes (RTO, 1, 2, 3, MAX) on the FCS's autobrake channel,
//   - the thrust reversers (/engines/engine[n]/reverser-pos-norm),
//   - the engine and APU starts,
//   - the surface angles the 3D model animates (hydraulics/*/final-deg).
//
// Engines 0-1 are the CFM LEAP-1B28 turbofans; engine 2 is the APU.

import { Flasher } from "./c172p.js";

const ENGINES = 2;
const APU = 2;
const R2D = 180 / Math.PI;
const LIGHT_OFF_N2 = 22; // fuel on at 22% N2, as the 737 FCOM's start
const APU_LIGHT_OFF_N2 = 15; // the APU's starter turns it at 15.1% (131-9d.xml ignitionn2)
const FUEL_CAPACITY = [8630, 8630, 28803]; // lb: left wing, right wing, center
const REVERSER_TIME = 2; // s to deploy or stow
// Speedbrake lever: its four positions and the spoiler command each gives.
const SPEEDBRAKE = ["DOWN", "ARMED", "FLIGHT DETENT", "UP"];
const SPEEDBRAKE_OUTPUT = [0, 0, 0.5, 1];
// Autobrake selector (-1 RTO, 0 OFF, 1, 2, 3, 4 MAX) and the deceleration
// each asks the FCS's autobrake for (ft/s^2; the FCS eases MAX to 12 below
// 80 kt).
const AUTOBRAKE = { "-1": "RTO", 0: "OFF", 1: "1", 2: "2", 3: "3", 4: "MAX" };
const AUTOBRAKE_DECEL = { 1: 4, 2: 5, 3: 7.2, 4: 14 };
const RTO_KT = 90; // RTO brakes a takeoff rejected above this
// Pilot's eye: the set file's view offsets moved with the 3D model, which
// sits 2.0 m ahead and 1.78 m below where the project's model XML puts it
// (tools/b737/737-8-web.xml).  The set file looks 16° down at a 3D panel the
// model does not have yet; here the view looks out over the head-up display.
const EYE = { x: -0.448, y: 2.788 - 1.78, z: -15.211 - 2.0, pitch: -6, fov: 65 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Properties the 737's JSBSim systems read before anything has set them. */
const STARTUP_PROPERTIES = {
  "/controls/flight/speedbrake-lever": 0,
  "/controls/flight/speedbrake-arm": 0,
  "/controls/flight/speedbrake-output": 0,
  "/controls/gear/autobrakes": 0,
  "/controls/gear/tiller-enabled": false,
  "/controls/gear/tiller-cmd-norm": 0,
  "/controls/apu/master": false,
  "/controls/fuel/crossfeed": false,
  "/accelerations/pilot-gdamped": 1,
  "/fdm/jsbsim/fcs/autobrake/autobrake-in-use": 0,
  "/fdm/jsbsim/fcs/autobrake/autobrake-cmd": 0,
  "/fdm/jsbsim/fcs/autobrake/target-decel-fps_sec2": 0,
  "/fdm/jsbsim/fcs/autobrake/start-time-sec": 0,
  "/sim/view/config/x-offset-m": EYE.x,
  "/sim/view/config/y-offset-m": EYE.y,
  "/sim/view/config/z-offset-m": EYE.z,
  "/sim/view/config/pitch-offset-deg": EYE.pitch,
  "/sim/view/config/default-field-of-view-deg": EYE.fov,
};

/** Replaces `from` with `to` in a flight model file; warns if it is not there. */
function patch(files, file, from, to, what) {
  const text = files[file];
  if (!text) return;
  const next = text.replace(from, to);
  if (next === text) console.warn(`737: ${what} not patched in ${file}`);
  files[file] = next;
}

export class B738M {
  /**
   * The flight model as this site runs it (applied to its files before it
   * loads):
   *   - The FCS reads the pilot's controls through /controls/flight/
   *     elevator-sum and aileron-sum, which the project's Nasal was to
   *     compute; here they are JSBSim's own control commands, so JSBSim's
   *     trim can also move them for an airborne start.
   *   - The stabilizer, the 737's pitch trim, follows the trim control
   *     (fcs/pitch-trim-cmd-norm: -1 to 1 is 0 to 17 units, 0 the green
   *     band's 5.5) instead of a target the Nasal was to set, so the trim
   *     keys move it and JSBSim's trim can trim with it.
   *   - The throttle channel copies /controls/engines/engine[n]/throttle
   *     over fcs/throttle-cmd-norm[n] on every step, so JSBSim's trim could
   *     not set the thrust; it now takes fcs/throttle-cmd-norm[n] itself,
   *     which carries the throttles all the same.
   *   - The project's fuel system (b737-fuel.xml) is unfinished: its tank
   *     numbers do not match the flight model's and it keeps pumping 9 lb/s
   *     into each 0.5 lb feed pipe, losing the fuel.  The engines feed
   *     straight from their wing tank and the center tank instead, and the
   *     APU from the left wing tank.
   */
  static patchFdm(bundle) {
    const file = "aircraft/737-8/737-8.xml";
    if (!bundle.files[file] || bundle.files[file].includes("<!-- web: patched -->")) return bundle;
    const files = { ...bundle.files };
    patch(files, file, "<input>/controls/flight/elevator-sum</input>", "<input>fcs/elevator-cmd-norm</input>", "pitch input");
    patch(files, file, "<input>/controls/flight/aileron-sum</input>", "<input>fcs/aileron-cmd-norm</input>", "roll input");
    patch(files, file, /<channel name="Stabilizer">[\s\S]*?<fcs_function name="fcs\/stab">/, `<channel name="Stabilizer">
			<fcs_function name="fcs/stabilizer/stabilizer-pos-unit">
				<function><table><independentVar>fcs/pitch-trim-cmd-norm</independentVar>
					<tableData>
						-1 0
						 0 5.5
						 1 17
					</tableData></table></function>
				<output>fcs/stabilizer-pos-unit</output>
			</fcs_function>
			<fcs_function name="fcs/stab">`, "stabilizer");
    for (const n of [0, 1]) {
      patch(files, file, `<output>fcs/throttle-cmd-norm[${n}]</output>`, "", `throttle ${n} output`);
      patch(files, file, `<input>fcs/throttle/throttle-cmd-norm[${n}]</input>`, `<input>fcs/throttle-cmd-norm[${n}]</input>`, `throttle ${n} input`);
    }
    patch(files, file, /<system file="b737-fuel"\s*\/>/, "", "fuel system");
    patch(files, file, "<feed>3</feed>", "<feed>0</feed><feed>2</feed>", "engine 1 feed");
    patch(files, file, "<feed>4</feed>", "<feed>1</feed><feed>2</feed>", "engine 2 feed");
    patch(files, file, "<feed>5</feed>", "<feed>0</feed>", "APU feed");
    patch(files, file, "<fdm_config", "<!-- web: patched -->\n<fdm_config", "marker");
    return { ...bundle, files };
  }

  constructor(props) {
    this.props = props;
    this.starting = false;
    this.flashers = [];
    this.reverser = [0, 0];
    this.landed = false; // since the last touchdown, until the aircraft slows to taxi speed
    this.airborne = false;
    this.autobraking = false;
  }

  /** Before the FDM loads. */
  preInit() {
    const p = this.props;
    for (const [k, v] of Object.entries(STARTUP_PROPERTIES)) p.set(k, v);
    for (let i = 0; i <= APU; i++) {
      p.set(`/controls/engines/engine[${i}]/reverser`, false);
      p.set(`/engines/engine[${i}]/reverser-pos-norm`, 0);
    }
    p.set("/surface-positions/reverser-norm", 0);
    p.set("/surface-positions/speedbrake-norm", 0);
    // FlightGear's autopush (Models/autopush-config.xml): the tug's force
    // goes in through the flight model's "tractor" force, and it steers
    // with the rudder pedals (the nose wheel tiller follows them).
    p.set("/sim/model/autopush/connected", false);
    p.set("/sim/model/autopush/force-lbf", 0);
  }

  /** After the FDM loads: the systems' clock, and fuel (wings first, then the center tank). */
  afterLoad(fuelFraction = 0.75) {
    const p = this.props;
    p.alias("sim-time-sec", "/fdm/jsbsim/simulation/sim-time-sec");
    // About 22,500 lb at the menu's 75%: a two to three hour flight.
    const fuel = 30000 * clamp(fuelFraction, 0.25, 1);
    const wing = Math.min(fuel / 2, FUEL_CAPACITY[0]);
    const load = [wing, wing, Math.min(FUEL_CAPACITY[2], fuel - 2 * wing)];
    for (let i = 0; i < 3; i++) {
      p.set(`propulsion/tank[${i}]/contents-lbs`, load[i]);
      p.set(`/consumables/fuel/tank[${i}]/level-lbs`, load[i]);
    }
  }

  init() {
    const p = this.props;
    this.starting = false;
    this.reverser = [0, 0];
    this.flashers = [
      new Flasher(p, "/sim/model/lights/beacon", [0.05, 1.2]),
      new Flasher(p, "/sim/model/lights/strobe", [0.05, 1.5]),
    ];
    const running = p.getBool("/sim/presets/running");
    const onGround = p.getBool("/sim/presets/onground");
    this.airborne = !onGround;
    this.landed = false;
    this.autobraking = false;
    // Takeoffs with RTO armed; landings with autobrake 2 and the
    // speedbrake armed.
    p.set("/controls/gear/autobrakes", onGround ? -1 : 2);
    p.set("/controls/flight/speedbrake-arm", onGround ? 0 : 1);
    p.set("/controls/flight/speedbrake-lever", 0);
    // A running start runs every engine; the APU is not needed with the
    // engines turning.
    if (running) {
      p.set(`/engines/engine[${APU}]/running`, false);
      p.set(`propulsion/engine[${APU}]/set-running`, 0);
      p.set(`propulsion/engine[${APU}]/n1`, 0);
      p.set(`propulsion/engine[${APU}]/n2`, 0);
    }
    this.lights(running);
  }

  /** A running start: fuel on for the two engines, the APU shut down. */
  runningState() {
    const p = this.props;
    for (let i = 0; i < ENGINES; i++) {
      p.set(`/controls/engines/engine[${i}]/cutoff`, false);
      p.set(`/controls/engines/engine[${i}]/starter`, false);
    }
    p.set(`/controls/engines/engine[${APU}]/cutoff`, true);
    p.set(`/controls/engines/engine[${APU}]/throttle`, 0);
  }

  lights(on) {
    const p = this.props;
    for (const l of ["beacon", "nav-lights", "logo-lights", "strobe"]) p.set(`/controls/lighting/${l}`, on);
    p.set("/controls/lighting/anti-collision", on);
    p.set("/controls/lighting/position", on ? 1 : 0);
    p.set("/controls/lighting/taxi-light", on);
    p.set("/sim/model/lights/beacon/enabled", on);
    p.set("/sim/model/lights/strobe/enabled", on);
  }

  get running() {
    for (let i = 0; i < ENGINES; i++) if (!this.props.getBool(`/engines/engine[${i}]/running`)) return false;
    return true;
  }

  /**
   * Autostart, as the crew would: the APU first, then both engines on the
   * starters with the fuel cut off, the fuel opening at 22% N2 once the APU
   * gives them bleed air.
   */
  autostart() {
    if (this.running) return "Engines already running";
    const p = this.props;
    for (let i = 0; i <= APU; i++) {
      if (p.getBool(`/engines/engine[${i}]/running`)) continue;
      p.set(`/controls/engines/engine[${i}]/throttle`, 0);
      p.set(`/controls/engines/engine[${i}]/cutoff`, true);
      p.set(`/controls/engines/engine[${i}]/starter`, true);
    }
    p.set("/controls/apu/master", true);
    this.lights(true);
    this.starting = true;
    return "Autostart: APU on, starting engines 1 and 2...";
  }

  /** 's' key: the engine starters, held (the fuel opens at 22% N2 while it is held). */
  setStarter(on) {
    const p = this.props;
    if (on && this.running) return;
    for (let i = 0; i < ENGINES; i++) {
      if (on && p.getBool(`/engines/engine[${i}]/running`)) continue;
      if (on && p.get(`/engines/engine[${i}]/n2`) < LIGHT_OFF_N2) p.set(`/controls/engines/engine[${i}]/cutoff`, true);
      p.set(`/controls/engines/engine[${i}]/starter`, !!on);
    }
    if (!on) this.starting = false;
  }

  /** Delete: thrust reversers (they deploy only on the ground at idle). */
  toggleReversers() {
    const p = this.props;
    const on = !p.getBool("/controls/engines/engine[0]/reverser");
    for (let i = 0; i < ENGINES; i++) p.set(`/controls/engines/engine[${i}]/reverser`, on);
    return on ? "Reversers armed (deploy on the ground at idle)" : "Reversers stowed";
  }

  /** The speedbrake lever: v > 0 one position further out, v < 0 back, undefined cycles. */
  speedbrakeLever(v) {
    const p = this.props;
    const cur = this.speedbrakeStep();
    const step = v === undefined ? (cur + 1) % 4 : clamp(cur + Math.sign(v), 0, 3);
    p.set("/controls/flight/speedbrake-arm", step === 1 ? 1 : 0);
    p.set("/controls/flight/speedbrake-lever", SPEEDBRAKE_OUTPUT[step]);
    return `Speedbrake lever: ${SPEEDBRAKE[step]}`;
  }

  speedbrakeStep() {
    const p = this.props;
    const lever = p.get("/controls/flight/speedbrake-lever");
    if (lever > 0.75) return 3;
    if (lever > 0.25) return 2;
    return p.getBool("/controls/flight/speedbrake-arm") ? 1 : 0;
  }

  /** The speedbrake lever's position for the flight data strip. */
  speedbrakeName() {
    return ["DOWN", "ARMED", "FLIGHT", "UP"][this.speedbrakeStep()];
  }

  /** The autobrake selector, one click: RTO, OFF, 1, 2, 3, MAX. */
  autobrakeSelector(dir) {
    const p = this.props;
    const s = clamp(p.get("/controls/gear/autobrakes") + Math.sign(dir), -1, 4);
    p.set("/controls/gear/autobrakes", s);
    if (s <= 0) this.stopAutobrake();
    return `Autobrake ${AUTOBRAKE[s]}`;
  }

  autobrakeName() {
    return this.autobraking ? `${AUTOBRAKE[this.props.get("/controls/gear/autobrakes")]} ON` : AUTOBRAKE[this.props.get("/controls/gear/autobrakes")];
  }

  startAutobrake(decel) {
    const p = this.props;
    this.autobraking = true;
    p.set("fcs/autobrake/target-decel-fps_sec2", decel);
    p.set("fcs/autobrake/start-time-sec", p.get("simulation/sim-time-sec"));
    p.set("fcs/autobrake/autobrake-cmd", 0);
    p.set("fcs/autobrake/autobrake-in-use", 1);
  }

  stopAutobrake() {
    const p = this.props;
    this.autobraking = false;
    p.set("fcs/autobrake/autobrake-in-use", 0);
    p.set("fcs/autobrake/autobrake-cmd", 0);
  }

  update(dt) {
    const p = this.props;
    // Engine starts: fuel on at light-off speed, starter off once running.
    const apuUp = p.getBool(`/engines/engine[${APU}]/running`);
    for (let i = 0; i <= APU; i++) {
      if (!p.getBool(`/controls/engines/engine[${i}]/starter`)) continue;
      // JSBSim's turbines spin up on the starter only with the fuel cut
      // off: it opens at light-off speed, for the engines once the APU
      // gives them bleed air in an autostart.
      const lightOff = i === APU ? APU_LIGHT_OFF_N2 : LIGHT_OFF_N2;
      if (p.get(`/engines/engine[${i}]/n2`) >= lightOff && (i === APU || apuUp || !this.starting)) {
        p.set(`/controls/engines/engine[${i}]/cutoff`, false);
      }
      if (p.getBool(`/engines/engine[${i}]/running`)) p.set(`/controls/engines/engine[${i}]/starter`, false);
    }
    if (this.starting && this.running) {
      // Both engines up: the APU goes off again.
      this.starting = false;
      p.set(`/controls/engines/engine[${APU}]/cutoff`, true);
      p.set("/controls/apu/master", false);
    }

    const wow = p.getBool("/gear/gear[1]/wow") || p.getBool("/gear/gear[2]/wow");
    const thr = Math.max(p.get("/controls/engines/engine[0]/throttle"), p.get("/controls/engines/engine[1]/throttle"));
    const idle = thr < 0.05;
    const gs = p.get("/velocities/groundspeed-kt");
    if (!wow && p.get("/position/altitude-agl-ft") > 50) this.airborne = true;
    const touchdown = wow && this.airborne;
    if (touchdown) {
      this.airborne = false;
      this.landed = true;
    }
    if (wow && gs < 30) this.landed = false;

    // Thrust reversers: out on the ground with the levers at idle.
    let rev = 0;
    for (let i = 0; i < ENGINES; i++) {
      const want = p.getBool(`/controls/engines/engine[${i}]/reverser`) && wow && (idle || this.reverser[i] > 0) ? 1 : 0;
      this.reverser[i] += clamp(want - this.reverser[i], -dt / REVERSER_TIME, dt / REVERSER_TIME);
      p.set(`/engines/engine[${i}]/reverser-pos-norm`, this.reverser[i]);
      rev = Math.max(rev, this.reverser[i]);
    }
    p.set("/surface-positions/reverser-norm", rev);

    // Speedbrake: the lever, which goes all the way up by itself when armed
    // and the main gear touches down with the throttles closed, or in a
    // rejected takeoff (throttles closed above 60 kt).
    const armed = p.getBool("/controls/flight/speedbrake-arm");
    const rto = wow && !this.landed && idle && gs > 60 && p.get("/controls/gear/autobrakes") === -1;
    if (wow && idle && (armed && this.landed || rto)) {
      p.set("/controls/flight/speedbrake-lever", 1);
      p.set("/controls/flight/speedbrake-arm", 0);
    }
    const sb = p.get("/controls/flight/speedbrake-lever");
    p.set("/controls/flight/speedbrake-output", sb);
    // The ground spoilers, with the lever up on the ground.
    p.set("/controls/flight/spoilers", wow && sb > 0.9 ? 1 : 0);
    p.set("/surface-positions/speedbrake-norm", p.get("fcs/speedbrake-pos-norm"));

    // Autobrakes: the landing settings brake from touchdown with the
    // throttles closed, RTO a takeoff rejected above 90 kt; manual braking
    // or thrust disarms them.
    const setting = p.get("/controls/gear/autobrakes");
    const manual = Math.max(p.get("/controls/gear/brake-left"), p.get("/controls/gear/brake-right")) > 0.5;
    if (!wow && setting === -1 && p.get("/position/altitude-agl-ft") > 50) p.set("/controls/gear/autobrakes", 0);
    if (!this.autobraking && wow && idle && !manual) {
      if (setting > 0 && this.landed) this.startAutobrake(AUTOBRAKE_DECEL[setting]);
      else if (setting === -1 && !this.landed && gs > RTO_KT) this.startAutobrake(AUTOBRAKE_DECEL[4]);
    }
    if (this.autobraking && (manual || !idle || !wow || gs < 1)) {
      this.stopAutobrake();
      if (manual || !idle) p.set("/controls/gear/autobrakes", 0); // DISARM
    }

    // Brakes: the FCS takes them from fcs/brake-*-cmd (the parking brake holds both).
    const park = p.get("/controls/gear/brake-parking");
    p.set("fcs/brake-left-cmd", Math.max(p.get("/controls/gear/brake-left"), park));
    p.set("fcs/brake-right-cmd", Math.max(p.get("/controls/gear/brake-right"), park));

    // The 3D model's surface angles (degrees, trailing edge down positive:
    // its hinge axes all point to the right), from JSBSim's positions; the
    // stabilizer from its trim.
    p.set("hydraulics/aileron-l/final-deg", p.get("fcs/left-aileron-pos-rad") * R2D);
    p.set("hydraulics/aileron-r/final-deg", p.get("fcs/right-aileron-pos-rad") * R2D);
    const de = p.get("fcs/elevator-pos-rad") * R2D;
    p.set("hydraulics/elevator-l/final-deg", de);
    p.set("hydraulics/elevator-r/final-deg", de);
    p.set("hydraulics/rudder/final-deg", p.get("fcs/rudder-pos-rad") * R2D);
    p.set("hydraulics/stabilizer/final-deg", p.get("fcs/stab"));

    let fuel = 0;
    for (let i = 0; i < 3; i++) fuel += p.get(`propulsion/tank[${i}]/contents-lbs`);
    p.set("/consumables/fuel/total-fuel-lbs", fuel);
    for (const f of this.flashers) f.update(dt);
  }
}
