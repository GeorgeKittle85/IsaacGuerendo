// Aircraft glue for FlightGear's Boeing 747-400 (Gijs de Rooy and the 747
// team): its JSBSim flight model, property rules (autopilot, autobrake,
// autospoilers, PFD) and 3D model are FlightGear's own.  Its Nasal is ported
// here where the flight model depends on it:
//   - 744_hyd.nas: the four hydraulic systems.  Below 1000 psi in systems 1
//     and 4 the inboard elevators float, so the aircraft needs them.
//   - system.nas: autostart, the beacon and strobe flashers, and the
//     "no gear up on the ground" rule.
//
// Engines 0-3 are the GE CF6-80C2B1F turbofans; engine 4 is the APU.

import { Flasher } from "./c172p.js";

const ENGINES = 4;
const APU = 4;
const LIGHT_OFF_N2 = 25; // system.nas autostartCutoff: fuel on above 25% N2
const HYD_PSI = 3000;

/** Properties the 747's JSBSim systems read before its Nasal has run. */
const STARTUP_PROPERTIES = {
  "/controls/fuel/fuel-to-remain-lbs": 0,
  "/controls/fuel/dump-valve": false,
  "/controls/fuel/transfer-main-1-4": false,
  "/controls/fuel/tank[7]/pump": false,
  "/controls/gear/tiller-enabled": false,
  "/controls/gear/tiller-cmd-norm": 0,
  "/controls/flight/speedbrakes": 0,
  "/autopilot/autospoilers/step": 0,
  "/autopilot/autobrake/step": -1,
  "/autopilot/autobrake/left-brake-output": 0,
  "/autopilot/autobrake/right-brake-output": 0,
  "/controls/failures/wings/broken": false,
  "/controls/engines/con-ignition": false,
};

export class B744 {
  /**
   * The tug's steering bypass pin: in hydraulics.xml the nose wheel freezes
   * below 1000 psi in hydraulic system 1, but with a tug connected the
   * towbar turns it, hydraulics or not (autopush.nas: "Pushback and bypass
   * pin removed").  Applied to the flight model's files before it loads.
   */
  static patchFdm(bundle) {
    const file = "aircraft/747-400/Systems/hydraulics.xml";
    const text = bundle.files[file];
    if (!text || text.includes("autopush/connected")) return bundle;
    const patched = text.replace(
      /(\/systems\/hydraulic\/pressure\[0\] LT 1000\s*)(<\/test>\s*<output>fcs\/gear-nose-actuator\/malfunction\/fail_stuck)/,
      "$1  /sim/model/autopush/connected == 0\n\t\t\t$2");
    if (patched === text) console.warn("747: nose wheel bypass pin not patched in", file);
    return { ...bundle, files: { ...bundle.files, [file]: patched } };
  }

  constructor(props) {
    this.props = props;
    this.pressure = [0, 0, 0, 0];
    this.starting = false;
    this.flashers = [];
  }

  /** Before the FDM loads. */
  preInit() {
    const p = this.props;
    for (const [k, v] of Object.entries(STARTUP_PROPERTIES)) p.set(k, v);
    for (let i = 0; i <= APU; i++) {
      p.set(`/controls/engines/engine[${i}]/reverser`, false);
      p.set(`/engines/engine[${i}]/reverser-pos-norm`, 0);
      p.set(`/controls/failures/gear[${i}]/stuck`, false);
    }
    for (let i = 1; i <= 4; i++) p.set(`/controls/fuel/tank[${i}]/x-feed`, false);
    for (let i = 0; i < 4; i++) {
      p.set(`/systems/hydraulic/pressure[${i}]`, 0);
      p.set(`/controls/hydraulic/engine-pump[${i}]`, false);
      p.set(`/controls/hydraulic/demand-pump[${i}]`, 0);
    }
    // FlightGear's autopush (Nasal/Autopush): the flight model steers the
    // nose wheel from it while a tug is connected.
    p.set("/sim/model/autopush/connected", false);
    p.set("/sim/model/autopush/autopush-cmd-norm", 0);
  }

  /** After the FDM loads: fuel, scaled from the flight model's own load. */
  afterLoad(fuelFraction = 0.75) {
    const p = this.props;
    // systems.xml still uses JSBSim's old name for the simulation time.
    p.alias("sim-time-sec", "/fdm/jsbsim/simulation/sim-time-sec");
    const f = Math.max(0.25, Math.min(1, fuelFraction));
    for (let i = 0; i < 8; i++) {
      const lbs = p.get(`propulsion/tank[${i}]/contents-lbs`) * f;
      p.set(`propulsion/tank[${i}]/contents-lbs`, lbs);
      p.set(`/consumables/fuel/tank[${i}]/level-lbs`, lbs);
    }
  }

