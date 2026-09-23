// Ports of FlightGear's C++ systems and instruments (src/Systems/*.cxx,
// src/Instrumentation/*.cxx) that the c172p's cockpit gauges read.  They are
// configured from the aircraft's Systems/systems.xml and
// Systems/instrumentation.xml, exactly as in FlightGear.

import { absPath } from "../props/sgexpr.js";

const INHG_TO_PA = 3386.388640341;
const P0_PA = 101325;
const RHO0 = 1.225;
const MPS_TO_KT = 1.9438444924406;
const T0_K = 288.15;
const GAMMA = 1.4;
const R_AIR = 287.0529;
const CP_AIR = (GAMMA / (GAMMA - 1)) * R_AIR;
const SLUGFT3_TO_KGPM3 = 515.3788;
const FPS_TO_KT = 0.5924838012958963;
const FT_TO_M = 0.3048;
const D2R = Math.PI / 180;

/** fgGetLowPass from FlightGear's util.cxx. */
export function lowPass(current, target, timeratio) {
  if (timeratio < 0) {
    if (timeratio < -1) return target;
    return target * -timeratio + current * (1 + timeratio);
  }
  if (timeratio < 1) return timeratio * target + (1 - timeratio) * current;
  return target;
}

const periodic = (lo, hi, v) => {
  const r = hi - lo;
  return lo + ((((v - lo) % r) + r) % r);
};

/** Pressure altitude (ISA troposphere) and Kollsman offset, as SGAltimeter. */
const pressAltFt = (inhg) => (1 - Math.pow(inhg / 29.92126, 0.190263)) * 145442.156;

class Gyro {
  constructor() {
    this.serviceable = true;
    this.power = 0;
    this.spin = 0;
    this.spinUp = 4;
    this.spinDown = 180;
  }

  update(dt) {
    const decay = (1 / this.spinDown) * dt;
    this.spin -= decay;
    if (this.serviceable) {
      const step = decay + (1 / this.spinUp) * this.power * dt;
      if (this.spin + step <= this.power) this.spin += step;
    } else {
      this.spin = 0;
    }
    this.spin = Math.max(0, Math.min(1, this.spin));
  }
}

class Base {
  constructor(props, cfg, defName) {
    this.props = props;
    this.cfg = cfg;
    this.name = cfg.getStringValue("name", defName).trim() || defName;
    this.num = cfg.getIntValue("number", 0);
    this.root = `/${this.kind ?? "instrumentation"}/${this.name}${this.num ? `[${this.num}]` : ""}`;
    this.n = (rel) => props.node(`${this.root}/${rel}`);
    this.abs = (path, def) => props.node(absPath(cfg.getStringValue(path, def) || def));
  }

  /** "serviceable" defaults to true in FlightGear's instrument XML. */
  initServiceable() {
    const s = this.n("serviceable");
    const path = `${this.root}/serviceable`;
    if (this.props.jsb.handle(path, false) < 0 || this.props.getString(path) === "") s.set(true);
    return s;
  }
}

// ------------------------------------------------------------------ systems

class PitotSystem extends Base {
  get kind() { return "systems"; }
  constructor(props, cfg) {
    super(props, cfg, "pitot");
    this.serviceable = this.initServiceable();
    const stall = cfg.getDoubleValue("stall-deg", 60);
    this.stallFactor = Math.cos(Math.min(90, Math.abs(stall)) * D2R);
    this.p = props.node("/environment/pressure-inhg");
    this.mach = props.node("/velocities/mach");
    this.alpha = props.node("/orientation/alpha-deg");
    this.beta = props.node("/orientation/side-slip-deg");
    this.total = this.n("total-pressure-inhg");
    this.measured = this.n("measured-total-pressure-inhg");
  }

  update() {
    if (!this.serviceable.getBool()) return;
    const p = this.p.get();
    const m = this.mach.get();
    const x = Math.cos(this.alpha.get() * D2R) * Math.abs(Math.cos(this.beta.get() * D2R));
    let pt = p;
    if (x > this.stallFactor) pt = p * Math.pow(1 + 0.2 * m * m * x * x, 3.5);
    this.total.set(pt);
    this.measured.set(pt);
  }
}

