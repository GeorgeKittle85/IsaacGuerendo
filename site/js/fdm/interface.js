// FlightGear's JSBSim interface (src/FDM/JSBSim/JSBSim.cxx) ported to JS.
//
// Each frame: copy the pilot's controls from FlightGear's /controls tree into
// JSBSim, run the flight model at 120 Hz, then publish JSBSim's state back to
// the FlightGear properties (/position, /orientation, /engines, /gear, ...)
// that instruments, the 3D model and the aircraft's own systems read.

const FT2M = 0.3048;
const FPS2KT = 0.5924838012958963;
const RAD2DEG = 180 / Math.PI;
const PSF_PER_INHG = 70.726206;
const G_FPS2 = 32.174;

export const MODEL_HZ = 120;

export class FDMInterface {
  constructor(jsb, props) {
    this.jsb = jsb;
    this.props = props;
    this.engines = 0;
    this.tanks = 0;
    this.gear = [];
    this.accum = 0;
    this.crashed = false;
    this.magvar = 0;
    this.terrain = null; // {query(latRad, lonRad) -> {elev, nE, nN, nU, material}}
  }

  /**
   * Loads the aircraft and places it at `start`:
   *   {lat, lon, headingDeg, onGround, altitudeFt (MSL, when airborne),
   *    speedKts, running}
   */
  init({ fdmBundle, initialProps, start, setup, afterLoad }) {
    const { jsb, props } = this;
    jsb.writeFiles(fdmBundle.files);
    jsb.create("/fdm");
    props.applyInitial(initialProps);
    this.createCoreProperties(start);
    setup?.(props); // aircraft-specific properties its systems expect
    jsb.loadModel(fdmBundle.model);
    jsb.setDt(1 / MODEL_HZ);
    this.discover(fdmBundle);
    afterLoad?.(props); // e.g. fuel load and tank selection

    props.set("ic/lat-geod-deg", start.lat);
    props.set("ic/long-gc-deg", start.lon);
    props.set("ic/psi-true-deg", start.headingDeg);
    if (start.onGround) {
      // FGInterface::common_init: 0.1 ft above the ground, then a ground trim.
      props.set("ic/h-agl-ft", 0.1);
      props.set("ic/vc-kts", 0);
    } else {
      props.set("ic/h-sl-ft", start.altitudeFt);
      props.set("ic/vc-kts", start.speedKts ?? 90);
      props.set("ic/gamma-deg", 0);
    }

    this.copyToJSBSim();
    this.copyFromJSBSim(); // creates the FlightGear outputs the systems read
    jsb.runIC();

    if (start.running) {
      // FGJSBsim::init with /sim/presets/running: start every engine.
      props.set("propulsion/set-running", -1);
      for (let i = 0; i < this.engines; i++) {
        props.set(`/controls/engines/engine[${i}]/magnetos`, 3);
        props.set(`/controls/engines/engine[${i}]/mixture`, 1);
        props.set(`/engines/engine[${i}]/running`, true);
      }
    }
    // /sim/presets/trim defaults to true in FlightGear: a ground trim settles
    // the aircraft on its gear, an airborne one finds steady level flight.
    const trimmed = jsb.trim(start.onGround ? 2 : 1);
    if (!trimmed) console.warn("JSBSim trim did not converge:", jsb.lastError);
    else if (!start.onGround) {
      // FGJSBsim::do_trim: hand the trimmed controls back to the pilot.
      props.set("/controls/flight/elevator-trim", props.get("fcs/pitch-trim-cmd-norm"));
      props.set("/controls/flight/elevator", props.get("fcs/elevator-cmd-norm"));
      props.set("/controls/flight/aileron", props.get("fcs/aileron-cmd-norm"));
      props.set("/controls/flight/rudder", -props.get("fcs/rudder-cmd-norm"));
      for (let i = 0; i < this.engines; i++) {
        props.set(`/controls/engines/engine[${i}]/throttle`, props.get(`fcs/throttle-cmd-norm[${i}]`));
      }
    }
    this.trimmed = trimmed;
    this.copyFromJSBSim();
  }