  init() {
    const p = this.props;
    this.starting = false;
    this.flashers = [
      new Flasher(p, "/sim/model/lights/beacon", [0.05, 1.2]),
      new Flasher(p, "/sim/model/lights/strobe", [0.05, 3]),
    ];
    // Hydraulics already pressurised on a running start.
    const running = p.getBool("/sim/presets/running");
    for (let i = 0; i < 4; i++) {
      this.pressure[i] = running ? HYD_PSI : 0;
      p.set(`/systems/hydraulic/pressure[${i}]`, this.pressure[i]);
    }
    this.lights(running);
  }

  /** A running start: fuel on, pumps on, the APU off again. */
  runningState() {
    const p = this.props;
    for (let i = 0; i < ENGINES; i++) {
      p.set(`/controls/engines/engine[${i}]/cutoff`, false);
      p.set(`/controls/engines/engine[${i}]/starter`, false);
    }
    this.pumps(true);
    for (let i = 0; i < 4; i++) p.set(`/systems/hydraulic/pressure[${i}]`, HYD_PSI);
  }

  pumps(on) {
    const p = this.props;
    for (let i = 0; i < 4; i++) {
      p.set(`/controls/hydraulic/engine-pump[${i}]`, on);
      p.set(`/controls/hydraulic/demand-pump[${i}]`, on ? 1 : 0);
    }
  }

  lights(on) {
    const p = this.props;
    for (const l of ["beacon", "nav", "logo", "strobe"]) p.set(`/controls/lighting/${l}`, on);
    p.set("/controls/lighting/taxi-lights", on);
    p.set("/sim/model/lights/beacon/enabled", on);
    p.set("/sim/model/lights/strobe/enabled", on);
  }

  get running() {
    for (let i = 0; i < ENGINES; i++) if (!this.props.getBool(`/engines/engine[${i}]/running`)) return false;
    return true;
  }

  /**
   * system.nas autostart(): APU, pumps and lights on, the four starters
   * spin the cores with the fuel off, and the fuel opens at 25% N2.
   */
  autostart() {
    if (this.running) return "Engines already running";
    const p = this.props;
    // JSBSim's turbines spin up on the starter only with the fuel cut off;
    // update() opens it at 25% N2.
    for (let i = 0; i <= APU; i++) {
      if (p.getBool(`/engines/engine[${i}]/running`)) continue;
      p.set(`/controls/engines/engine[${i}]/throttle`, 0);
      p.set(`/controls/engines/engine[${i}]/cutoff`, true);
      p.set(`/controls/engines/engine[${i}]/starter`, true);
    }
    this.pumps(true);
    this.lights(true);
    p.set("/controls/engines/con-ignition", true);
    this.starting = true;
    return "Autostart: APU on, starting engines 1-4...";
  }

  /** 's' key: the starters, held (fuel opens at 25% N2 while it is held). */
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

  update(dt) {
    const p = this.props;
    for (let i = 0; i <= APU; i++) {
      if (!p.getBool(`/controls/engines/engine[${i}]/starter`)) continue;
      if (p.get(`/engines/engine[${i}]/n2`) >= LIGHT_OFF_N2) p.set(`/controls/engines/engine[${i}]/cutoff`, false);
      if (p.getBool(`/engines/engine[${i}]/running`)) p.set(`/controls/engines/engine[${i}]/starter`, false);
    }
    if (this.starting && this.running) {
      this.starting = false;
      p.set("/controls/engines/con-ignition", false);
    }
    // 744_hyd.nas: an engine-driven pump with its engine running, or a
    // demand pump with power (APU or any engine), pressurises its system.
    const power = p.getBool(`/engines/engine[${APU}]/running`)
      || [0, 1, 2, 3].some((i) => p.getBool(`/engines/engine[${i}]/running`));
    for (let i = 0; i < 4; i++) {
      const edp = p.getBool(`/controls/hydraulic/engine-pump[${i}]`) && p.getBool(`/engines/engine[${i}]/running`);
      const adp = power && p.get(`/controls/hydraulic/demand-pump[${i}]`) > 0;
      const target = edp || adp ? HYD_PSI : 0;
      // Builds in about a second, decays over ten.
      const rate = target > this.pressure[i] ? 3000 : 300;
      this.pressure[i] += Math.max(-rate * dt, Math.min(rate * dt, target - this.pressure[i]));
      p.set(`/systems/hydraulic/pressure[${i}]`, Math.round(this.pressure[i]));
    }
    let fuel = 0;
    for (let i = 0; i < 8; i++) fuel += p.get(`propulsion/tank[${i}]/contents-lbs`);
    p.set("/consumables/fuel/total-fuel-lbs", fuel);
    for (const f of this.flashers) f.update(dt);
  }
}