class StaticSystem extends Base {
  get kind() { return "systems"; }
  constructor(props, cfg) {
    super(props, cfg, "static");
    this.serviceable = this.initServiceable();
    this.tau = cfg.getDoubleValue("tau", 1);
    this.type = cfg.getIntValue("type", 0);
    this.errorFactor = Math.max(0, Math.min(1, cfg.getDoubleValue("error-factor", 0)));
    this.pin = props.node("/environment/pressure-inhg");
    this.out = this.n("pressure-inhg");
    this.alpha = props.node("/orientation/alpha-deg");
    this.beta = props.node("/orientation/side-slip-deg");
    this.mach = props.node("/velocities/mach");
    this.out.set(this.pin.get());
  }

  update(dt) {
    if (!this.serviceable.getBool()) return;
    let pNew = this.pin.get();
    let proj = 0;
    if (this.type === 1) proj = Math.sin(this.beta.get() * D2R);
    if (this.type === 2) {
      const a = this.alpha.get() * D2R;
      const b = this.beta.get() * D2R;
      proj = Math.sqrt(1 - Math.cos(b) ** 2 * Math.cos(a) ** 2);
    }
    if (this.type === 1 || this.type === 2) {
      const m = this.mach.get();
      const pt = pNew * Math.pow(1 + 0.2 * m * m * proj * proj, 3.5);
      pNew += (pt - pNew) * this.errorFactor;
    }
    this.out.set(this.tau > 0 ? lowPass(this.out.get(), pNew, dt / this.tau) : pNew);
  }
}

class VacuumSystem extends Base {
  get kind() { return "systems"; }
  constructor(props, cfg) {
    super(props, cfg, "vacuum");
    this.serviceable = this.initServiceable();
    this.rpms = cfg.getChildren("rpm").map((r) => props.node(absPath(r.getStringValue())));
    this.scale = cfg.getDoubleValue("scale", 1);
    this.p = props.node("/environment/pressure-inhg");
    this.suction = this.n("suction-inhg");
  }

  update() {
    let suction = 0;
    if (this.serviceable.getBool()) {
      let rpm = 0;
      for (const r of this.rpms) rpm = Math.max(rpm, r.get() * this.scale);
      suction = (this.p.get() * rpm) / (rpm + 4875);
      const max = rpm > 0 ? 5.39 - 1 / (rpm * 0.00111) : 0;
      suction = Math.max(0, Math.min(max, suction));
    }
    this.suction.set(suction);
  }
}

// -------------------------------------------------------------- instruments

class AirspeedIndicator extends Base {
  constructor(props, cfg) {
    super(props, cfg, "airspeed-indicator");
    this.serviceable = this.initServiceable();
    this.pt = this.abs("total-pressure", "/systems/pitot/total-pressure-inhg");
    this.ps = this.abs("static-pressure", "/systems/static/pressure-inhg");
    this.rho = props.node("/environment/density-slugft3");
    this.tc = props.node("/environment/temperature-degc");
    this.speed = this.n("indicated-speed-kt");
    this.tas = this.n("true-speed-kt");
    this.machOut = this.n("indicated-mach");
  }

  update(dt) {
    if (!this.serviceable.getBool()) return;
    const pt = this.pt.get();
    const p = this.ps.get();
    const qc = Math.max(0, (pt - p) * INHG_TO_PA);
    const vcal = Math.sqrt(7 * (P0_PA / RHO0) * (Math.pow(1 + qc / P0_PA, 1 / 3.5) - 1));
    this.speed.set(lowPass(this.speed.get(), vcal * MPS_TO_KT, dt * 50));
    const oatK = Math.max(0.001, this.tc.get() + T0_K - 15);
    const c = Math.sqrt(GAMMA * R_AIR * oatK);
    const pPa = Math.max(0.001, p * INHG_TO_PA);
    const ptPa = Math.max(pt * INHG_TO_PA, pPa);
    const rho = Math.max(0.001, this.rho.get() * SLUGFT3_TO_KGPM3);
    const vt = Math.sqrt(7 * (pPa / rho) * (Math.pow(1 + (ptPa - pPa) / pPa, 1 / 3.5) - 1));
    this.machOut.set(vt / c);
    this.tas.set(vt * MPS_TO_KT);
  }
}