  /** The FlightGear core properties the aircraft expects to exist. */
  createCoreProperties(start) {
    const p = this.props;
    const defaults = {
      "/controls/flight/aileron": 0, "/controls/flight/elevator": 0, "/controls/flight/rudder": 0,
      "/controls/flight/aileron-trim": 0, "/controls/flight/elevator-trim": 0, "/controls/flight/rudder-trim": 0,
      "/controls/flight/flaps": 0, "/controls/flight/speedbrake": 0, "/controls/flight/spoilers": 0,
      "/controls/gear/brake-left": 0, "/controls/gear/brake-right": 0, "/controls/gear/brake-parking": 0,
      "/controls/gear/gear-down": 1,
      "/controls/anti-ice/pitot-heat": false,
      "/controls/anti-ice/engine[0]/carb-heat": false, "/controls/anti-ice/engine[1]/carb-heat": false,
      "/systems/pitot/icing": 0,
      "/sim/freeze/fuel": false, "/sim/freeze/master": false, "/sim/crashed": false,
      "/sim/presets/onground": !!start.onGround, "/sim/presets/running": !!start.running,
      "/pax/pilot/present": true, "/pax/co-pilot/present": false,
      "/pax/left-passenger/present": false, "/pax/right-passenger/present": false,
    };
    for (const [path, v] of Object.entries(defaults)) p.set(path, v);
    for (const d of ["leftDoor", "rightDoor", "baggageDoor", "leftWindow", "rightWindow"]) {
      p.set(`/sim/model/door-positions/${d}/position-norm`, 0);
      p.set(`/sim/model/door-positions/${d}/position-norm-effective`, 0);
    }
    for (let i = 0; i < 2; i++) {
      p.set(`/controls/engines/engine[${i}]/throttle`, 0);
      p.set(`/controls/engines/engine[${i}]/mixture`, start.running ? 1 : 0);
      p.set(`/controls/engines/engine[${i}]/magnetos`, start.running ? 3 : 0);
      p.set(`/controls/engines/engine[${i}]/starter`, false);
      p.set(`/controls/engines/engine[${i}]/propeller-pitch`, 1);
      p.set(`/engines/engine[${i}]/running`, false);
    }
  }

  discover(fdmBundle) {
    const jsb = this.jsb;
    this.engines = 0;
    while (jsb.handle(`propulsion/engine[${this.engines}]/set-running`, false) >= 0) this.engines++;
    this.tanks = 0;
    while (jsb.handle(`propulsion/tank[${this.tanks}]/contents-lbs`, false) >= 0) this.tanks++;
    for (let i = 0; i < this.tanks; i++) {
      const lbs = this.props.get(`propulsion/tank[${i}]/contents-lbs`);
      this.props.set(`/consumables/fuel/tank[${i}]/level-lbs`, lbs);
    }
    const units = this.props.get("gear/num-units");
    this.gear = [];
    for (let i = 0; i < units; i++) {
      const meta = fdmBundle.gear?.[i] ?? {};
      this.gear.push({ maxSteerDeg: meta.maxSteerDeg || 0 });
      const maxc = this.props.get(`/gear/gear[${i}]/max-compression-ft`)
        || this.props.get(`/gear/gear[${i}]/max-compression-m`) / FT2M || 1;
      this.gear[i].maxCompressionFt = maxc;
    }
    this.buildNodes();
  }

