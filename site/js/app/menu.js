// The start menu: airport, runway, start position, time of day and weather.
// The last choices are remembered in this browser (localStorage).

const $ = (id) => document.getElementById(id);
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

/** The runway with the most headwind (FlightGear picks the active runway the same way). */
export function activeRunway(airport, windFromDeg, windKt) {
  let best = airport.runways[0];
  let bestScore = -Infinity;
  for (const r of airport.runways) {
    const head = windKt * Math.cos(((windFromDeg - r.heading) * Math.PI) / 180);
    const score = head * 1000 + r.lengthM / 10;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

export class Menu {
  constructor(app, airports) {
    this.app = app;
    this.airports = airports;
    this.el = $("menu");
    this.form = $("menu-form");
    this.f = {
      airport: $("m-airport"), runway: $("m-runway"), position: $("m-position"), time: $("m-time"),
      vis: $("m-vis"), windDir: $("m-wind-dir"), windKt: $("m-wind-kt"), range: $("m-range"),
    };
    for (const a of airports) {
      const o = document.createElement("option");
      o.value = a.icao;
      o.textContent = `${a.icao} · ${a.name}`;
      this.f.airport.append(o);
    }
    const saved = load();
    // Smaller scenery radius by default on phones and tablets.
    if (!saved && app.mobile) this.f.range.value = "15";
    this.f.airport.value = saved?.airport && airports.some((a) => a.icao === saved.airport) ? saved.airport : "KSFO";
    if (saved) {
      if (saved.position) this.f.position.value = saved.position;
      if (saved.time) this.f.time.value = saved.time;
      if (saved.visibilityM) this.f.vis.value = String(saved.visibilityM);
      if (saved.windDir !== undefined) this.f.windDir.value = saved.windDir;
      if (saved.windKt !== undefined) this.f.windKt.value = saved.windKt;
      if (saved.radiusKm) this.f.range.value = String(saved.radiusKm);
    }
    this.fillRunways(saved?.airport === this.f.airport.value ? saved.runway : null);
    this.f.airport.addEventListener("change", () => this.fillRunways(null));
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

  get airport() {
    return this.airports.find((a) => a.icao === this.f.airport.value) ?? this.airports[0];
  }

  fillRunways(preferred) {
    const apt = this.airport;
    const sel = this.f.runway;
    sel.textContent = "";
    for (const r of apt.runways) {
      const o = document.createElement("option");
      o.value = r.id;
      o.textContent = `${r.id} · ${Math.round(r.heading)}° true · ${Math.round(r.lengthM).toLocaleString("en-US")} m ${r.surface}`;
      sel.append(o);
    }
    const active = activeRunway(apt, +this.f.windDir.value || 0, +this.f.windKt.value || 0);
    sel.value = preferred && apt.runways.some((r) => r.id === preferred) ? preferred : active.id;
    this.runwayTouched = !!preferred;
  }

  selection() {
    return {
      airport: this.f.airport.value,
      runway: this.f.runway.value,
      position: this.f.position.value,
      time: this.f.time.value,
      visibilityM: +this.f.vis.value,
      windDir: ((+this.f.windDir.value % 360) + 360) % 360,
      windKt: Math.max(0, +this.f.windKt.value || 0),
      radiusKm: +this.f.range.value,
    };
  }

  /** ?autostart&airport=KSFO&runway=28R&position=final&time=dusk&wind=280@8&vis=35000&range=25 */
  readParams(params) {
    const sel = this.selection();
    if (params.get("airport")) sel.airport = params.get("airport").toUpperCase();
    const apt = this.airports.find((a) => a.icao === sel.airport) ?? this.airport;
    sel.airport = apt.icao;
    const wind = /^(\d+)@(\d+)$/.exec(params.get("wind") ?? "");
    if (wind) {
      sel.windDir = +wind[1];
      sel.windKt = +wind[2];
    }
    sel.runway = params.get("runway")?.toUpperCase() ?? activeRunway(apt, sel.windDir, sel.windKt).id;
    for (const k of ["position", "time"]) if (params.get(k)) sel[k] = params.get(k);
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
    setTimeout(() => $("m-fly").focus(), 0);
  }

  close() {
    this.el.hidden = true;
    document.body.classList.remove("menu-open");
    this.app.canvas.focus();
  }
}