class Altimeter extends Base {
  constructor(props, cfg) {
    super(props, cfg, "altimeter");
    this.serviceable = this.initServiceable();
    this.p = this.abs("static-pressure", "/systems/static/pressure-inhg");
    this.tau = cfg.getDoubleValue("tau", 0.1);
    this.quantum = cfg.getDoubleValue("quantum", 0);
    this.setting = this.n("setting-inhg");
    this.settingHpa = this.n("setting-hpa");
    if (!(this.setting.get() > 20)) this.setting.set(29.92126);
    this.lastSetting = this.setting.get();
    this.lastHpa = this.settingHpa.get();
    this.pressAlt = this.n("pressure-alt-ft");
    this.modeC = this.n("mode-c-alt-ft");
    this.indicated = this.n("indicated-altitude-ft");
    this.rawPA = pressAltFt(this.p.get() || 29.92);
    this.kollsman = pressAltFt(this.setting.get());
  }

  update(dt) {
    if (!this.serviceable.getBool()) return;
    // setting-inhg and setting-hpa are tied together in FlightGear.
    const s = this.setting.get();
    const h = this.settingHpa.get();
    if (h !== this.lastHpa && s === this.lastSetting) this.setting.set((h * 100) / INHG_TO_PA);
    const setting = this.setting.get();
    this.settingHpa.set((setting * INHG_TO_PA) / 100);
    this.lastSetting = setting;
    this.lastHpa = this.settingHpa.get();

    const trat = this.tau > 0 ? dt / this.tau : 100;
    this.rawPA = lowPass(this.rawPA, pressAltFt(this.p.get()), trat);
    this.modeC.set(100 * Math.round(this.rawPA / 100));
    this.kollsman = lowPass(this.kollsman, pressAltFt(setting), trat);
    const pa = this.quantum ? this.quantum * Math.round(this.rawPA / this.quantum) : this.rawPA;
    this.pressAlt.set(pa);
    this.indicated.set(pa - this.kollsman);
  }
}

class AttitudeIndicator extends Base {
  constructor(props, cfg) {
    super(props, cfg, "attitude-indicator");
    this.gyro = new Gyro();
    this.pitchIn = props.node("/orientation/pitch-deg");
    this.rollIn = props.node("/orientation/roll-deg");
    this.suction = this.abs("suction", "/systems/vacuum/suction-inhg");
    const limits = cfg.getChild("limits") ?? cfg.getChild("config");
    this.spinThresh = limits ? limits.getDoubleValue("spin-thresh", 0.8) : 0.8;
    this.maxRollErr = limits ? limits.getDoubleValue("max-roll-error-deg", 40) : 40;
    this.maxPitchErr = limits ? limits.getDoubleValue("max-pitch-error-deg", 12) : 12;
    this.spinUp = cfg.getDoubleValue("gyro/spin-up-sec", 4);
    this.spinDown = cfg.getDoubleValue("gyro/spin-down-sec", 180);
    this.minVacuum = cfg.getDoubleValue("minimum-vacuum", 4);
    this.spin = this.n("spin");
    this.caged = this.n("caged-flag");
    this.tumbleFlag = this.n("config/tumble-flag");
    this.tumble = this.n("tumble-norm");
    this.pitchInt = this.n("internal-pitch-deg");
    this.rollInt = this.n("internal-roll-deg");
    this.pitchOut = this.n("indicated-pitch-deg");
    this.rollOut = this.n("indicated-roll-deg");
    this.serviceable = this.initServiceable();
  }