  /** Pre-resolves the property handles used every frame. */
  buildNodes() {
    const n = (path) => this.props.node(path);
    this.n = {
      aileron: n("/controls/flight/aileron"), aileronTrim: n("/controls/flight/aileron-trim"),
      elevator: n("/controls/flight/elevator"), elevatorTrim: n("/controls/flight/elevator-trim"),
      rudder: n("/controls/flight/rudder"), rudderTrim: n("/controls/flight/rudder-trim"),
      flaps: n("/controls/flight/flaps"), speedbrake: n("/controls/flight/speedbrake"),
      spoilers: n("/controls/flight/spoilers"),
      brakeL: n("/controls/gear/brake-left"), brakeR: n("/controls/gear/brake-right"),
      brakeP: n("/controls/gear/brake-parking"), gearDown: n("/controls/gear/gear-down"),
      fcsDa: n("fcs/aileron-cmd-norm"), fcsRollTrim: n("fcs/roll-trim-cmd-norm"),
      fcsDe: n("fcs/elevator-cmd-norm"), fcsPitchTrim: n("fcs/pitch-trim-cmd-norm"),
      fcsDr: n("fcs/rudder-cmd-norm"), fcsDs: n("fcs/steer-cmd-norm"), fcsYawTrim: n("fcs/yaw-trim-cmd-norm"),
      fcsDf: n("fcs/flap-cmd-norm"), fcsDsb: n("fcs/speedbrake-cmd-norm"), fcsDsp: n("fcs/spoiler-cmd-norm"),
      fcsLB: n("fcs/left-brake-cmd-norm"), fcsRB: n("fcs/right-brake-cmd-norm"), fcsCB: n("fcs/center-brake-cmd-norm"),
      gearCmd: n("gear/gear-cmd-norm"),
      activeEngine: n("propulsion/active_engine"), magnetoCmd: n("propulsion/magneto_cmd"),
      starterCmd: n("propulsion/starter_cmd"),
      windN: n("atmosphere/wind-north-fps"), windE: n("atmosphere/wind-east-fps"), windD: n("atmosphere/wind-down-fps"),
      windFromN: n("/environment/wind-from-north-fps"), windFromE: n("/environment/wind-from-east-fps"),
      windFromD: n("/environment/wind-from-down-fps"),
      fuelFreeze: n("propulsion/fuel_freeze"), simFuelFreeze: n("/sim/freeze/fuel"),
    };
    this.engineNodes = [];
    for (let i = 0; i < this.engines; i++) {
      const c = (s) => n(`/controls/engines/engine[${i}]/${s}`);
      const e = (s) => n(`/engines/engine[${i}]/${s}`);
      const j = (s) => n(`propulsion/engine[${i}]/${s}`);
      this.engineNodes.push({
        throttle: c("throttle"), mixture: c("mixture"), pitch: c("propeller-pitch"),
        feather: c("propeller-feather"), magnetos: c("magnetos"), starter: c("starter"),
        fcsThrottle: n(`fcs/throttle-cmd-norm[${i}]`), fcsMixture: n(`fcs/mixture-cmd-norm[${i}]`),
        fcsAdvance: n(`fcs/advance-cmd-norm[${i}]`), fcsFeather: n(`fcs/feather-cmd-norm[${i}]`),
        setRunning: j("set-running"), running: e("running"),
        jEgt: j("egt-degF"), jOilT: j("oil-temperature-degF"), jOilP: j("oil-pressure-psi"),
        jMap: j("map-inhg"), jCht: j("cht-degF"), jRpm: j("engine-rpm"), jFfGph: j("fuel-flow-rate-gph"),
        jFfPps: j("fuel-flow-rate-pps"), jThrust: j("thrust-lbs"), jPropRpm: j("propeller-rpm"),
        jBlade: j("blade-angle"), jTorque: j("propeller-torque-ftlb"),
        egt: e("egt-degf"), oilT: e("oil-temperature-degf"), oilP: e("oil-pressure-psi"),
        mpOsi: e("mp-osi"), mpInhg: e("mp-inhg"), cht: e("cht-degf"), rpm: e("rpm"),
        ffGph: e("fuel-flow-gph"), ffPph: e("fuel-flow_pph"), thrust: e("thrust_lb"),
        starterOut: e("starter"), cranking: e("cranking"),
        propRpm: e("thruster/rpm"), propPitch: e("thruster/pitch"), propTorque: e("thruster/torque"),
      });
    }
    this.tankNodes = [];
    for (let i = 0; i < this.tanks; i++) {
      this.tankNodes.push({
        contents: n(`propulsion/tank[${i}]/contents-lbs`), density: n(`propulsion/tank[${i}]/density-lbs_per_gal`),
        level: n(`/consumables/fuel/tank[${i}]/level-lbs`), levelGal: n(`/consumables/fuel/tank[${i}]/level-gal_us`),
        ppg: n(`/consumables/fuel/tank[${i}]/density-ppg`),
      });
    }
    this.gearNodes = this.gear.map((g, i) => ({
      wow: n(`gear/unit[${i}]/WOW`), comp: n(`gear/unit[${i}]/compression-ft`),
      wheel: n(`gear/unit[${i}]/wheel-speed-fps`), pos: n(`gear/unit[${i}]/pos-norm`),
      steer: n(`gear/unit[${i}]/steering-angle-deg`),
      oWow: n(`/gear/gear[${i}]/wow`), oRoll: n(`/gear/gear[${i}]/rollspeed-ms`),
      oPos: n(`/gear/gear[${i}]/position-norm`), oCompNorm: n(`/gear/gear[${i}]/compression-norm`),
      oCompM: n(`/gear/gear[${i}]/compression-m`), oCompFt: n(`/gear/gear[${i}]/compression-ft`),
      oSteer: n(`/gear/gear[${i}]/steering-norm`),
    }));
    const out = (a, b) => [n(a), n(b)];
    this.outs = {
      lat: n("/position/latitude-deg"), lon: n("/position/longitude-deg"), alt: n("/position/altitude-ft"),
      aglFt: n("/position/altitude-agl-ft"), aglM: n("/position/altitude-agl-m"),
      gndFt: n("/position/ground-elev-ft"), gndM: n("/position/ground-elev-m"),
      vrpLat: n("position/vrp-gc-latitude_deg"), vrpLon: n("position/vrp-longitude_deg"),
      vrpR: n("position/vrp-radius-ft"), hagl: n("position/h-agl-ft"),
      roll: out("attitude/phi-deg", "/orientation/roll-deg"), pitch: out("attitude/theta-deg", "/orientation/pitch-deg"),
      heading: out("attitude/psi-deg", "/orientation/heading-deg"), hdgMag: n("/orientation/heading-magnetic-deg"),
      alpha: out("aero/alpha-deg", "/orientation/alpha-deg"), beta: out("aero/beta-deg", "/orientation/side-slip-deg"),
      p: n("velocities/p-rad_sec"), q: n("velocities/q-rad_sec"), r: n("velocities/r-rad_sec"),
      rollRate: n("/orientation/roll-rate-degps"), pitchRate: n("/orientation/pitch-rate-degps"),
      yawRate: n("/orientation/yaw-rate-degps"),
      vc: out("velocities/vc-kts", "/velocities/airspeed-kt"), ve: out("velocities/ve-kts", "/velocities/equivalent-kt"),
      vt: out("velocities/vtrue-kts", "/velocities/true-airspeed-kt"), mach: out("velocities/mach", "/velocities/mach"),
      vg: n("velocities/vg-fps"), gs: n("/velocities/groundspeed-kt"),
      hdot: out("velocities/h-dot-fps", "/velocities/vertical-speed-fps"),
      vN: out("velocities/v-north-fps", "/velocities/speed-north-fps"), vE: out("velocities/v-east-fps", "/velocities/speed-east-fps"),
      vD: out("velocities/v-down-fps", "/velocities/speed-down-fps"),
      u: out("velocities/u-fps", "/velocities/uBody-fps"), v: out("velocities/v-fps", "/velocities/vBody-fps"),
      w: out("velocities/w-fps", "/velocities/wBody-fps"),
      track: n("/orientation/track-deg"),
      ax: out("accelerations/a-pilot-x-ft_sec2", "/accelerations/pilot/x-accel-fps_sec"),
      ay: out("accelerations/a-pilot-y-ft_sec2", "/accelerations/pilot/y-accel-fps_sec"),
      az: out("accelerations/a-pilot-z-ft_sec2", "/accelerations/pilot/z-accel-fps_sec"),
      nz: n("accelerations/n-pilot-z-norm"), pilotG: n("/accelerations/pilot-g"), nlf: out("forces/load-factor", "/accelerations/nlf"),
      stall: out("systems/stall-warn-norm", "/sim/alarms/stall-warning"),
      de: out("fcs/elevator-pos-norm", "/surface-positions/elevator-pos-norm"),
      daL: out("fcs/left-aileron-pos-norm", "/surface-positions/left-aileron-pos-norm"),
      daR: out("fcs/right-aileron-pos-norm", "/surface-positions/right-aileron-pos-norm"),
      dr: out("fcs/rudder-pos-norm", "/surface-positions/rudder-pos-norm"),
      df: out("fcs/flap-pos-norm", "/surface-positions/flap-pos-norm"),
      dsb: out("fcs/speedbrake-pos-norm", "/surface-positions/speedbrake-pos-norm"),
      dsp: out("fcs/spoiler-pos-norm", "/surface-positions/spoilers-pos-norm"),
      T: n("atmosphere/T-R"), P: n("atmosphere/P-psf"), rho: n("atmosphere/rho-slugs_ft3"),
      densityAlt: n("atmosphere/density-altitude"),
      envTc: n("/environment/temperature-degc"), envTf: n("/environment/temperature-degf"),
      envP: n("/environment/pressure-inhg"), envRho: n("/environment/density-slugft3"),
      envDA: n("/environment/density-altitude-ft"), envMagvar: n("/environment/magnetic-variation-deg"),
      groundSolid: n("ground/solid"), groundBump: n("ground/bumpiness"),
      groundStatic: n("ground/static-friction-factor"), groundRolling: n("ground/rolling_friction-factor"),
    };
  }

