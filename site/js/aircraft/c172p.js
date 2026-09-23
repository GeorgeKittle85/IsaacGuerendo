// Aircraft-specific glue for FlightGear's Cessna 172P.
//
// On the desktop the c172p runs Nasal scripts (Aircraft/c172p/Nasal/*.nas)
// next to JSBSim and its property rules.  The rules run in our property-rule
// engine; the Nasal the flight model, cockpit and pilot depend on is ported
// here: electrical.nas, the engine management in engine.nas, set_fuel(),
// autostart() and the beacon/strobe flashers.

/** Properties the c172p's JSBSim systems read before any script has run. */
export const STARTUP_PROPERTIES = {
  "/engines/active-engine/killed": false,
  "/engines/active-engine/running": false,
  "/engines/active-engine/cranking": false,
  "/engines/active-engine/crashed": false,
  "/engines/active-engine/rpm": 0,
  "/engines/active-engine/egt-norm": 0,
  "/engines/active-engine/oil-temperature-degf": 60,
  "/engines/active-engine/low-oil-temperature-factor": 1,
  "/engines/active-engine/low-oil-pressure-factor": 1,
  "/engines/active-engine/already-started-in-session": false,
  "/engines/active-engine/ready-oil-press-checker": 0,
  "/engines/active-engine/volumetric-efficiency-factor": 0.85,
  "/engines/active-engine/carb_ice": 0,
  "/engines/active-engine/carb_icing_rate": 0,
  "/engines/active-engine/oil-temperature-env-diff": 0,
  "/engines/engine[0]/oil-temperature-degf": 60,
  "/engines/engine[1]/oil-temperature-degf": 60,
  "/engines/engine[0]/egt-norm": 0,
  "/engines/engine[1]/egt-norm": 0,
  "/controls/engines/current-engine/throttle": 0,
  "/controls/engines/current-engine/mixture": 0,
  "/controls/engines/current-engine/carb-heat": false,
  "/controls/engines/engine[0]/primer": 0,
  "/controls/engines/engine[0]/primer-lever": 0,
  "/controls/engines/engine[0]/use-primer": 0,
  "/controls/switches/magnetos": 0,
  "/controls/switches/starter": 0,
  "/controls/switches/master-bat": false,
  "/controls/switches/master-alt": false,
  "/controls/switches/master-avionics": false,
  "/systems/electrical/serviceable": true,
  "/systems/electrical/battery-charge-percent": 1,
  "/sim/model/c172p/securing/chock-visible": false,
  "/sim/model/c172p/hydraulics/hydraulic-pump": 0,
  "/systems/static[0]/pressure-inhg": 29.92,
  "/systems/static[1]/pressure-inhg": 29.92,
  "/systems/static-selected-source": 0,
  "/systems/pitot/icing": 0,
  "/environment/relative-humidity": 50,
  "/environment/dewpoint-degc": 5,
  "/environment/pressure-sea-level-inhg": 29.92,
  "ice/elevator": 0,
  "ice/stabilizer": 0,
  "ice/fuselage": 0,
  "ice/windshield": 0,
};

const BREAKERS = ["master", "flaps", "pitot-heat", "instr", "intlt", "navlt", "landing", "bcnlt",
  "strobe", "turn-coordinator", "radio1", "radio2", "radio3", "radio4", "radio5", "autopilot",
  "avionics-master"];

const THROTTLE_RATE = 0.33; // controls.nas

/** aircraft.light: flashes <node>/state following a [on, off, ...] pattern. */
class Flasher {
  constructor(props, node, pattern) {
    this.props = props;
    this.node = node;
    this.pattern = pattern;
    this.i = 0;
    this.t = 0;
    props.set(`${node}/enabled`, true);
    props.set(`${node}/state`, false);
  }