  update(dt) {
    const g = this.gyro;
    g.serviceable = this.serviceable.getBool();
    g.power = this.suction.get() / this.minVacuum;
    g.spinUp = this.spinUp;
    g.spinDown = this.spinDown;
    g.spin = this.spin.get();
    g.update(dt);
    const spin = g.spin;
    this.spin.set(spin);
    const resp = spin ** 6;
    let roll = this.rollIn.get();
    let pitch = this.pitchIn.get();
    if (this.tumbleFlag.getBool()) {
      let tumble = this.tumble.get();
      if (Math.abs(roll) > 45) {
        let target = ((Math.abs(roll) - 45) / 45) ** 2;
        if (roll < 0) target = -target;
        if (Math.abs(target) > Math.abs(tumble)) tumble = target;
        tumble = Math.max(-1, Math.min(1, tumble));
      }
      const step = dt / (this.caged.getBool() ? 1 : 300);
      if (tumble < -step) tumble += step;
      else if (tumble > step) tumble -= step;
      roll += tumble * 45;
      this.tumble.set(tumble);
    }
    if (this.caged.getBool()) {
      this.rollInt.set(0);
      this.pitchInt.set(0);
      return;
    }
    roll = lowPass(this.rollInt.get(), roll, resp);
    pitch = lowPass(this.pitchInt.get(), pitch, resp);
    this.rollInt.set(roll);
    this.pitchInt.set(pitch);
    let rollErr = 0;
    let pitchErr = 0;
    if (spin <= this.spinThresh) {
      const f = (this.spinThresh - spin) / this.spinThresh;
      rollErr = f * f * this.maxRollErr;
      pitchErr = f * f * this.maxPitchErr;
    }
    this.rollOut.set(roll + rollErr);
    this.pitchOut.set(pitch + pitchErr);
  }
}

class HeadingIndicatorDG extends Base {
  constructor(props, cfg) {
    super(props, cfg, "heading-indicator-dg");
    this.gyro = new Gyro();
    this.vacuumDriven = cfg.hasChild("suction");
    this.suction = this.abs("suction", "/systems/vacuum/suction-inhg");
    this.minVacuum = cfg.getDoubleValue("minimum-vacuum", 4);
    this.minSpin = cfg.getDoubleValue("gyro/minimum-spin-norm", 0.8);
    this.spinUp = cfg.getDoubleValue("gyro/spin-up-sec", 4);
    this.spinDown = cfg.getDoubleValue("gyro/spin-down-sec", 180);
    const lim = (n, d) => cfg.getDoubleValue(`limits/${n}`, d);
    this.yawLimit = lim("yaw-limit-rate", 11.5);
    this.yawErrFactor = lim("yaw-error-factor", 0.033);
    this.gLower = lim("g-limit-lower", -0.5);
    this.gUpper = lim("g-limit-upper", 1.5);
    this.gErrFactor = lim("g-error-factor", 0.033);
    this.gTumble = lim("g-limit-tumble-factor", 1.5);
    this.headingIn = props.node("/orientation/heading-deg");
    this.yawRate = props.node("/orientation/yaw-rate-degps");
    this.g = props.node("/accelerations/pilot-g");
    this.eastSpeed = props.node("/velocities/speed-east-fps");
    this.lat = props.node("/position/latitude-deg");
    this.offset = this.n("offset-deg");
    this.align = this.n("align-deg");
    this.error = this.n("error-deg");
    this.spin = this.n("spin");
    this.caged = this.n("caged-flag");
    this.latNut = this.n("latitude-nut-setting");
    this.tumbleFlag = this.n("tumble-flag");
    this.tumble = this.n("tumble-norm");
    this.out = this.n("indicated-heading-deg");
    this.bugErr = this.n("heading-bug-error-deg");
    this.nav1Err = this.n("nav1-error-deg");
    this.power = props.node(`/systems/electrical/outputs/${this.name}`);
    this.serviceable = this.initServiceable();
    this.lastHeading = this.headingIn.get();
    this.lastIndicated = this.headingIn.get();
    this.gyroLag = 0;
    this.lastG = 1;
    this.latNut.set(this.lat.get());
  }

