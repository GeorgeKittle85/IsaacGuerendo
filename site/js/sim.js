// The simulation core shared by the website and the headless tests.
//
// Per frame, in FlightGear's order: aircraft scripts (the Nasal ports),
// property rules / autopilots, the JSBSim flight model, then the systems and
// instruments that read its outputs.

import { PropertyTree } from "./props/props.js";
import { FDMInterface } from "./fdm/interface.js";
import { ConfigNode } from "./props/config.js";
import { PropertyRuleGroup } from "./systems/autopilot.js";
import { InstrumentManager } from "./instruments/fginstruments.js";
import { C172P } from "./aircraft/c172p.js";
import { updateTweens } from "./props/sgexpr.js";

export class Simulation {
  /**
   * @param jsb   JSBSim wrapper (fdm/jsbsim.js)
   * @param data  {fdm, props, rules}: the JSON bundles from tools/build_*.py
   */
  constructor(jsb, data) {
    this.jsb = jsb;
    this.data = data;
    this.props = null;
    this.elapsed = 0;
    this.magTimer = 0;
  }

  /**
   * start: {lat, lon, headingDeg, onGround, altitudeFt, speedKts, running,
   *         fuel (0..1), utcSeconds, wind: {fromDeg, kt}}
   */
  start(start) {
    const props = (this.props = new PropertyTree(this.jsb));
    this.fdm = new FDMInterface(this.jsb, props);
    this.aircraft = new C172P(props);
    this.startCfg = start;
    this.fdm.init({
      fdmBundle: this.data.fdm,
      initialProps: this.data.props,
      start,
      setup: () => {
        this.aircraft.preInit();
        this.setEnvironment(start);
      },
      afterLoad: () => {
        this.aircraft.afterLoad(start.fuel ?? 0.75);
        const rules = this.data.rules;
        this.rules = rules.groups.map(
          (g) => new PropertyRuleGroup(props, ConfigNode.from(g.config), "/", g.path));
        if (start.running) this.aircraft.runningState();
        // Let the rules settle so the FDM sees consistent controls at RunIC.
        for (let i = 0; i < 2; i++) for (const r of this.rules) r.update(0.01);
      },
    });
    this.aircraft.init({ running: !!start.running });
    this.elapsed = 0;
    this.updateMagneticField();
    // Like FlightGear, instruments start once the flight model has valid
    // pressures and attitudes, so their filters do not begin from zero.
    for (const r of this.rules) r.update(0.01);
    const rules = this.data.rules;
    this.instruments = new InstrumentManager(props,
      rules.systems && ConfigNode.from(rules.systems),
      rules.instrumentation && ConfigNode.from(rules.instrumentation));
    this.instruments.update(0.01);
    for (const r of this.rules) r.update(0.01);
    const vsi = this.instruments.items.find((i) => i.reinit && i.name === "vertical-speed-indicator");
    vsi?.reinit();
  }

  setEnvironment(start) {
    const p = this.props;
    const wind = start.wind ?? { fromDeg: 0, kt: 0 };
    this.setWind(wind.fromDeg, wind.kt);
    p.set("/sim/time/utc/day-seconds", start.utcSeconds ?? 20 * 3600);
    p.set("/environment/visibility-m", start.visibilityM ?? 30000);
    p.set("/environment/pressure-sea-level-inhg", 29.92);
    const mv = this.jsb.magvar(start.lat, start.lon, 0);
    this.fdm.magvar = mv;
    p.set("/environment/magnetic-variation-deg", mv);
    p.set("/environment/magnetic-dip-deg", this.jsb.magdip(start.lat, start.lon, 0));
  }

  /** FlightGear's wind convention: direction the wind blows FROM, in knots. */
  setWind(fromDeg, kt) {
    const p = this.props;
    const fps = kt / 0.5924838012958963;
    const r = (fromDeg * Math.PI) / 180;
    p.set("/environment/wind-from-heading-deg", fromDeg);
    p.set("/environment/wind-speed-kt", kt);
    p.set("/environment/wind-from-north-fps", fps * Math.cos(r));
    p.set("/environment/wind-from-east-fps", fps * Math.sin(r));
    p.set("/environment/wind-from-down-fps", 0);
  }

  updateMagneticField() {
    const p = this.props;
    const lat = p.get("/position/latitude-deg");
    const lon = p.get("/position/longitude-deg");
    const alt = p.get("/position/altitude-ft") * 0.3048;
    const mv = this.jsb.magvar(lat, lon, alt);
    this.fdm.magvar = mv;
    p.set("/environment/magnetic-variation-deg", mv);
    p.set("/environment/magnetic-dip-deg", this.jsb.magdip(lat, lon, alt));
  }

  update(dt, { paused = false, speedUp = 1 } = {}) {
    const p = this.props;
    p.set("/sim/time/delta-realtime-sec", dt);
    if (paused || this.fdm.crashed) {
      p.set("/sim/time/delta-sec", 0);
      return;
    }
    const simDt = dt * speedUp;
    this.elapsed += simDt;
    p.set("/sim/time/delta-sec", simDt);
    p.set("/sim/time/elapsed-sec", this.elapsed);
    p.set("/sim/time/utc/day-seconds", (p.get("/sim/time/utc/day-seconds") + simDt) % 86400);
    updateTweens(p, simDt);
    this.aircraft.update(simDt);
    for (const r of this.rules) r.update(simDt);
    this.fdm.update(dt, { speedUp });
    this.instruments.update(simDt);
    this.magTimer += simDt;
    if (this.magTimer > 10) {
      this.magTimer = 0;
      this.updateMagneticField();
    }
    if (this.fdm.crashed) p.set("/sim/crashed", true);
  }
}