  update(dt) {
    if (!this.props.getBool(`${this.node}/enabled`)) {
      this.props.set(`${this.node}/state`, false);
      return;
    }
    this.t += dt;
    while (this.t >= this.pattern[this.i]) {
      this.t -= this.pattern[this.i];
      this.i = (this.i + 1) % this.pattern.length;
    }
    this.props.set(`${this.node}/state`, this.i % 2 === 0);
  }
}

export class C172P {
  constructor(props) {
    this.props = props;
    this.battery = { idealVolts: 24, ampHours: 13.36, chargeAmps: 7 };
    this.ammeterAve = 0;
    this.vbusVolts = 0;
    this.ebus1Volts = 0;
    this.oldFlap = 0;
    this.primerTimer = -1;
    this.engineTimer = 0;
    this.oilTimer = 0;
    this.hobbs = 0;
    this.autostartTimer = -1;
    this.flashers = [];
  }

  /** Before the FDM loads: properties its systems read at load time. */
  preInit() {
    const p = this.props;
    for (const [k, v] of Object.entries(STARTUP_PROPERTIES)) p.set(k, v);
    for (const i of [19, 20, 21, 22]) p.set(`/gear/gear[${i}]/wow`, false);
    for (const b of BREAKERS) p.set(`/controls/circuit-breakers/${b}`, true);
    p.set("/engines/active-engine/starter/serviceable", true);
    p.set("/engines/active-engine/starter/overheated", false);
    p.set("/instrumentation/nav[0]/power-btn", true);
    p.set("/instrumentation/nav[1]/power-btn", true);
    p.set("/instrumentation/adf[0]/power-btn", true);
    p.set("/instrumentation/dme[0]/power-btn", true);
    p.set("/autopilot/kap140/serviceable", true);
  }

  /** After the FDM loads, before initial conditions: fuel. */
  afterLoad(fuelFraction = 0.75) {
    this.setFuel(fuelFraction);
  }

  /** Port of c172p.nas set_fuel() plus tanks.nas. */
  setFuel(fraction) {
    const p = this.props;
    const capacityLbs = 129.43; // tanks 0/1 in c172p.xml
    const level = Math.max(0.25, Math.min(1, fraction)) * capacityLbs;
    for (let i = 0; i < 4; i++) {
      const selected = i < 2;
      const lbs = selected ? level : 0;
      p.set(`/consumables/fuel/tank[${i}]/selected`, selected);
      p.set(`propulsion/tank[${i}]/priority`, selected ? 1 : 0);
      p.set(`propulsion/tank[${i}]/contents-lbs`, lbs);
      p.set(`/consumables/fuel/tank[${i}]/level-lbs`, lbs);
    }
    p.set("/consumables/fuel/tank[4]/selected", true);
    // Prime the carburettor float chamber so a running start does not starve.
    p.set("propulsion/tank[4]/contents-lbs", 0.1);
  }

  /**
   * After the FDM is initialised.  (A running start's switch settings were
   * applied before the initial conditions; applying them again here would
   * undo the trim JSBSim just found.)
   */
  init() {
    this.flashers = [
      new Flasher(this.props, "/sim/model/c172p/lighting/strobes", [0.1, 1.3]),
      new Flasher(this.props, "/sim/model/c172p/lighting/beacon", [0.3, 1.3]),
    ];
  }

