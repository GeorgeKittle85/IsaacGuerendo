// Aircraft glue for the General Dynamics F-16 Fighting Falcon: JSBSim's own
// F-16 flight model (aircraft/f16 in the JSBSim sources, with its fly-by-wire
// flight control system and the F100-PW-229 afterburning turbofan).
//
// JSBSim's F-16 comes without FlightGear aircraft files, so the few
// properties and instruments FlightGear would set up from a -set.xml are
// defined here instead: the pilot's eye point and the generic pitot/static
// instruments (FlightGear's generic-systems.xml / generic-instrumentation.xml)
// that the flight data strip reads.

/** Initial properties, in the {values, aliases} form of tools/build_props.py. */
export const F16_PROPS = {
  values: [
    // Pilot's eye point: x right, y up, z aft of the model origin (metres).
    ["/sim/view/config/x-offset-m", 0],
    ["/sim/view/config/y-offset-m", 1.24],
    ["/sim/view/config/z-offset-m", -4.15],
    ["/sim/view/config/pitch-offset-deg", -6],
    ["/sim/view/config/default-field-of-view-deg", 75],
    ["/sim/description", "General Dynamics F-16 Fighting Falcon"],
    ["/sim/aircraft", "f16"],
  ],
  aliases: [],
};

const cfg = (n, children, i) => ({ n, ...(i ? { i } : {}), c: children });
const val = (n, v) => ({ n, v: String(v) });

/** Property rules and instruments, in the form of tools/build_rules.py. */
export const F16_RULES = {
  groups: [],
  systems: cfg("", [
    cfg("pitot", [val("name", "pitot"), val("number", 0)]),
    cfg("static", [val("name", "static"), val("number", 0), val("tau", 0.1)]),
  ]),
  instrumentation: cfg("", [
    cfg("airspeed-indicator", [val("name", "airspeed-indicator"), val("number", 0),
      val("total-pressure", "/systems/pitot/total-pressure-inhg"), val("static-pressure", "/systems/static/pressure-inhg")]),
    cfg("altimeter", [val("name", "altimeter"), val("number", 0),
      val("static-pressure", "/systems/static/pressure-inhg"), val("tau", 0)]),
    cfg("vertical-speed-indicator", [val("name", "vertical-speed-indicator"), val("number", 0),
      val("static-pressure", "/systems/static/pressure-inhg")]),
  ]),
};

const INTERNAL_TANK_LBS = 3486; // tanks 0 and 1 in f16.xml
const LIGHT_OFF_N2 = 20; // % N2 at which the fuel is opened on a start

export class F16 {
  constructor(props) {
    this.props = props;
    this.starting = false;
  }

  /** Before the FDM loads. */
  preInit() {
    const p = this.props;
    p.set("/sim/model/pushback/position-norm", 0);
    p.set("/sim/model/pushback/target-speed-fps", 0);
  }

  /** After the FDM loads: internal fuel only, drop tanks empty. */
  afterLoad(fuelFraction = 0.75) {
    const p = this.props;
    const lbs = Math.max(0.25, Math.min(1, fuelFraction)) * INTERNAL_TANK_LBS;
    for (let i = 0; i < 4; i++) {
      const v = i < 2 ? lbs : 0;
      p.set(`propulsion/tank[${i}]/contents-lbs`, v);
      p.set(`/consumables/fuel/tank[${i}]/level-lbs`, v);
    }
  }

  init() {
    this.starting = false;
  }

  /** A running start: fuel open, canopy shut. */
  runningState() {
    const p = this.props;
    p.set("/controls/engines/engine[0]/cutoff", false);
    p.set("/controls/engines/engine[0]/starter", false);
    p.set("fcs/canopy-engage", 0);
  }

  get running() {
    return this.props.getBool("/engines/engine[0]/running");
  }

  /**
   * Engine start (Shift+S): the jet fuel starter spins the core with the
   * fuel shut off, and the throttle comes out of cutoff at 20% N2, as in
   * the F-16's start procedure; JSBSim's FGTurbine lights off from there.
   */
  autostart() {
    if (this.running) return "Engine already running";
    const p = this.props;
    p.set("/controls/engines/engine[0]/throttle", 0);
    p.set("/controls/engines/engine[0]/cutoff", true);
    p.set("/controls/gear/brake-parking", 1);
    p.set("fcs/canopy-engage", 0);
    this.setStarter(true);
    this.starting = true;
    return "Starting engine: JFS spinning up...";
  }

  /** 's' key: the starter, held. */
  setStarter(on) {
    const p = this.props;
    if (on && this.running) return;
    if (on && p.get("/engines/engine[0]/n2") < LIGHT_OFF_N2) p.set("/controls/engines/engine[0]/cutoff", true);
    p.set("/controls/engines/engine[0]/starter", !!on);
    if (!on) this.starting = false;
  }

  /** The canopy opens only on the ground and slowly (JSBSim closes it above 1 ft/s). */
  toggleCanopy() {
    const p = this.props;
    const open = p.get("fcs/canopy-engage") < 0.5;
    if (open && p.get("/velocities/groundspeed-kt") > 1) return "Canopy: stop the aircraft first";
    p.set("fcs/canopy-engage", open ? 1 : 0);
    return open ? "Canopy opening" : "Canopy closing";
  }

  update() {
    const p = this.props;
    const starter = p.getBool("/controls/engines/engine[0]/starter");
    if (starter && p.get("/engines/engine[0]/n2") >= LIGHT_OFF_N2) p.set("/controls/engines/engine[0]/cutoff", false);
    if (starter && this.running) {
      p.set("/controls/engines/engine[0]/starter", false);
      this.starting = false;
    }
    p.set("/consumables/fuel/total-fuel-lbs", p.get("propulsion/tank[0]/contents-lbs") + p.get("propulsion/tank[1]/contents-lbs"));
  }
}
