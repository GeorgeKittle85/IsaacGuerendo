// FlightGear Web: boots the WebAssembly flight model, the scenery, the
// aircraft model and the user interface, then runs the frame loop.

import * as THREE from "three";
import createJSBSim from "../wasm/jsbsim.mjs";
import { JSBSim } from "./fdm/jsbsim.js";
import { Simulation } from "./sim.js";
import { RenderFrame, aircraftMatrix, enuBasis } from "./scene/geo.js";
import { SceneryManager } from "./scene/tiles.js";
import { Sky, timeForSun } from "./scene/sky.js";
import { AirportLights } from "./scene/lights.js";
import { SceneryObjects } from "./scene/objects.js";
import { sceneryUniforms } from "./scene/materials.js";
import { ModelLibrary, loadModel } from "./model/fgmodel.js";
import { GLTFAircraftModel } from "./model/gltfmodel.js";
import { NasalRuntime } from "./nasal/nasal.js";
import { Controls } from "./app/controls.js";
import { ViewManager } from "./app/views.js";
import { Input, HELP } from "./app/input.js";
import { Hud } from "./app/hud.js";
import { TouchControls } from "./app/touch.js";
import { FighterHud } from "./app/fighterhud.js";
import { Menu } from "./app/menu.js";
import { createC172pNamespace } from "./aircraft/c172p-nasal.js";
import { aircraftById } from "./aircraft/registry.js";
import { SoundSystem } from "./sound/fgsound.js";

const FT = 0.3048;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function setLoading(text, fraction) {
  const box = $("loading");
  box.hidden = false;
  $("loading-text").textContent = text;
  if (fraction !== undefined) $("loading-bar").style.width = `${Math.round(fraction * 100)}%`;
}

function hideLoading() {
  $("loading").hidden = true;
}

function showError(err) {
  console.error(err);
  setLoading(`Something went wrong: ${err.message ?? err}`, 1);
  $("loading").classList.add("error");
}