  update(dt) {
    const g = this.gyro;
    g.serviceable = this.serviceable.getBool();
    g.power = this.vacuumDriven ? (g.serviceable ? this.suction.get() / this.minVacuum : 0) : (g.serviceable ? 1 : 0);
    g.spinUp = this.spinUp;
    g.spinDown = this.spinDown;
    g.spin = this.spin.get();
    g.update(dt);
    const spin = g.spin;
    let heading = this.headingIn.get();
    let offset = this.offset.get();
    const caged = this.caged.getBool();
    this.spin.set(spin);
    const factor = caged ? 0 : spin ** 6;
    const latRad = this.lat.get() * D2R;
    let drift = -15 * Math.sin(latRad) + 15 * Math.sin(this.latNut.get() * D2R);
    drift *= factor;
    offset += (drift / 3600) * dt;
    const wander = -FPS_TO_KT * this.eastSpeed.get() * (Math.tan(latRad) / 60) * factor;
    offset += (wander / 3600) * dt;
    if (spin < this.minSpin || caged) {
      const diff = periodic(-180, 180, this.lastHeading - heading);
      offset += diff * (1 - factor) * dt;
      if (caged && this.gyroLag === 0) this.gyroLag = heading;
    }
    this.lastHeading = heading;
    if (!caged && this.gyroLag !== 0) {
      offset += this.gyroLag - heading;
      this.gyroLag = 0;
    }
    offset = periodic(-180, 180, offset);
    this.offset.set(offset);
    let error = this.error.get();
    const yaw = this.yawRate.get();
    if (Math.abs(yaw) > this.yawLimit) error += this.yawErrFactor * -yaw * dt * factor;
    const gv = this.g.get();
    this.lastG = gv;
    if (gv > this.gUpper || gv < this.gLower) error += this.gErrFactor * gv * dt * factor;
    let exceed = 0;
    if (gv < this.gLower * this.gTumble) exceed = gv / (this.gLower * this.gTumble);
    if (gv > this.gUpper * this.gTumble) exceed = gv / (this.gUpper * this.gTumble);
    if (exceed > 0 && !caged) this.tumbleFlag.set(true);
    if (this.tumbleFlag.getBool()) {
      let tumble = Math.max(this.tumble.get(), exceed / 2);
      tumble = Math.max(-1, Math.min(1, tumble));
      const step = dt / (caged ? 1 : 300);
      if (tumble < -step) tumble += step;
      else if (tumble > step) tumble -= step;
      if (Math.abs(tumble) < 0.01) {
        tumble = 0;
        this.tumbleFlag.set(false);
      }
      error += tumble * 720 * dt;
      this.tumble.set(tumble);
    }
    error = periodic(-180, 180, error);
    this.error.set(error);
    const d = periodic(-180, 180, heading - this.lastIndicated);
    heading = this.lastIndicated + d * Math.min(1, dt * 100 * factor);
    this.lastIndicated = heading;
    heading = periodic(0, 360, heading + offset + this.align.get() + error);
    this.out.set(heading);
    this.bugErr.set(periodic(-180, 180, this.props.get("/autopilot/settings/heading-bug-deg") - heading));
    this.nav1Err.set(periodic(-180, 180, this.props.get("/instrumentation/nav/radials/selected-deg") - heading));
  }
}

class TurnIndicator extends Base {
  constructor(props, cfg) {
    super(props, cfg, "turn-indicator");
    this.gyro = new Gyro();
    this.rollRate = props.node("/orientation/roll-rate-degps");
    this.yawRate = props.node("/orientation/yaw-rate-degps");
    this.rate = this.n("indicated-turn-rate");
    this.spin = this.n("spin");
    this.spinUp = cfg.getDoubleValue("gyro/spin-up-sec", 4);
    this.spinDown = cfg.getDoubleValue("gyro/spin-down-sec", 180);
    this.serviceable = this.initServiceable();
    // TurnIndicator's default supply, see turn_indicator.cxx / AbstractInstrument.
    this.power = props.node(absPath(cfg.getStringValue("power-supply", "/systems/electrical/outputs/turn-coordinator")));
    this.minVolts = cfg.getDoubleValue("minimum-supply-volts", 1);
    this.last = 0;
  }

  update(dt) {
    const g = this.gyro;
    g.power = this.serviceable.getBool() && this.power.get() >= this.minVolts ? 1 : 0;
    g.spinUp = this.spinUp;
    g.spinDown = this.spinDown;
    g.spin = this.spin.get();
    g.update(dt);
    const spin = g.spin;
    this.spin.set(spin);
    const factor = 1 - (1 - spin) ** 3;
    let rate = this.rollRate.get() / 20 + this.yawRate.get() / 3;
    rate = Math.max(-2.5, Math.min(2.5, rate));
    rate = -2.5 + factor * (rate + 2.5);
    rate = lowPass(this.last, rate, dt * 0.5);
    this.last = rate;
    this.rate.set(rate);
  }
}

class SlipSkidBall extends Base {
  constructor(props, cfg) {
    super(props, cfg, "slip-skid-ball");
    this.serviceable = this.initServiceable();
    this.ya = props.node("/accelerations/pilot/y-accel-fps_sec");
    this.za = props.node("/accelerations/pilot/z-accel-fps_sec");
    this.out = this.n("indicated-slip-skid");
    this.override = this.n("override");
  }

