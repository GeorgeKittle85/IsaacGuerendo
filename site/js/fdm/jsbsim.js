// Thin wrapper around the WebAssembly build of JSBSim (see wasm/jsbsim_bridge.cpp).
// Works in browsers and in Node (for the headless tests).

export class JSBSim {
  static async load(moduleFactory, options = {}) {
    const Module = await moduleFactory({
      print: options.print ?? (() => {}),
      printErr: options.printErr ?? ((s) => console.warn("[JSBSim]", s)),
      locateFile: options.locateFile,
    });
    return new JSBSim(Module);
  }

  constructor(Module) {
    this.Module = Module;
    const c = (name, ret, args) => Module.cwrap(name, ret, args);
    this._create = c("jsb_create", "number", ["string"]);
    this._load = c("jsb_load_model", "number", ["string", "string", "string", "string"]);
    this._prop = c("jsb_prop", "number", ["string", "number"]);
    this._alias = c("jsb_alias", "number", ["string", "string"]);
    this._runIC = c("jsb_run_ic", "number", []);
    this._run = c("jsb_run", "number", ["number"]);
    this._trim = c("jsb_trim", "number", ["number"]);
    this._setDt = c("jsb_set_dt", null, ["number"]);
    this._hold = c("jsb_hold", null, ["number"]);
    this._lastError = c("jsb_last_error", "string", []);
    this.version = c("jsb_version", "string", [])();
    this.simTime = c("jsb_sim_time", "number", []);
    this.getDt = c("jsb_get_dt", "number", []);
    // Hot-path accessors bypass cwrap's argument conversion.
    this.get = Module._jsb_get ?? c("jsb_get", "number", ["number"]);
    this.set = Module._jsb_set ?? c("jsb_set", null, ["number", "number"]);
    this.getString = c("jsb_get_string", "string", ["number"]);
    this.setString = c("jsb_set_string", null, ["number", "string"]);
    this.setBool = c("jsb_set_bool", null, ["number", "number"]);
    this.propType = c("jsb_prop_type", "number", ["number"]);
    const mv = c("jsb_magvar_deg", "number", ["number", "number", "number", "number", "number", "number"]);
    const md = c("jsb_magdip_deg", "number", ["number", "number", "number", "number", "number", "number"]);
    const ymd = (d) => [d.getUTCFullYear() % 100, d.getUTCMonth() + 1, d.getUTCDate()];
    /** WMM2020 magnetic variation/dip (FlightGear's SimGear model) in degrees. */
    this.magvar = (latDeg, lonDeg, altM, date = new Date()) => mv(latDeg, lonDeg, altM, ...ymd(date));
    this.magdip = (latDeg, lonDeg, altM, date = new Date()) => md(latDeg, lonDeg, altM, ...ymd(date));
    this.generation = 0;
    Module.groundQuery = null;
  }

  get lastError() {
    return this._lastError();
  }

  /** Writes {virtualPath: text} into the in-memory filesystem under root. */
  writeFiles(files, root = "/fdm") {
    const FS = this.Module.FS;
    for (const [p, text] of Object.entries(files)) {
      const full = `${root}/${p}`;
      FS.mkdirTree(full.slice(0, full.lastIndexOf("/")));
      FS.writeFile(full, text);
    }
  }

  /** Creates a fresh FDM instance (invalidates all property handles). */
  create(root = "/fdm") {
    this.generation++;
    if (!this._create(root)) throw new Error(`JSBSim create failed: ${this.lastError}`);
  }

  loadModel(model, { aircraftPath = "aircraft", enginePath = "engine", systemsPath = "systems" } = {}) {
    if (!this._load(aircraftPath, enginePath, systemsPath, model)) {
      throw new Error(`JSBSim could not load ${model}: ${this.lastError}`);
    }
  }

  /** Returns a handle for a property path, creating the node if asked. */
  handle(path, create = true) {
    return this._prop(path, create ? 1 : 0);
  }

  alias(path, target) {
    return this._alias(path, target) === 1;
  }

  runIC() {
    if (!this._runIC()) throw new Error(`JSBSim RunIC failed: ${this.lastError}`);
  }

  run(steps) {
    return this._run(steps);
  }

  /** JSBSim trim modes: 0 longitudinal, 1 full, 2 ground. */
  trim(mode) {
    return this._trim(mode) === 1;
  }

  setDt(dt) {
    this._setDt(dt);
  }

  hold(on) {
    this._hold(on ? 1 : 0);
  }

  /** Terrain provider: fn(latRad, lonRad, altM) -> {elev, nE, nN, nU} or null. */
  setGroundProvider(fn) {
    const M = this.Module;
    M.groundQuery = (lat, lon, alt, idx) => {
      const r = fn(lat, lon, alt);
      if (!r) return 0;
      const h = M.HEAPF64;
      h[idx] = r.elev;
      h[idx + 1] = r.nE;
      h[idx + 2] = r.nN;
      h[idx + 3] = r.nU;
      return 1;
    };
  }
}