/** Point `dist` metres from (lat, lon) along a true course. */
function offsetLatLon(lat, lon, courseDeg, dist) {
  const R = 6371008.8;
  const c = (courseDeg * Math.PI) / 180;
  return {
    lat: lat + ((dist * Math.cos(c)) / R) * (180 / Math.PI),
    lon: lon + ((dist * Math.sin(c)) / (R * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI),
  };
}

class App {
  constructor() {
    this.canvas = $("view");
    this.paused = false;
    this.speedUp = 1;
    this.frameDt = 1 / 60;
    this.flying = false;
    this.model = null;
    this.models = new Map(); // aircraft id -> loaded 3D model
    this.sounds = new Map(); // aircraft id -> SoundSystem
    this.aircraftData = new Map(); // aircraft id -> Promise of {fdm, props, rules}
    this.time = 0;
    this.sceneryTimer = 0;
    this.crashNotified = false;
    this.tmpPos = new THREE.Vector3();
  }

  async boot() {
    setLoading("Loading the JSBSim flight model (WebAssembly)…", 0.05);
    const [jsb, airports] = await Promise.all([
      JSBSim.load(createJSBSim),
      fetchJson("data/scenery/airports.json"),
    ]);
    this.jsb = jsb;
    this.airports = airports.airports;
    // The aircraft is chosen in the start menu; see start().
    this.sim = new Simulation(jsb, null);
    setLoading("Preparing the renderer…", 0.15);

    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: "high-performance",
    });
    // Phones and tablets: fewer pixels keep the frame rate up.
    this.mobile = !!window.matchMedia?.("(pointer: coarse)").matches;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.mobile ? 1.5 : 2));
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200000);
    this.frame = new RenderFrame(37.6188, -122.375);
    this.sky = new Sky(this.scene, renderer);
    this.lights = new AirportLights(renderer);
    this.scenery = new SceneryManager({ baseUrl: "data/scenery", frame: this.frame, scene: this.scene, renderer });
    this.scenery.lightFactory = (lights, mgr) => this.lights.build(lights, mgr);
    this.objects = new SceneryObjects("data/scenery/objects", renderer, { props: this.sim.props });
    this.scenery.onTileLoaded = (tile) => this.objects.addTile(tile).catch((err) => console.warn("objects", err));
    this.scenery.onTileUnloaded = (tile) => this.objects.removeTile(tile);
    await Promise.all([this.scenery.init(), this.objects.init()]);
    fetchJson("data/sky/stars.json").then((s) => this.sky.setStars(s.stars)).catch(() => {});
    jsb.setGroundProvider((lat, lon) => this.scenery.groundQuery(lat, lon));

    this.aircraftGroup = new THREE.Group();
    this.aircraftGroup.name = "aircraft";
    this.aircraftGroup.matrixAutoUpdate = false;
    this.scene.add(this.aircraftGroup);

    // Browsers start audio only after a user gesture.
    const unlock = () => {
      this.soundUnlocked = true;
      this.sound?.unlock();
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);

    this.hud = new Hud();
    this.fighterHud = new FighterHud();
    this.enu = { e: new THREE.Vector3(), n: new THREE.Vector3(), u: new THREE.Vector3() };
    this.controls = new Controls(this);
    this.views = new ViewManager({
      frame: this.frame,
      elevation: (lat, lon) => this.scenery.elevation(lat, lon),
      towers: this.airports.filter((a) => a.tower).map((a) => ({
        lat: a.tower.lat, lon: a.tower.lon, altM: a.elevationFt * FT + a.tower.heightM, name: a.icao,
      })),
      aspect: () => this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight),
      width: () => this.canvas.clientWidth,
    });
    this.input = new Input(this);
    this.input.attach();
    this.touch = new TouchControls(this);
    this.buildHelp();
    window.addEventListener("resize", () => this.resize());
    this.resize();
    this.bindToolbar();

    this.menu = new Menu(this, this.airports);
    hideLoading();
    requestAnimationFrame((t) => this.loop(t));
    if (params.has("autostart")) this.start(this.menu.readParams(params));
    else this.menu.open();
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
  }

  bindToolbar() {
    const on = (id, fn) => $(id)?.addEventListener("click", (e) => { e.currentTarget.blur(); fn(); });
    on("btn-menu", () => this.openMenu());
    on("btn-view", () => this.stepView(1));
    on("btn-pause", () => this.togglePause());
    on("btn-help", () => this.toggleHelp());
    on("btn-sound", () => {
      this.muted = !this.muted;
      this.sound?.unlock();
      this.sound?.setMuted(this.muted);
      document.body.classList.toggle("muted", this.muted);
      this.hud.message(this.muted ? "Sound off" : "Sound on", 1.2);
    });
    on("btn-full", () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
    });
    on("help-close", () => this.toggleHelp(false));
  }

  buildHelp() {
    const box = $("help-body");
    for (const [title, rows] of HELP) {
      const sec = document.createElement("section");
      const h = document.createElement("h3");
      h.textContent = title;
      sec.append(h);
      const dl = document.createElement("dl");
      for (const [k, d] of rows) {
        const dt = document.createElement("dt");
        dt.textContent = k;
        const dd = document.createElement("dd");
        dd.textContent = d;
        dl.append(dt, dd);
      }
      sec.append(dl);
      box.append(sec);
    }
  }

  // ------------------------------------------------------------ start

  /** Resolves a menu selection into a Simulation start configuration. */
  startConfig(sel) {
    const ac = aircraftById(sel.aircraft).start;
    const apt = this.airports.find((a) => a.icao === sel.airport) ?? this.airports[0];
    const rwy = apt.runways.find((r) => r.id === sel.runway) ?? apt.runways[0];
    const elevFt = apt.elevationFt;
    let cfg;
    if (sel.position === "final") {
      // Three nautical miles out on a 3° glide path to the landing threshold.
      const thr = offsetLatLon(rwy.lat, rwy.lon, rwy.heading, rwy.displacedM);
      const d = 3 * 1852;
      const p = offsetLatLon(thr.lat, thr.lon, rwy.heading + 180, d);
      cfg = { lat: p.lat, lon: p.lon, headingDeg: rwy.heading, onGround: false, running: true,
        altitudeFt: elevFt + (d * Math.tan((3 * Math.PI) / 180)) / FT + 50, speedKts: ac.finalKts,
        flaps: ac.finalFlaps, throttle: ac.throttle };
    } else if (sel.position === "air") {
      cfg = { lat: rwy.lat, lon: rwy.lon, headingDeg: rwy.heading, onGround: false, running: true,
        altitudeFt: elevFt + 3000, speedKts: ac.airKts, throttle: ac.throttle, gearDown: !ac.airGearUp };
    } else {
      const p = offsetLatLon(rwy.lat, rwy.lon, rwy.heading, 15);
      cfg = { lat: p.lat, lon: p.lon, headingDeg: rwy.heading, onGround: true, running: sel.position !== "cold" };
    }
    const today = new Date();
    let utc;
    const tod = sel.time ?? "afternoon";
    if (tod === "now") utc = today;
    else {
      const presets = {
        dawn: { elevDeg: -1, rising: true }, morning: { elevDeg: 20, rising: true }, noon: { noon: true },
        afternoon: { elevDeg: 30, rising: false }, dusk: { elevDeg: -2, rising: false },
        evening: { elevDeg: -9, rising: false }, midnight: { midnight: true },
      };
      utc = timeForSun(cfg.lat, cfg.lon, today, presets[tod] ?? presets.afternoon);
    }
    return {
      ...cfg,
      airport: apt, runway: rwy,
      utcMs: utc.getTime(),
      wind: { fromDeg: sel.windDir ?? 280, kt: sel.windKt ?? 8 },
      visibilityM: sel.visibilityM ?? 35000,
      fuel: 0.75,
      radiusKm: sel.radiusKm ?? 25,
    };
  }

  /** The flight model, property and rule bundles of an aircraft (fetched once). */
  loadAircraftData(def) {
    if (!this.aircraftData.has(def.id)) {
      const get = (v) => (typeof v === "string" ? fetchJson(v) : v);
      const d = def.data;
      const p = Promise.all([get(d.fdm), get(d.props), get(d.rules)]).then(([fdm, props, rules]) => ({ fdm, props, rules }));
      p.catch(() => this.aircraftData.delete(def.id));
      this.aircraftData.set(def.id, p);
    }
    return this.aircraftData.get(def.id);
  }

  /** The aircraft's 3D model: FlightGear model XML (c172p) or glTF (F-16). */
  async loadAircraftModel(def) {
    if (def.model.type === "gltf") return GLTFAircraftModel.load(def.model.url, def.model, this.sim.props);
    const lib = await ModelLibrary.load(def.model.url, this.renderer);
    const model = await loadModel(lib, lib.manifest.root, { props: this.sim.props, base: "/", nasal: this.nasal, commands: {} });
    model.pickMeshes = [];
    model.root.traverse((o) => {
      if (!o.isMesh) return;
      for (let n = o; n; n = n.parent) {
        if (n.userData.pick) { model.pickMeshes.push(o); break; }
      }
    });
    return model;
  }

  /** Switches the 3D model and the sound set to the selected aircraft. */
  async useAircraft(def) {
    let model = this.models.get(def.id);
    if (!model) {
      setLoading(`Loading the ${def.short}…`, 0.75);
      model = await this.loadAircraftModel(def);
      this.models.set(def.id, model);
    }
    if (this.model !== model) {
      if (this.model) this.aircraftGroup.remove(this.model.root);
      this.aircraftGroup.add(model.root);
      this.model = model;
    }
    let sound = this.sounds.get(def.id);
    if (!sound) {
      sound = new SoundSystem(def.sound);
      sound.load().catch((err) => console.warn("sound config", err.message));
      this.sounds.set(def.id, sound);
    }
    if (this.sound !== sound) {
      this.sound?.detach();
      this.sound = sound;
      sound.setMuted(!!this.muted);
      if (this.soundUnlocked) sound.unlock();
    }
  }

  async start(sel) {
    try {
      this.flying = false;
      this.menu.close();
      const def = aircraftById(sel.aircraft);
      const aircraftData = this.loadAircraftData(def);
      const cfg = this.startConfig(sel);
      this.startSel = sel;
      this.radiusKm = cfg.radiusKm;
      // Keep the render frame's origin near the aircraft for precision.
      this.frame.setReference(cfg.lat, cfg.lon);
      this.scenery.setFrame(this.frame);
      setLoading(`Loading scenery around ${cfg.airport.icao}…`, 0);
      await this.scenery.preload(cfg.lat, cfg.lon, Math.min(12, this.radiusKm), (done, total) => {
        setLoading(`Loading scenery around ${cfg.airport.icao}… (${done}/${total})`, (0.6 * done) / total);
      });
      setLoading(`Starting the ${def.short} at ${cfg.airport.icao} runway ${cfg.runway.id}…`, 0.65);
      this.sim.setAircraft(await aircraftData, def.Systems);
      await new Promise((r) => setTimeout(r, 0));
      this.sim.start(cfg);
      this.def = def;
      document.body.dataset.aircraft = def.id;
      this.sky.setVisibility(cfg.visibilityM);
      this.speedUp = 1;
      this.paused = false;
      this.crashNotified = false;
      this.easterEggShown = false;
      this.aircraft = this.sim.aircraft;
      if (!this.nasal) {
        this.nasal = new NasalRuntime(this.sim.props, {
          popupTip: (m) => this.hud.message(m),
          namespaces: {
            controls: this.controls,
            c172p: createC172pNamespace(this),
            clock: { astrotech: { left_knob() {}, right_knob() {}, select_mode() {} } },
            aircraft: { HUD: { cycle_brightness() {}, cycle_type() {}, normal_type() {}, cycle_color() {} } },
          },
        });
      }
      this.nasal.reset();
      await this.useAircraft(def);
      if (cfg.onGround) {
        // Hold the aircraft while the engine settles from JSBSim's running
        // start; B releases the parking brake.
        this.sim.props.set("/controls/gear/brake-parking", 1);
      }
      this.sound.attach(this.sim.props);
      this.views.configureCockpit(this.sim.props);
      if (!this.viewChosen) this.views.setView(0);
      this.views.reset();
      this.sim.props.set("/sim/current-view/view-number", this.views.index);
      this.sim.props.set("/sim/current-view/internal", this.views.view.type === "cockpit");
      hideLoading();
      if (!this.hudShown) {
        this.hudShown = true;
        this.hud.toggle(true);
      }
      this.flying = true;
      document.body.classList.add("flying");
      const where = cfg.onGround ? `runway ${cfg.runway.id}` : sel.position === "final" ? `final approach, runway ${cfg.runway.id}` : "in the air";
      this.hud.message(`${def.short} · ${cfg.airport.name} (${cfg.airport.icao}), ${where}`, 4);
      if (cfg.onGround && cfg.running) this.hud.message("Parking brake set: B releases it, Page Up adds power", 6);
      if (cfg.running && def.id === "f16") this.hud.message("Throttle above 50% is afterburner · g gear up, G gear down", 6);
      if (!cfg.running) this.hud.message("Engine off: Shift+S runs the autostart", 6);
      // Handle for the browser tests and for poking around in the console.
      window.__fg = this;
      this.THREE = THREE;
    } catch (err) {
      showError(err);
    }
  }

  reset() {
    if (this.startSel) this.start(this.startSel);
  }

  // ------------------------------------------------------------ actions

  openMenu() {
    this.menu.open();
  }

  togglePause(on = !this.paused) {
    this.paused = on;
    document.body.classList.toggle("paused", on);
    this.hud.message(on ? "Paused (p to resume)" : "Resumed");
  }

  /** The F-16's head-up display ('H'). */
  toggleFighterHud() {
    if (this.def?.id !== "f16") return;
    this.hud.message(this.fighterHud.toggle() ? "HUD on" : "HUD off", 1.2);
  }

  toggleHelp(on) {
    const el = $("help");
    el.hidden = on === undefined ? !el.hidden : !on;
  }

  setView(i) {
    this.viewChosen = true;
    const name = this.views.setView(i);
    this.sim.props.set("/sim/current-view/view-number", this.views.index);
    this.sim.props.set("/sim/current-view/internal", this.views.view.type === "cockpit");
    this.hud.message(name, 1.5);
  }

  stepView(dir) {
    this.setView(this.views.index + (dir > 0 ? 1 : -1));
  }

  zoom(dir) {
    const v = this.views.zoom(dir);
    if (this.views.view.type !== "tower") this.hud.message(`FOV: ${v.toFixed(1)}`, 1);
  }

  wheelZoom(dir) {
    this.views.wheel(-dir);
  }

  autostart() {
    const msg = this.aircraft?.autostart();
    if (msg) this.hud.message(msg);
  }

  timeWarp(seconds) {
    this.sim.warpTime(seconds);
  }

  adjustVisibility(f) {
    const v = Math.max(500, Math.min(80000, this.sky.visibilityM * f));
    this.sky.setVisibility(v);
    this.sim.props.set("/environment/visibility-m", v);
    this.hud.message(`Visibility: ${(v / 1000).toFixed(1)} km`, 1);
  }

  message(text) {
    this.hud.message(text);
  }

  // ------------------------------------------------------------ loop

  aircraftState() {
    const p = this.sim.props;
    const n = (this.acNodes ??= {
      lat: p.node("/position/latitude-deg"), lon: p.node("/position/longitude-deg"), alt: p.node("/position/altitude-ft"),
      roll: p.node("/orientation/roll-deg"), pitch: p.node("/orientation/pitch-deg"), hdg: p.node("/orientation/heading-deg"),
      vN: p.node("/velocities/speed-north-fps"), vE: p.node("/velocities/speed-east-fps"), vD: p.node("/velocities/speed-down-fps"),
    });
    return {
      lat: n.lat.get(), lon: n.lon.get(), alt: n.alt.get() * FT,
      roll: n.roll.get(), pitch: n.pitch.get(), heading: n.hdg.get(),
      vN: n.vN.get() * FT, vE: n.vE.get() * FT, vD: n.vD.get() * FT,
    };
  }

  loop(now) {
    requestAnimationFrame((t) => this.loop(t));
    const dt = Math.min(0.1, Math.max(0, (now - (this.last ?? now)) / 1000));
    this.last = now;
    this.frameDt = dt;
    if (!this.flying) {
      if (this.model || this.scenery.tiles.size) this.render(dt);
      return;
    }
    const t0 = performance.now();
    this.input.update(dt);
    this.touch.update(dt);
    this.onFrame?.(dt); // test hook (tools/e2e)
    const running = !this.paused && !this.menu.isOpen;
    this.sim.fdm.setGroundMaterial(this.scenery.lastMaterial);
    this.sim.update(dt, { paused: !running, speedUp: this.speedUp });
    if (running) this.nasal.update(dt * this.speedUp);
    this.sound.suspend(!running);
    this.simMs = performance.now() - t0;

    const ac = this.aircraftState();
    this.ac = ac;
    this.sceneryTimer -= dt;
    if (this.sceneryTimer <= 0) {
      this.sceneryTimer = 1;
      const c = this.debugCamera ?? ac;
      this.scenery.update(c.lat, c.lon, this.radiusKm);
      this.checkEasterEgg(ac);
    }
    if (this.sim.fdm.crashed && !this.crashNotified) {
      this.crashNotified = true;
      this.hud.message("Crashed! Press Shift+Esc to try again.", 8);
    }
    this.render(dt, ac);
  }

  render(dt, ac = this.ac) {
    if (!this.flying && !ac) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.time += dt;
    aircraftMatrix(this.frame, ac.lat, ac.lon, ac.alt, ac.roll, ac.pitch, ac.heading, this.aircraftGroup.matrix);
    this.aircraftGroup.matrixWorldNeedsUpdate = true;
    let info;
    if (this.debugCamera) {
      // {lat, lon, alt, at: {lat, lon, alt}, fov}: a fixed camera for tests and screenshots.
      const d = this.debugCamera;
      const cam = this.camera;
      this.frame.geodeticToRender(d.lat, d.lon, d.alt, cam.position);
      this.frame.upAt(cam.position, cam.up);
      cam.lookAt(this.frame.geodeticToRender(d.at.lat, d.at.lon, d.at.alt));
      cam.fov = d.fov ?? 50;
      cam.near = 1;
      cam.aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      info = { name: "Debug camera" };
    } else {
      info = this.views.update(dt, ac, this.camera);
    }
    this.model?.update(dt, this.camera);
    if (this.def?.id === "f16" && this.views.view.type === "cockpit" && !this.debugCamera) {
      const b = enuBasis(ac.lat, ac.lon);
      const f = this.frame;
      f.dirToRender(b.e, this.enu.e);
      f.dirToRender(b.n, this.enu.n);
      f.dirToRender(b.u, this.enu.u);
      this.fighterHud.draw(this.camera, this.aircraftGroup.matrix, this.enu, this.sim.props);
    } else {
      this.fighterHud.clear();
    }
    this.objects.update(dt, this.camera, this.scenery, ac.lat, ac.lon);
    const listener = this.views.view.type === "cockpit" && !this.debugCamera ? 0
      : this.camera.position.distanceTo(this.tmpPos.setFromMatrixPosition(this.aircraftGroup.matrix));
    this.sound?.update(dt, listener);
    this.sky.update(this.frame, this.camera, this.sim.date);
    this.lights.update(this.time);
    sceneryUniforms.time.value = this.time;
    this.hud.update(dt, this.sim.props, { view: info.name, aircraft: this.def?.id });
    this.renderer.render(this.scene, this.camera);
  }

  /** A small nod to the Bay Area's football fans; see README. */
  checkEasterEgg(ac) {
    if (this.easterEggShown) return;
    const dLat = (ac.lat - 37.4033) * 111000;
    const dLon = (ac.lon + 121.9694) * 88000;
    const agl = this.sim.props.get("/position/altitude-agl-ft");
    if (Math.hypot(dLat, dLon) < 1200 && agl < 3000 && agl > 200) {
      this.easterEggShown = true;
      // Fighter flyovers open the big games; the tight end spikes one for it.
      this.hud.message(this.def?.id === "f16"
        ? "Flyover at Levi's Stadium! 68,500 fans roar and a certain 49ers tight end spikes the ball."
        : "Levi's Stadium below, home of the 49ers. Nice YAC: yards after climb.", 6);
    }
  }
}

const app = new App();
app.boot().catch(showError);