  /** Port of state-manager.nas / autostart(): a ready-to-fly aircraft. */
  runningState() {
    const p = this.props;
    const set = (k, v) => p.set(k, v);
    this.battery.full = true;
    set("/systems/electrical/battery-charge-percent", 1);
    set("/controls/engines/current-engine/mixture", p.get("/fdm/jsbsim/engine/auto-mixture") || 1);
    set("/controls/engines/current-engine/carb-heat", false);
    set("/engines/active-engine/running", true);
    set("/engines/active-engine/already-started-in-session", true);
    set("/controls/engines/engine[0]/primer", 3);
    set("/controls/switches/magnetos", 3);
    set("/controls/switches/master-bat", true);
    set("/controls/switches/master-alt", true);
    set("/controls/switches/master-avionics", true);
    set("/controls/lighting/beacon", true);
    set("/controls/lighting/nav-lights", true);
    set("/controls/lighting/strobe", true);
    set("/controls/gear/brake-parking", 0);
    set("/controls/flight/elevator-trim", 0);
    set("/controls/flight/rudder-trim", 0.02);
    set("/instrumentation/altimeter/setting-inhg", p.get("/environment/pressure-sea-level-inhg") || 29.92);
    for (const g of ["heading-indicator", "turn-indicator", "attitude-indicator"]) {
      set(`/instrumentation/${g}/spin`, 1);
    }
    const magvar = p.get("/environment/magnetic-variation-deg");
    set("/instrumentation/heading-indicator/align-deg", -magvar);
    set("/instrumentation/heading-indicator/offset-deg", 0);
    set("/sim/model/c172p/cockpit/control-lock-placed", false);
    for (const s of ["chock", "cowl-plugs-visible", "pitot-cover-visible", "tiedownL-visible",
      "tiedownR-visible", "tiedownT-visible"]) {
      set(`/sim/model/c172p/securing/${s}`, false);
    }
  }

  /**
   * The leaned mixture knob setting for a density altitude, from the c172p's
   * Systems/c172p-engine.xml "auto-engine-mixture" table.
   */
  autoMixture(densityAltFt) {
    const t = [[0, 1.0], [3000, 0.7], [6000, 0.5], [9000, 0.35], [12000, 0.3], [15000, 0.25]];
    if (densityAltFt <= t[0][0]) return t[0][1];
    for (let i = 1; i < t.length; i++) {
      if (densityAltFt <= t[i][0]) {
        const [x0, y0] = t[i - 1], [x1, y1] = t[i];
        return y0 + ((y1 - y0) * (densityAltFt - x0)) / (x1 - x0);
      }
    }
    return t[t.length - 1][1];
  }

  /** Port of c172p.nas autostart(): switches, primer, then crank for a few seconds. */
  autostart() {
    const p = this.props;
    if (p.getBool("/engines/active-engine/running")) return "Engine already running";
    this.resetBatteryAndBreakers();
    p.set("/controls/switches/magnetos", 3);
    p.set("/controls/engines/engine[0]/throttle", 0.2);
    p.set("/controls/engines/engine[1]/throttle", 0.2);
    p.set("/controls/engines/current-engine/mixture", p.get("/fdm/jsbsim/engine/auto-mixture") || 1);
    p.set("/controls/switches/master-bat", true);
    p.set("/controls/switches/master-alt", true);
    p.set("/controls/switches/master-avionics", true);
    p.set("/controls/lighting/nav-lights", true);
    p.set("/controls/lighting/strobe", true);
    p.set("/controls/lighting/beacon", true);
    p.set("/controls/flight/flaps", 0);
    p.set("/controls/gear/brake-parking", 0);
    p.set("/controls/engines/engine[0]/primer-lever", 0);
    p.set("/controls/engines/engine[0]/primer", 3);
    this.setStarter(true);
    p.set("/engines/active-engine/auto-start", true);
    this.autostartTimer = 5;
    return "Starting engine...";
  }

  resetBatteryAndBreakers() {
    this.props.set("/systems/electrical/battery-charge-percent", 1);
    for (const b of BREAKERS) this.props.set(`/controls/circuit-breakers/${b}`, true);
  }

  // ---------------------------------------------------------------- controls

  /** controls.adjMixture override: moves the single mixture knob. */
  adjustMixture(dir, dt) {
    const p = this.props;
    const v = p.get("/controls/engines/current-engine/mixture") + dir * THROTTLE_RATE * dt;
    p.set("/controls/engines/current-engine/mixture", Math.max(0, Math.min(1, v)));
  }