  update(dt) {
    if (!this.serviceable.getBool() || this.override.getBool()) return;
    const d = Math.max(1, -this.za.get());
    const pos = (this.ya.get() / d) * 10;
    this.out.set(lowPass(this.out.get(), pos, dt));
  }
}

class VerticalSpeedIndicator extends Base {
  constructor(props, cfg) {
    super(props, cfg, "vertical-speed-indicator");
    this.serviceable = this.initServiceable();
    this.p = this.abs("static-pressure", "/systems/static/pressure-inhg");
    this.t = this.abs("static-temperature", "/environment/temperature-degc");
    this.fpm = this.n("indicated-speed-fpm");
    this.mps = this.n("indicated-speed-mps");
    this.kts = this.n("indicated-speed-kts");
    this.reinit();
  }

  reinit() {
    this.casingP = this.p.get() * INHG_TO_PA;
    const tK = this.t.get() + 273.15;
    this.casingRho = this.casingP / (tK * R_AIR);
    this.casingMass = this.casingRho * 1.25e-4;
    this.massflow = 0;
  }

  update(dt) {
    if (!this.serviceable.getBool()) return;
    const pPa = this.p.get() * INHG_TO_PA;
    if (this.casingP < 1e-3) {
      if (pPa > 1e3) this.reinit();
      else return;
    }
    const VOL = 1.25e-4;
    const AREA = 7.853982e-9;
    this.casingMass -= this.massflow * dt;
    const rho = this.casingMass / VOL;
    this.casingP *= Math.pow(rho / this.casingRho, GAMMA);
    const tK = this.casingP / (rho * R_AIR);
    const sign = this.casingP - pPa > 0 ? 1 : -1;
    const mach = Math.abs(this.casingP - pPa) < 0.01 ? 0
      : Math.sqrt(Math.abs(((2 * CP_AIR) / (GAMMA * R_AIR)) * (Math.pow(pPa / this.casingP, (GAMMA - 1) / GAMMA) - 1)));
    this.massflow = ((sign * this.casingP) / Math.sqrt(tK)) * Math.sqrt(GAMMA / R_AIR) * mach
      * Math.pow(1 + ((GAMMA - 1) / 2) * mach * mach, -(GAMMA + 1) / (2 * (GAMMA - 1))) * AREA;
    const vs = sign * Math.sqrt(Math.abs(pPa - this.casingP)) * 189.145628;
    this.fpm.set(vs);
    this.kts.set((vs / 60) * FPS_TO_KT);
    this.mps.set((vs / 60) * FT_TO_M);
    this.casingRho = rho;
  }
}

class MagCompass extends Base {
  constructor(props, cfg) {
    super(props, cfg, "magnetic-compass");
    this.serviceable = this.initServiceable();
    this.roll = props.node("/orientation/roll-deg");
    this.pitch = props.node("/orientation/pitch-deg");
    this.heading = props.node("/orientation/heading-magnetic-deg");
    this.dip = props.node("/environment/magnetic-dip-deg");
    this.xa = props.node("/accelerations/pilot/x-accel-fps_sec");
    this.ya = props.node("/accelerations/pilot/y-accel-fps_sec");
    this.za = props.node("/accelerations/pilot/z-accel-fps_sec");
    this.deviation = cfg.hasChild("deviation") ? this.abs("deviation", "") : null;
    this.pitchOffset = this.n("pitch-offset-deg");
    this.viscosity = this.n("fluid-viscosity");
    if (!this.viscosity.get()) this.viscosity.set(8);
    this.out = this.n("indicated-heading-deg");
    this.rollOut = this.n("roll-deg");
    this.pitchOut = this.n("pitch-deg");
    this.rate = 0;
    this.lastRoll = 0;
    this.lastPitch = 0;
    this.out.set(this.heading.get());
  }