  copyToJSBSim() {
    const n = this.n;
    n.fcsDa.set(n.aileron.get());
    n.fcsRollTrim.set(n.aileronTrim.get());
    n.fcsDe.set(n.elevator.get());
    n.fcsPitchTrim.set(n.elevatorTrim.get());
    n.fcsDr.set(-n.rudder.get());
    n.fcsDs.set(n.rudder.get());
    n.fcsYawTrim.set(-n.rudderTrim.get());
    n.fcsDf.set(n.flaps.get());
    n.fcsDsb.set(n.speedbrake.get());
    n.fcsDsp.set(n.spoilers.get());
    const parking = n.brakeP.get();
    n.fcsLB.set(Math.max(n.brakeL.get(), parking));
    n.fcsRB.set(Math.max(n.brakeR.get(), parking));
    n.fcsCB.set(0);
    n.gearCmd.set(n.gearDown.get());
    for (let i = 0; i < this.engines; i++) {
      const e = this.engineNodes[i];
      e.fcsThrottle.set(e.throttle.get());
      e.fcsMixture.set(e.mixture.get());
      e.fcsAdvance.set(e.pitch.get());
      e.fcsFeather.set(e.feather.get());
      n.activeEngine.set(i);
      n.magnetoCmd.set(e.magnetos.get());
      n.starterCmd.set(e.starter.get());
      e.setRunning.set(e.running.get());
    }
    n.activeEngine.set(-1);
    n.windN.set(-n.windFromN.get());
    n.windE.set(-n.windFromE.get());
    n.windD.set(-n.windFromD.get());
    n.fuelFreeze.set(n.simFuelFreeze.get());
  }