  /** controls.stepMagnetos override: the key switch OFF/R/L/BOTH. */
  stepMagnetos(change) {
    const p = this.props;
    const v = Math.max(0, Math.min(3, p.get("/controls/switches/magnetos") + change));
    p.set("/controls/switches/magnetos", v);
  }

  /** controls.startEngine override ('s' key). */
  setStarter(on) {
    const p = this.props;
    if (on) {
      if (p.getBool("/engines/active-engine/running")) {
        p.set("/controls/switches/starter", false);
        return;
      }
      p.set("/controls/switches/magnetos", 3);
      p.set("/controls/switches/starter", true);
      p.set("/controls/engines/engine[0]/use-primer", 1);
      this.primerTimer = -1;
    } else if (p.getBool("/controls/switches/starter")) {
      p.set("/controls/switches/starter", false);
      this.primerTimer = 5; // primer mixture lasts 5 s after releasing the starter
    }
  }

  pumpPrimer() {
    const p = this.props;
    if (p.getBool("/controls/engines/engine[0]/primer-lever")) {
      p.set("/controls/engines/engine[0]/primer", p.get("/controls/engines/engine[0]/primer") + 1);
      p.set("/controls/engines/engine[0]/primer-lever", 0);
    } else {
      p.set("/controls/engines/engine[0]/primer-lever", 1);
    }
  }

  // ------------------------------------------------------------------ update

  update(dt) {
    this.updateElectrical(dt);
    for (const f of this.flashers) f.update(dt);

    const p = this.props;
    if (this.primerTimer >= 0) {
      this.primerTimer -= dt;
      if (this.primerTimer < 0) {
        p.set("/controls/engines/engine[0]/use-primer", 0);
        p.set("/controls/engines/engine[0]/primer", 0);
      }
    }
    if (this.autostartTimer >= 0) {
      this.autostartTimer -= dt;
      if (this.autostartTimer < 0 || p.getBool("/engines/active-engine/running")) {
        this.setStarter(false);
        p.set("/engines/active-engine/auto-start", false);
        this.autostartTimer = -1;
      }
    }

    // engine.nas update() at 0.3 s
    this.engineTimer += dt;
    if (this.engineTimer >= 0.3) {
      this.engineTimer = 0;
      const rpm = p.get("/engines/active-engine/rpm");
      if (rpm < 900 && p.getBool("/controls/switches/starter")) p.set("/engines/active-engine/ready-oil-press-checker", 1);
      if (p.get("/engines/active-engine/ready-oil-press-checker") === 1 && rpm > 900) {
        p.set("/engines/active-engine/ready-oil-press-checker", 2);
      }
      if (p.getBool("/engines/active-engine/running")) p.set("/engines/active-engine/already-started-in-session", true);
    }

    // Oil level constant unless consumption is enabled (engine.nas oil_consumption).
    this.oilTimer += dt;
    if (this.oilTimer >= 1) {
      this.oilTimer = 0;
      const full = p.get("/controls/engines/active-engine") === 1 ? 8 : 7;
      p.set("/engines/active-engine/oil-level", full);
      p.set("/engines/active-engine/low-oil-pressure-factor", 1);
      p.set("/engines/active-engine/low-oil-temperature-factor", 1);
      // calculate_real_oiltemp: cold engine reads the outside air temperature.
      if (!p.getBool("/engines/active-engine/already-started-in-session")) {
        const env = p.get("/environment/temperature-degf") || 60;
        const oil = p.get("/engines/active-engine/oil-temperature-degf") || 60;
        p.set("/engines/active-engine/oil-temperature-env-diff", oil - env);
      } else {
        const d = p.get("/engines/active-engine/oil-temperature-env-diff");
        p.set("/engines/active-engine/oil-temperature-env-diff", Math.abs(d) < 0.5 ? 0 : d * 0.99);
      }
    }

    // Hobbs meter digits (engine.nas update_hobbs_meter).
    if (p.getBool("/engines/active-engine/running")) this.hobbs += dt;
    const hours = this.hobbs / 3600 + (p.get("/sim/time/hobbs/engine[0]") || 0) / 3600;
    p.set("/instrumentation/hobbs-meter/digits0", Math.floor(hours * 10) % 10);
    p.set("/instrumentation/hobbs-meter/digits1", Math.floor(hours) % 10);
    p.set("/instrumentation/hobbs-meter/digits2", Math.floor(hours / 10) % 10);
    p.set("/instrumentation/hobbs-meter/digits3", Math.floor(hours / 100) % 10);
    p.set("/instrumentation/hobbs-meter/digits4", Math.floor(hours / 1000) % 10);
  }

