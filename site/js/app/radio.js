// The radio: what ATC and the pushback crew say (shown, and spoken with the
// browser's speech synthesis), the progressive taxi guidance, and the ATC
// menu FlightGear opens with the ' key.

import { formatFrequency } from "../atc/groundnet.js";

const $ = (id) => document.getElementById(id);
const VOICE_KEY = "fgweb.atc.voice";

function loadVoicePref() {
  try {
    return localStorage.getItem(VOICE_KEY) !== "off";
  } catch {
    return true;
  }
}

export class Radio {
  constructor(app) {
    this.app = app;
    this.voice = loadVoicePref();
    this.build();
  }

  build() {
    const el = document.createElement("section");
    el.id = "atc";
    el.setAttribute("aria-label", "Radio");
    el.innerHTML = `
      <header><span class="freq" id="atc-station"></span><button type="button" id="atc-open" title="ATC menu (')">ATC</button></header>
      <div id="atc-guide" hidden>
        <div class="next"><span id="atc-next"></span><span class="dist" id="atc-dist"></span></div>
        <div class="summary" id="atc-summary"></div>
      </div>
      <ol id="atc-log" aria-live="polite"></ol>
      <div id="atc-menu" hidden role="menu"></div>`;
    document.body.append(el);
    this.el = el;
    $("atc-open").addEventListener("click", (e) => {
      e.currentTarget.blur();
      this.toggleMenu();
    });
  }

  reset() {
    $("atc-log").textContent = "";
    this.clearGuidance();
    this.closeMenu();
  }

  setStation(st) {
    if (!st) return;
    $("atc-station").textContent = st.freq ? `${st.name} · ${formatFrequency(st.freq)}` : st.name;
  }

  /** {station, freq, text, speech, pilot, crew} */
  transmit(m) {
    const li = document.createElement("li");
    li.className = m.pilot ? "pilot" : m.crew ? "crew" : "atc";
    const who = document.createElement("b");
    who.textContent = m.station;
    li.append(who, document.createTextNode(` ${m.text}`));
    const log = $("atc-log");
    log.append(li);
    while (log.children.length > 3) log.firstChild.remove();
    // Old calls fade, then get out of the way.
    setTimeout(() => li.classList.add("old"), 20000);
    setTimeout(() => li.remove(), 45000);
    if (m.speech && !m.pilot) this.speak(m.speech, m.crew);
  }

  speak(text, crew) {
    const synth = window.speechSynthesis;
    if (!this.voice || this.app.muted || !synth || typeof SpeechSynthesisUtterance === "undefined") return;
    const u = new SpeechSynthesisUtterance(text);
    const voices = synth.getVoices().filter((v) => v.lang?.startsWith("en"));
    // A different voice for the ground crew than for the controllers.
    const pick = voices.filter((v) => /US|GB/.test(v.lang));
    if (pick.length) u.voice = pick[crew ? Math.min(1, pick.length - 1) : 0];
    u.rate = crew ? 1.0 : 1.12;
    u.pitch = crew ? 0.85 : 1.0;
    u.lang = "en-US";
    // Do not let a backlog build up: controllers talk over stale calls.
    if (synth.pending) synth.cancel();
    synth.speak(u);
  }

  setVoice(on) {
    this.voice = on;
    try {
      localStorage.setItem(VOICE_KEY, on ? "on" : "off");
    } catch {
      // Private mode: the choice lasts for this visit.
    }
    if (!on) window.speechSynthesis?.cancel();
  }

  /** {next, distance (m), summary, hold} */
  setGuidance(g) {
    $("atc-guide").hidden = false;
    $("atc-guide").classList.toggle("hold", !!g.hold);
    const next = $("atc-next");
    if (next.textContent !== g.next) next.textContent = g.next;
    const d = g.distance;
    $("atc-dist").textContent = d === undefined || d < 1 ? "" : d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`;
    if ($("atc-summary").textContent !== g.summary) $("atc-summary").textContent = g.summary ?? "";
  }

  clearGuidance() {
    $("atc-guide").hidden = true;
  }

  // ---------------------------------------------------------------- menu

  get menuOpen() {
    return !$("atc-menu").hidden;
  }

  toggleMenu() {
    if (this.menuOpen) this.closeMenu();
    else this.openMenu();
  }

  openMenu() {
    const atc = this.app.atc;
    const items = [...(atc?.options() ?? [])];
    const route = this.app.routeView;
    items.push({ label: `ATC voice: ${this.voice ? "on" : "off"}`, run: () => this.setVoice(!this.voice) });
    if (route) items.push({ label: `Taxi line on the ground: ${route.visible ? "shown" : "hidden"}`, run: () => route.setVisible(!route.visible) });
    this.items = items;
    const box = $("atc-menu");
    box.textContent = "";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "Say to ATC (1–9, Esc closes)";
    box.append(title);
    items.forEach((it, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.innerHTML = `<kbd>${i + 1}</kbd>`;
      b.append(document.createTextNode(` ${it.label}`));
      b.addEventListener("click", (e) => {
        e.currentTarget.blur();
        this.choose(i);
      });
      box.append(b);
    });
    box.hidden = false;
  }

  closeMenu() {
    $("atc-menu").hidden = true;
  }

  choose(i) {
    const it = this.items?.[i];
    this.closeMenu();
    it?.run();
  }

  /** Keys while the menu is open: digits choose, Esc and ' close. */
  key(e) {
    if (!this.menuOpen) return false;
    const digit = /^(Digit|Numpad)([1-9])$/.exec(e.code);
    if (digit) {
      this.choose(+digit[2] - 1);
      return true;
    }
    if (e.key === "Escape" || e.key === "'") {
      this.closeMenu();
      return true;
    }
    return false;
  }
}
