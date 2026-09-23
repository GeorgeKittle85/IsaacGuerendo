// On-screen flight data strip, FlightGear-style popup messages and pick
// tooltips.  Plain DOM, refreshed a few times per second.

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.root = $("hud");
    this.msgBox = $("messages");
    this.tip = $("tooltip");
    this.status = $("status");
    this.cells = {};
    for (const el of this.root.querySelectorAll("[data-k]")) this.cells[el.dataset.k] = el;
    this.visible = true;
    this.timer = 0;
    this.fps = 0;
    this.frames = 0;
    this.fpsStart = null;
  }

  toggle(on = !this.visible) {
    this.visible = on;
    this.root.hidden = !on;
    return on;
  }

  /** 'h': compact strip -> full strip -> hidden -> compact. */
  cycle() {
    if (!this.visible) {
      this.toggle(true);
      this.root.classList.remove("full");
      return "compact";
    }
    if (!this.root.classList.contains("full")) {
      this.root.classList.add("full");
      return "full";
    }
    this.toggle(false);
    return "off";
  }

  /** gui.popupTip(): a short message at the top of the screen. */
  message(text, seconds = 2.5) {
    const el = document.createElement("div");
    el.className = "msg";
    el.textContent = text;
    this.msgBox.append(el);
    while (this.msgBox.children.length > 4) this.msgBox.firstChild.remove();
    setTimeout(() => el.classList.add("fade"), seconds * 1000);
    setTimeout(() => el.remove(), seconds * 1000 + 600);
  }

  showTooltip(text, x, y) {
    if (!text) {
      this.tip.hidden = true;
      return;
    }
    this.tip.hidden = false;
    this.tip.textContent = text;
    const w = this.tip.offsetWidth;
    this.tip.style.left = `${Math.min(window.innerWidth - w - 8, x + 14)}px`;
    this.tip.style.top = `${y + 18}px`;
  }

  setStatus(text) {
    this.status.textContent = text;
    this.status.hidden = !text;
  }

  update(dt, p, extra) {
    // Frame rate from wall-clock time (dt is capped for the simulation).
    const now = performance.now();
    this.frames++;
    this.fpsStart ??= now;
    if (now - this.fpsStart >= 1000) {
      this.fps = Math.round((this.frames * 1000) / (now - this.fpsStart));
      this.frames = 0;
      this.fpsStart = now;
    }
    this.timer -= dt;
    if (this.timer > 0 || !this.visible) return;
    this.timer = 0.12;
    const c = this.cells;
    const set = (k, v) => { if (c[k] && c[k].textContent !== v) c[k].textContent = v; };
    const g = (path) => p.get(path);
    set("ias", g("/instrumentation/airspeed-indicator/indicated-speed-kt").toFixed(0));
    set("alt", Math.round(g("/instrumentation/altimeter/indicated-altitude-ft")).toLocaleString("en-US"));
    set("agl", Math.max(0, g("/position/altitude-agl-ft")).toFixed(0));
    const hdg = Math.round(g("/orientation/heading-magnetic-deg")) % 360;
    set("hdg", String(hdg === 0 ? 360 : hdg).padStart(3, "0"));
    set("vs", (Math.round(g("/velocities/vertical-speed-fps") * 60 / 10) * 10).toString());
    set("thr", `${Math.round(g("/controls/engines/engine[0]/throttle") * 100)}%`);
    set("rpm", g("/engines/active-engine/rpm").toFixed(0));
    set("mix", `${Math.round(g("/controls/engines/current-engine/mixture") * 100)}%`);
    set("flaps", `${Math.round(g("/surface-positions/flap-pos-norm") * 30)}°`);
    set("trim", (g("/controls/flight/elevator-trim") * 100).toFixed(0));
    const brakes = p.getBool("/controls/gear/brake-parking") ? "PARK" :
      Math.max(g("/controls/gear/brake-left"), g("/controls/gear/brake-right")) > 0.05 ? "ON" : "off";
    set("brk", brakes);
    const fuel = g("/consumables/fuel/tank[0]/level-gal_us") + g("/consumables/fuel/tank[1]/level-gal_us");
    set("fuel", `${fuel.toFixed(1)} gal`);
    set("view", extra.view);
    set("fps", String(this.fps));
    const mags = ["OFF", "R", "L", "BOTH"][g("/controls/switches/magnetos")] ?? "?";
    set("mag", mags);
    c.warn?.classList.toggle("on", g("/sim/alarms/stall-warning") > 0.5);
  }
}