  // Port of electrical.nas (BatteryClass, AlternatorClass, update_virtual_bus).
  batteryVolts(charge) {
    const x = 1 - charge;
    const tmp = -(3 * x - 1);
    return this.battery.idealVolts * ((tmp ** 5 + 32) / 32);
  }

  applyBatteryLoad(amps, dt) {
    const p = this.props;
    const old = p.get("/systems/electrical/battery-charge-percent");
    const cap = this.battery.ampHours * (p.get("/systems/electrical/battery-capacity-factor") || 1);
    const used = (amps * dt) / 3600 / cap;
    p.set("/systems/electrical/battery-charge-percent", Math.max(0, Math.min(1, old - used)));
  }

  updateElectrical(dt) {
    const p = this.props;
    const set = (k, v) => p.set(k, v);
    const on = (k) => p.getBool(k);
    const serviceable = on("/systems/electrical/serviceable");
    const charge = p.get("/systems/electrical/battery-charge-percent");
    const rpm = p.get("/engines/active-engine/rpm");
    const altFactor = Math.min(1, rpm / 800);
    const batteryVolts = serviceable ? this.batteryVolts(charge) : 0;
    const altVolts = serviceable ? 28 * altFactor : 0;
    const masterBat = on("/controls/switches/master-bat");
    const masterAlt = on("/controls/switches/master-alt");
    const external = on("/controls/electric/external-power") ? 28 : 0;

    let busVolts = 0;
    let source = null;
    if (masterBat) { busVolts = batteryVolts; source = "battery"; }
    if (masterAlt && altVolts > busVolts) { busVolts = altVolts; source = "alternator"; }
    if (external > busVolts) { busVolts = external; source = "external"; }

    this.vbusVolts = busVolts > 12 ? busVolts : 0;
    const draw = this.electricalBus1() + this.avionicsBus1();
    const load = busVolts ? draw / busVolts : 0;
    if (load > 330) set("/controls/circuit-breakers/master", false);

    let ammeter = 0;
    if (source === "battery") {
      this.applyBatteryLoad(load, dt);
      ammeter = -load;
    } else if (masterBat && charge >= 1) {
      if (load < 20) ammeter = 3;
    } else if (busVolts > batteryVolts && masterBat && charge < 1) {
      this.applyBatteryLoad(-this.battery.chargeAmps, dt);
      ammeter = this.battery.chargeAmps;
    }
    this.ammeterAve = 0.8 * this.ammeterAve + 0.2 * ammeter;
    set("/systems/electrical/amps", this.ammeterAve);
    set("/systems/electrical/volts", busVolts);
  }