  copyFromJSBSim() {
    const o = this.outs;
    // Visual reference point position, like FGJSBsim::copy_from_JSBsim.
    const latGc = o.vrpLat.get() / RAD2DEG;
    const lonDeg = o.vrpLon.get();
    const radiusFt = o.vrpR.get();
    const geod = geocentricToGeodetic(latGc, radiusFt * FT2M);
    o.lat.set(geod.latDeg);
    o.lon.set(lonDeg);
    o.alt.set(geod.altM / FT2M);
    const agl = o.hagl.get();
    o.aglFt.set(agl);
    o.aglM.set(agl * FT2M);
    const ground = geod.altM / FT2M - agl;
    o.gndFt.set(ground);
    o.gndM.set(ground * FT2M);

    for (const pair of [o.roll, o.pitch, o.heading, o.alpha, o.beta, o.vc, o.ve, o.vt, o.mach,
      o.hdot, o.vN, o.vE, o.vD, o.u, o.v, o.w, o.ax, o.ay, o.az, o.nlf, o.stall, o.de, o.daL, o.daR,
      o.df, o.dsb, o.dsp]) {
      pair[1].set(pair[0].get());
    }
    o.dr[1].set(-o.dr[0].get());
    const hdg = o.heading[0].get();
    o.hdgMag.set(wrap360(hdg - this.magvar));
    o.rollRate.set(o.p.get() * RAD2DEG);
    o.pitchRate.set(o.q.get() * RAD2DEG);
    o.yawRate.set(o.r.get() * RAD2DEG);
    o.gs.set(o.vg.get() * FPS2KT);
    o.track.set(wrap360(Math.atan2(o.vE[0].get(), o.vN[0].get()) * RAD2DEG));
    o.pilotG.set(-o.nz.get());

    for (let i = 0; i < this.engines; i++) {
      const e = this.engineNodes[i];
      e.egt.set(e.jEgt.get());
      e.oilT.set(e.jOilT.get());
      e.oilP.set(e.jOilP.get());
      const map = e.jMap.get();
      e.mpOsi.set(map);
      e.mpInhg.set(map);
      e.cht.set(e.jCht.get());
      e.rpm.set(e.jRpm.get());
      e.ffGph.set(e.jFfGph.get());
      e.ffPph.set(e.jFfPps.get() * 3600);
      e.thrust.set(e.jThrust.get());
      e.running.set(e.setRunning.get() !== 0);
      const starter = e.starter.get() !== 0;
      e.starterOut.set(starter);
      e.cranking.set(starter);
      e.propRpm.set(e.jPropRpm.get());
      e.propPitch.set(e.jBlade.get());
      e.propTorque.set(e.jTorque.get());
    }

    if (!this.n.simFuelFreeze.getBool()) {
      for (const t of this.tankNodes) {
        const lbs = t.contents.get();
        const ppg = t.density.get() > 0.1 ? t.density.get() : 6.0;
        t.level.set(lbs);
        t.ppg.set(ppg);
        t.levelGal.set(lbs / ppg);
      }
    }

    for (let i = 0; i < this.gearNodes.length; i++) {
      const g = this.gearNodes[i];
      const meta = this.gear[i];
      g.oWow.set(g.wow.get() !== 0);
      g.oRoll.set(g.wheel.get() * FT2M);
      g.oPos.set(g.pos.get());
      const comp = g.comp.get();
      g.oCompNorm.set(comp / meta.maxCompressionFt);
      g.oCompM.set(comp * FT2M);
      g.oCompFt.set(comp);
      if (meta.maxSteerDeg) g.oSteer.set(g.steer.get() / meta.maxSteerDeg);
    }

    // FGEnvironment outputs at the aircraft's altitude (ISA unless overridden).
    const tR = o.T.get();
    o.envTc.set(tR / 1.8 - 273.15);
    o.envTf.set(tR - 459.67);
    o.envP.set(o.P.get() / PSF_PER_INHG);
    o.envRho.set(o.rho.get());
    o.envDA.set(o.densityAlt.get());
    o.envMagvar.set(this.magvar);

    if (agl < -100) this.crashed = true;
  }