  update(dt) {
    if (!this.serviceable.getBool()) return;
    const damp = (5 / 8) * this.viscosity.get() * 10;
    let phi = this.roll.get() * D2R;
    let theta = (this.pitch.get() + this.pitchOffset.get()) * D2R;
    const psi = this.heading.get() * D2R;
    const mu = this.dip.get() * D2R;
    theta -= 0.07 * (this.xa.get() / 32);
    phi -= 0.07 * (this.ya.get() / 32);
    const d = Math.max(1, -this.za.get());
    const xf = (this.xa.get() / d) * 10;
    const yf = (this.ya.get() / d) * 10;
    const filt = (cur, tgt) => (damp < 1 ? tgt : cur + (tgt - cur) / damp);
    this.lastRoll = filt(this.lastRoll, (phi / D2R) * Math.abs(yf));
    this.lastPitch = filt(this.lastPitch, (-theta / D2R) * Math.abs(xf));
    this.rollOut.set(this.lastRoll);
    this.pitchOut.set(this.lastPitch);
    const a = Math.cos(phi) * Math.sin(psi) * Math.cos(mu) - Math.sin(phi) * Math.cos(theta) * Math.sin(mu)
      - Math.sin(phi) * Math.sin(theta) * Math.cos(mu) * Math.cos(psi);
    const b = Math.cos(theta) * Math.cos(psi) * Math.cos(mu) - Math.sin(theta) * Math.sin(mu);
    let target = Math.atan2(a, b) / D2R;
    if (this.deviation) target -= this.deviation.get();
    const old = this.out.get();
    while (target - old > 180) target -= 360;
    while (target - old < -180) target += 360;
    this.rate = lowPass(this.rate, target - old, dt / 5);
    this.out.set(periodic(0, 360, old + this.rate * dt));
  }
}

class Clock extends Base {
  constructor(props, cfg) {
    super(props, cfg, "clock");
    this.serviceable = this.initServiceable();
    this.gmt = props.node("/sim/time/utc/day-seconds");
    this.offset = this.n("offset-sec");
    this.sec = this.n("indicated-sec");
    this.hour = this.n("indicated-hour");
    this.min = this.n("indicated-min");
  }

  update() {
    if (!this.serviceable.getBool()) return;
    const t = periodic(0, 86400, this.gmt.get() + this.offset.get());
    this.sec.set(t);
    this.hour.set(Math.floor(t / 3600));
    this.min.set(Math.floor(t / 60) % 60);
    this.props.set(`${this.root}/indicated-string`,
      `${String(Math.floor(t / 3600)).padStart(2, "0")}:${String(Math.floor(t / 60) % 60).padStart(2, "0")}:${String(Math.floor(t) % 60).padStart(2, "0")}`);
    this.props.set(`${this.root}/indicated-short-string`,
      `${String(Math.floor(t / 3600)).padStart(2, "0")}:${String(Math.floor(t / 60) % 60).padStart(2, "0")}`);
  }
}

/** Radios keep their standard property layout so panel knobs and displays work. */
class Radio extends Base {
  constructor(props, cfg, def) {
    super(props, cfg, def);
    this.serviceable = this.initServiceable();
  }

  update() {}
}

const INSTRUMENTS = {
  "airspeed-indicator": AirspeedIndicator,
  altimeter: Altimeter,
  "attitude-indicator": AttitudeIndicator,
  "heading-indicator-dg": HeadingIndicatorDG,
  "turn-indicator": TurnIndicator,
  "slip-skid-ball": SlipSkidBall,
  "vertical-speed-indicator": VerticalSpeedIndicator,
  "magnetic-compass": MagCompass,
  clock: Clock,
};

const SYSTEMS = { pitot: PitotSystem, static: StaticSystem, vacuum: VacuumSystem };

/** FGSystemMgr + FGInstrumentMgr: builds and updates everything configured. */
export class InstrumentManager {
  constructor(props, systemsCfg, instrumentationCfg) {
    this.items = [];
    this.navaids = null;
    for (const c of systemsCfg?.children ?? []) {
      const Ctor = SYSTEMS[c.name];
      if (Ctor) this.items.push(new Ctor(props, c));
    }
    for (const c of instrumentationCfg?.children ?? []) {
      const Ctor = INSTRUMENTS[c.name];
      if (Ctor) this.items.push(new Ctor(props, c));
      else if (c.name.endsWith("radio") || ["adf", "dme", "marker-beacon", "transponder"].includes(c.name)) {
        this.items.push(new Radio(props, c, c.name));
      }
    }
  }

  update(dt) {
    for (const it of this.items) it.update(dt);
  }
}