  electricalBus1() {
    const p = this.props;
    const set = (k, v) => p.set(k, v);
    const on = (k) => p.getBool(k);
    const bus = on("/controls/circuit-breakers/master") ? this.vbusVolts : 0;
    let load = 0;
    const out = (name, powered, amps = 0) => {
      set(`/systems/electrical/outputs/${name}`, powered ? bus : 0);
      if (powered) load += amps * bus;
    };
    out("flaps", on("/controls/circuit-breakers/flaps"));
    const flap = p.get("/surface-positions/flap-pos-norm");
    if (flap !== this.oldFlap) {
      this.oldFlap = flap;
      if (p.get("/systems/electrical/outputs/flaps") > 12) load += 4.5 * bus;
    }
    out("pitot-heat", on("/controls/anti-ice/pitot-heat"), 5);
    const instr = on("/controls/circuit-breakers/instr");
    set("/systems/electrical/outputs/instr-ignition-switch", instr ? bus : 0);
    const starterOk = instr && bus > 12 && on("/controls/switches/starter")
      && on("/engines/active-engine/starter/serviceable") && !on("/engines/active-engine/starter/overheated");
    set("/systems/electrical/outputs/starter", starterOk ? bus : 0);
    const intlt = on("/controls/circuit-breakers/intlt");
    set("/systems/electrical/outputs/cabin-lights", intlt ? bus : 0);
    if (intlt) load += 5 * p.get("/controls/lighting/instruments-norm") * bus;
    set("/systems/electrical/outputs/instrument-lights", intlt ? bus : 0);
    out("landing-lights", on("/controls/circuit-breakers/landing") && on("/controls/lighting/landing-lights"), 14.5);
    out("taxi-light", on("/controls/circuit-breakers/landing") && on("/controls/lighting/taxi-light"), 14.5);
    out("beacon", on("/controls/circuit-breakers/bcnlt") && on("/controls/lighting/beacon"), 4.5);
    out("nav-lights", on("/controls/circuit-breakers/navlt") && on("/controls/lighting/nav-lights"), 5);
    const strobe = on("/controls/circuit-breakers/strobe") && on("/controls/lighting/strobe");
    out("strobe", strobe, 5);
    set("/systems/electrical/outputs/strobe-norm", strobe ? bus / 24 : 0);
    out("turn-coordinator", on("/controls/circuit-breakers/turn-coordinator"), 14);
    out("gear-select", on("/controls/circuit-breakers/gear-select"), 5);
    out("gear-advisory", on("/controls/circuit-breakers/gear-advisory"));
    out("hydraulic-pump", on("/controls/circuit-breakers/hydraulic-pump"));
    const fan = bus > 12 && on("/controls/circuit-breakers/strobe");
    set("/systems/electrical/outputs/avionics-fan[0]", fan ? bus : 0);
    if (fan) load += bus / 28;
    this.ebus1Volts = bus;
    return load;
  }

  avionicsBus1() {
    const p = this.props;
    const set = (k, v) => p.set(k, v);
    const on = (k) => p.getBool(k);
    const bus = on("/controls/switches/master-avionics") ? this.ebus1Volts : 0;
    let load = 0;
    const radio1 = on("/controls/circuit-breakers/radio1");
    set("/systems/electrical/outputs/audio-panel[0]", radio1 ? bus : 0);
    set("/instrumentation/audio-panel[0]/operable", radio1);
    if (radio1) load += 5 * bus;
    for (const [i, brk] of [[0, "radio2"], [1, "radio3"]]) {
      const pw = on(`/controls/circuit-breakers/${brk}`) && on(`/instrumentation/nav[${i}]/power-btn`);
      set(`/systems/electrical/outputs/nav[${i}]`, pw ? bus : 0);
      set(`/systems/electrical/outputs/comm[${i}]`, pw ? bus : 0);
      if (pw) load += 5 * bus;
    }
    const xpdr = on("/controls/circuit-breakers/radio4") && p.get("/instrumentation/transponder/inputs/knob-mode") > 0;
    set("/systems/electrical/outputs/transponder", xpdr ? bus : 0);
    const r5 = on("/controls/circuit-breakers/radio5");
    set("/systems/electrical/outputs/adf", r5 && on("/instrumentation/adf[0]/power-btn") ? bus : 0);
    set("/systems/electrical/outputs/dme", r5 && on("/instrumentation/dme[0]/power-btn") ? bus : 0);
    const ap = on("/controls/circuit-breakers/autopilot") && on("/autopilot/kap140/serviceable");
    set("/systems/electrical/outputs/autopilot", ap ? bus : 0);
    if (ap) load += 5 * bus;
    return load;
  }
}