  /** Sets JSBSim's surface properties from the FlightGear material below. */
  setGroundMaterial(mat) {
    const o = this.outs;
    o.groundSolid.set(mat ? (mat.solid ? 1 : 0) : 1);
    o.groundBump.set(mat?.bumpiness ?? 0);
    o.groundStatic.set(mat?.frictionFactor ?? 1);
    o.groundRolling.set(mat?.rollingFriction ?? 0.02);
  }

  /** Advances the flight model by dt seconds of real time. */
  update(dt, { paused = false, speedUp = 1 } = {}) {
    if (paused || this.crashed) return 0;
    this.accum += Math.min(dt, 0.25) * speedUp;
    let steps = Math.floor(this.accum * MODEL_HZ);
    if (steps <= 0) return 0;
    this.accum -= steps / MODEL_HZ;
    steps = Math.min(steps, 60 * speedUp);
    this.copyToJSBSim();
    const done = this.jsb.run(steps);
    if (done < steps) this.crashed = true; // simulation/terminate was set
    this.copyFromJSBSim();
    return done;
  }
}

/** Geocentric latitude/radius to geodetic latitude/altitude (WGS84). */
export function geocentricToGeodetic(latGcRad, radiusM) {
  // Build an ECEF point in the meridian plane and convert (Bowring).
  const x = radiusM * Math.cos(latGcRad);
  const z = radiusM * Math.sin(latGcRad);
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const b = a * (1 - f);
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const th = Math.atan2(a * z, b * x);
  const lat = Math.atan2(z + ep2 * b * Math.sin(th) ** 3, x - e2 * a * Math.cos(th) ** 3);
  const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const alt = x / Math.cos(lat) - N;
  return { latDeg: lat * RAD2DEG, altM: alt };
}

export function wrap360(d) {
  d %= 360;
  return d < 0 ? d + 360 : d;
}

export { FT2M, FPS2KT, RAD2DEG, G_FPS2 };
