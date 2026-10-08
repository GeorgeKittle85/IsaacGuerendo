// The start menu: aircraft, region, airport, runway, start position, time of
// day and weather.  The last choices are remembered in this browser
// (localStorage).

import { AIRCRAFT, aircraftById } from "../aircraft/registry.js";
import { activeRunway } from "../atc/groundnet.js";

const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";
const STORE_KEY = "fgweb.menu.v1";

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
  } catch {
    return null;
  }
}

function save(sel) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(sel));
  } catch {
    // Private mode or storage disabled: nothing to remember.
  }
}

export { activeRunway };

export class Menu {
  /** regions: airports.json's [{id, name, default}]; each airport has its region's id. */
  constructor(app, airports, regions = []) {
    this.app = app;
    this.airports = airports;
    this.regions = regions.length ? regions : [{ id: undefined, name: "Airports", default: airports[0]?.icao }];
    this.el = $("menu");
    this.form = $("menu-form");
    this.f = {
      region: $("m-region"), airport: $("m-airport"), runway: $("m-runway"), position: $("m-position"), time: $("m-time"),
      vis: $("m-vis"), windDir: $("m-wind-dir"), windKt: $("m-wind-kt"), range: $("m-range"), gate: $("m-gate"),
    };
    this.buildAircraftPicker();
    for (const r of this.regions) {
      const o = document.createElement("option");
      o.value = r.id ?? "";
      o.textContent = `${r.name} (${this.airportsIn(r.id).length} airports)`;
      this.f.region.append(o);
    }
    $("m-region-row").hidden = this.regions.length < 2;
    const saved = load();
    // Smaller scenery radius by default on phones and tablets.
    if (!saved && app.mobile) this.f.range.value = "15";
    const savedApt = airports.find((a) => a.icao === saved?.airport);
    this.f.region.value = (savedApt ?? airports.find((a) => a.icao === "KSFO") ?? airports[0])?.region ?? "";
    this.fillAirports(savedApt?.icao);
    this.aircraft = aircraftById(saved?.aircraft).id;
    if (saved) {
      if (saved.position) this.f.position.value = saved.position;
      if (saved.time) this.f.time.value = saved.time;
      if (saved.visibilityM) this.f.vis.value = String(saved.visibilityM);
      if (saved.windDir !== undefined) this.f.windDir.value = saved.windDir;
      if (saved.windKt !== undefined) this.f.windKt.value = saved.windKt;
      if (saved.radiusKm) this.f.range.value = String(saved.radiusKm);
    }
    this.fillRunways(saved?.airport === this.f.airport.value ? saved.runway : null);
    this.savedGate = saved?.airport === this.f.airport.value ? saved.gate : null;
    this.fillGates();
    this.f.region.addEventListener("change", () => {
      this.fillAirports(null);
      this.fillRunways(null);
      this.fillGates();
    });
    this.f.airport.addEventListener("change", () => {
      this.fillRunways(null);
      this.fillGates();
    });
    this.f.position.addEventListener("change", () => this.showGates());
    this.f.gate.addEventListener("change", () => { this.savedGate = this.f.gate.value; });
    for (const k of ["windDir", "windKt"]) {
      this.f[k].addEventListener("change", () => {
        if (!this.runwayTouched) this.fillRunways(null);
      });
    }
    this.f.runway.addEventListener("change", () => { this.runwayTouched = true; });
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const sel = this.selection();
      save(sel);
      this.app.start(sel);
    });
    $("m-resume").addEventListener("click", () => this.close());
    $("m-help").addEventListener("click", () => this.app.toggleHelp(true));
  }

  /** One card per aircraft: a radio group, so arrow keys switch between them. */
  buildAircraftPicker() {
    const box = $("m-aircraft-cards");
    this.aircraftInputs = AIRCRAFT.map((a) => {
      const label = document.createElement("label");
      label.className = "ac-card";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "aircraft";
      input.value = a.id;
      input.addEventListener("change", () => {
        this.aircraft = a.id;
        this.fillGates();
      });
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", "0 0 64 64");
      svg.setAttribute("aria-hidden", "true");
      svg.classList.add("ac-icon");
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", a.icon);
      svg.append(path);
      const text = document.createElement("span");
      text.className = "ac-text";
      const name = document.createElement("span");
      name.className = "ac-name";
      name.textContent = a.name;
      const blurb = document.createElement("span");
      blurb.className = "ac-blurb";
      blurb.textContent = a.blurb;
      text.append(name, blurb);
      label.append(input, svg, text);
      box.append(label);
      return input;
    });
  }

  get aircraft() {
    return this.aircraftInputs.find((i) => i.checked)?.value ?? AIRCRAFT[0].id;
  }

  set aircraft(id) {
    for (const i of this.aircraftInputs) i.checked = i.value === id;
    $("m-fly").textContent = `Fly the ${aircraftById(id).short}`;
  }

  get airport() {
    return this.airports.find((a) => a.icao === this.f.airport.value) ?? this.airports[0];
  }

  airportsIn(region) {
    return this.airports.filter((a) => (a.region ?? undefined) === (region ?? undefined));
  }

  /** The region's airports, those with a control tower first, each group biggest first. */
  fillAirports(preferred) {
    const region = this.regions.find((r) => (r.id ?? "") === this.f.region.value) ?? this.regions[0];
    const list = this.airportsIn(region.id);
    const sel = this.f.airport;
    sel.textContent = "";
    for (const [label, towered] of [["With a control tower", true], ["Without a tower", false]]) {
      const og = document.createElement("optgroup");
      og.label = label;
      for (const a of list.filter((x) => !!(x.towered ?? x.tower) === towered)) {
        const o = document.createElement("option");
        o.value = a.icao;
        o.textContent = `${a.icao} · ${a.name}`;
        og.append(o);
      }
      if (og.children.length) sel.append(og);
    }
    const pick = [preferred, region.default].find((icao) => list.some((a) => a.icao === icao)) ?? list[0]?.icao;
    if (pick) sel.value = pick;
  }

  fillRunways(preferred) {
    const apt = this.airport;
    const sel = this.f.runway;
    sel.textContent = "";
    for (const r of apt.runways) {
      const o = document.createElement("option");
      o.value = r.id;
      o.textContent = `${r.id} · ${Math.round(r.heading)}° · ${Math.round(r.lengthM).toLocaleString("en-US")} m`;
      o.title = `${r.surface}, ${Math.round(r.heading)}° true`;
      sel.append(o);
    }
    const active = activeRunway(apt, +this.f.windDir.value || 0, +this.f.windKt.value || 0);
    sel.value = preferred && apt.runways.some((r) => r.id === preferred) ? preferred : active.id;
    this.runwayTouched = !!preferred;
  }

  get gateStart() {
    return this.f.position.value.startsWith("gate");
  }

  showGates() {
    $("m-gate-row").hidden = !this.gateStart;
  }

  /**
   * The airport's parking positions that fit the aircraft (its ground
   * network, atc/groundnet.js), grouped by kind, the kind it would use first.
   */
  async fillGates() {
    this.showGates();
    const icao = this.f.airport.value;
    const def = aircraftById(this.aircraft);
    const sel = this.f.gate;
    const hint = $("m-gate-hint");
    const net = await this.app.groundnet(icao);
    if (icao !== this.f.airport.value || def.id !== this.aircraft) return; // changed meanwhile
    sel.textContent = "";
    const spots = net?.parkingFor(def.wingspanM) ?? [];
    const gateOpts = [...this.f.position.options].filter((o) => o.value.startsWith("gate"));
    for (const o of gateOpts) o.disabled = !spots.length;
    if (!spots.length) {
      hint.textContent = net ? `No parking spot at ${icao} fits the ${def.short}.` : `${icao} has no gates in FlightGear's data.`;
      if (this.gateStart) this.f.position.value = "runway";
      this.showGates();
      return;
    }
    hint.textContent = net.hasTaxiways ? "" : "No taxiway data here: ATC gives no taxi route.";
    const groups = [["gate", "Gates"], ["cargo", "Cargo"], ["ga", "General aviation"], ["tie-down", "Tie-downs"],
      ["tie_down", "Tie-downs"], ["hangar", "Hangars"], ["mil-fighter", "Military"], ["mil-cargo", "Military"]];
    const label = new Map(groups);
    const byGroup = new Map();
    for (const p of spots) {
      const g = label.get(p.type) ?? "Other";
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(p);
    }
    for (const [g, list] of byGroup) {
      const og = document.createElement("optgroup");
      og.label = g;
      for (const p of list.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))) {
        const o = document.createElement("option");
        o.value = p.name;
        o.textContent = p.name;
        og.append(o);
      }
      sel.append(og);
    }
    const prefer = [...(def.parking ?? []), "gate"];
    const first = prefer.map((t) => spots.find((p) => p.type === t)).find(Boolean) ?? spots[0];
    sel.value = this.savedGate && spots.some((p) => p.name === this.savedGate) ? this.savedGate : first.name;
  }

  selection() {
    return {
      aircraft: this.aircraft,
      region: this.f.region.value || null,
      airport: this.f.airport.value,
      runway: this.f.runway.value,
      gate: this.f.gate.value || null,
      position: this.f.position.value,
      time: this.f.time.value,
      visibilityM: +this.f.vis.value,
      windDir: ((+this.f.windDir.value % 360) + 360) % 360,
      windKt: Math.max(0, +this.f.windKt.value || 0),
      radiusKm: +this.f.range.value,
    };
  }

  /**
   * ?autostart&aircraft=f16&airport=KSFO&runway=28R&position=final&time=dusk&wind=280@8&vis=35000&range=25&gate=D55,
   * or &region=oregon for that region's main airport.
   */
  readParams(params) {
    const sel = this.selection();
    if (params.get("aircraft")) sel.aircraft = aircraftById(params.get("aircraft").toLowerCase()).id;
    const region = this.regions.find((r) => r.id && r.id === params.get("region")?.toLowerCase());
    if (region?.default) sel.airport = region.default;
    if (params.get("airport")) sel.airport = params.get("airport").toUpperCase();
    const apt = this.airports.find((a) => a.icao === sel.airport) ?? this.airport;
    sel.airport = apt.icao;
    sel.region = apt.region ?? null;
    const wind = /^(\d+)@(\d+)$/.exec(params.get("wind") ?? "");
    if (wind) {
      sel.windDir = +wind[1];
      sel.windKt = +wind[2];
    }
    sel.runway = params.get("runway")?.toUpperCase() ?? activeRunway(apt, sel.windDir, sel.windKt).id;
    for (const k of ["position", "time", "gate"]) if (params.get(k)) sel[k] = params.get(k);
    if (params.get("gate") && !params.get("position")) sel.position = "gate";
    if (params.get("vis")) sel.visibilityM = +params.get("vis");
    if (params.get("range")) sel.radiusKm = +params.get("range");
    return sel;
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open() {
    $("m-resume").hidden = !this.app.flying;
    this.el.hidden = false;
    document.body.classList.add("menu-open");
    // Enter flies; don't scroll short screens down to the button.
    this.el.scrollTop = 0;
    setTimeout(() => $("m-fly").focus({ preventScroll: true }), 0);
  }

  close() {
    this.el.hidden = true;
    document.body.classList.remove("menu-open");
    this.app.canvas.focus();
  }
}
