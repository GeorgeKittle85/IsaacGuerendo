// The AI air traffic controller: San Francisco Ground, Tower and NorCal
// Departure for the airport you start at, in the spirit of FlightGear's
// ATC (src/ATC, which clears AI traffic along the same ground networks).
//
// It follows the flight through phases and offers what a pilot would ask
// for at each (the ' key opens the menu, as FlightGear's ATC dialog):
//
//   parked     at a gate: request pushback (the tug, pushback.js), or taxi
//   pushback   the tug pushes along the gate's pushback route
//   ready      request taxi: Ground clears you to the runway via named
//              taxiways (the route from groundnet.js), with runway crossings
//              and the hold short point
//   taxi-out   progressive taxi: "turn left on Foxtrot" before each turn,
//              a new route if you miss one, a warning at the hold line
//   holding    at the runway: "contact Tower"; ready for departure
//   cleared    cleared for takeoff; after takeoff, over to Departure
//   airborne   request landing at the nearest airport
//   landing    cleared to land; after the landing roll, over to Ground
//   landed     request taxi to a gate: Ground picks a free one that fits
//   taxi-in    progressive taxi to the gate; parked again on arrival
//
// Messages go to the radio panel and are spoken (app/radio.js); the route is
// drawn on the ground (taxiroute.js).

import { GroundNet, activeRunway, sayTaxiway, sayRunway, sayDigits, sayFrequency, formatFrequency, sayList } from "./groundnet.js";
import { Pushback } from "./pushback.js";

const KT = 0.514444;
const D2R = Math.PI / 180;

/** Station names: the city, as the controllers say it. */
const CITY = {
  KSFO: "San Francisco", KOAK: "Oakland", KSJC: "San Jose", KHWD: "Hayward", KLVK: "Livermore",
  KCCR: "Concord", KNUQ: "Moffett", KPAO: "Palo Alto", KSQL: "San Carlos", KHAF: "Half Moon Bay",
  KSCK: "Stockton", KRHV: "Reid-Hillview", E16: "San Martin", KTCY: "Tracy", C83: "Byron",
};
const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

const wrap360 = (a) => ((a % 360) + 360) % 360;

export class ATC {
  /**
   * app: {sim, def, airports, radio (app/radio.js), routeView (taxiroute.js),
   *       groundnet(icao) -> Promise<GroundNet|null>, message(text)}
   */
  constructor(app) {
    this.app = app;
    this.phase = "idle";
    this.pushback = null;
    this.timer = 0;
  }

  get props() {
    return this.app.sim.props;
  }

  get def() {
    return this.app.def;
  }

  // ------------------------------------------------------------- set-up

  /** A new flight: cfg from App.startConfig, net the airport's GroundNet (or null). */
  begin(cfg, net) {
    this.pushback?.reset();
    this.pushback = new Pushback(this.app.sim, this.def.tug, (t) => this.tug(t));
    this.airport = cfg.airport;
    this.net = net && net.icao === cfg.airport.icao ? net : null;
    this.runwayId = cfg.runway.id;
    this.parking = cfg.parking ?? null;
    this.pushed = false;
    this.route = null;
    this.app.routeView?.clear();
    this.landingAirport = null;
    this.warned = {};
    this.offTimer = 0;
    this.holdTimer = 0;
    this.lastReroute = -1e9;
    this.clock = 0;
    this.phase = cfg.parking ? "parked" : cfg.onGround ? "lined-up" : cfg.position === "final" ? "final" : "airborne";
    if (cfg.position === "final") this.landingAirport = this.airport;
    this.app.radio?.setStation(this.station(this.phase === "parked" ? "ground" : "tower"));
    this.app.radio?.clearGuidance();
  }

  // ------------------------------------------------------------ helpers

  get callsign() {
    return this.def.callsign;
  }

  city(apt = this.airport) {
    return CITY[apt.icao] ?? apt.name.replace(/\b(Intl|International|Muni|Municipal|Executive|Field|Airport|Metropolitan|Metro)\b/gi, "").trim();
  }

  get towered() {
    return !!this.airport?.tower;
  }

  /** {name, freq} of a facility: ground, tower, departure. */
  station(kind, apt = this.airport, net = this.net) {
    const f = net?.icao === apt.icao ? net.frequencies : {};
    if (!apt.tower) return { name: `${this.city(apt)} Traffic`, freq: f.unicom ?? 122.8 };
    if (kind === "ground") return { name: `${this.city(apt)} Ground`, freq: f.ground };
    if (kind === "tower") return { name: `${this.city(apt)} Tower`, freq: f.tower };
    return { name: "NorCal Departure", freq: f.departure ?? f.approach };
  }

  /** Aircraft position on the airport's local plane, heading, speed. */
  where() {
    const p = this.props;
    const lat = p.get("/position/latitude-deg"), lon = p.get("/position/longitude-deg");
    const pos = this.net ? this.net.xy(lat, lon) : { x: 0, y: 0 };
    return {
      lat, lon, ...pos, heading: p.get("/orientation/heading-deg"),
      gsKt: p.get("/velocities/groundspeed-kt"), agl: p.get("/position/altitude-agl-ft"),
      wow: p.getBool("/gear/gear[1]/wow") || p.getBool("/gear/gear[0]/wow"),
    };
  }

  /** The nose wheel's position: what follows the taxi line. */
  nose(w) {
    const ahead = this.def.noseGearM ?? 0;
    return { x: w.x + Math.sin(w.heading * D2R) * ahead, y: w.y + Math.cos(w.heading * D2R) * ahead, heading: w.heading };
  }

  wind() {
    const p = this.props;
    const mag = wrap360(p.get("/environment/wind-from-heading-deg") - p.get("/environment/magnetic-variation-deg"));
    const kt = Math.round(p.get("/environment/wind-speed-kt"));
    if (kt < 3) return { text: "wind calm", say: "wind calm" };
    const dir = String(Math.round(mag / 10) * 10 || 360).padStart(3, "0");
    return { text: `wind ${dir} at ${kt}`, say: `wind ${sayDigits(dir)} at ${kt}` };
  }

  /** The runway end ATC names for a runway pair: the one into the wind. */
  activeEnd(pair) {
    const ids = pair.split("/");
    const ends = this.airport.runways.filter((r) => ids.includes(r.id));
    if (ends.length < 2) return ids[0];
    const p = this.props;
    const wd = p.get("/environment/wind-from-heading-deg"), wk = p.get("/environment/wind-speed-kt");
    return activeRunway({ runways: ends }, wd, wk).id;
  }

  /** Radio transmissions. */
  say(kind, text, speech, apt) {
    const st = this.station(kind, apt);
    this.app.radio?.transmit({ station: st.name, freq: st.freq, text: `${this.callsign.text}, ${text}`,
      speech: `${this.callsign.spoken}, ${speech ?? text}` });
  }

  pilot(text) {
    this.app.radio?.transmit({ station: "You", text, pilot: true });
  }

  tug(text) {
    this.app.radio?.transmit({ station: "Ground crew", text, speech: text, crew: true });
  }

  freqText(st) {
    return st.freq ? ` ${formatFrequency(st.freq)}` : "";
  }

  freqSay(st) {
    return st.freq ? ` ${sayFrequency(st.freq)}` : "";
  }

  // ---------------------------------------------------------------- menu

  /** What the pilot can say now: [{label, run}]. */
  options() {
    const out = [];
    const w = this.where();
    const rw = this.runwayId;
    switch (this.phase) {
      case "parked":
        if (this.parking && !this.pushed) out.push({ label: "Request pushback", run: () => this.requestPushback() });
        out.push({ label: `Request taxi to runway ${rw}`, run: () => this.requestTaxi() });
        break;
      case "pushback":
        out.push({ label: "Stop the pushback", run: () => this.pushback.cancel() });
        break;
      case "ready":
        out.push({ label: `Request taxi to runway ${rw}`, run: () => this.requestTaxi() });
        break;
      case "taxi-out":
        out.push({ label: `Ready for departure, runway ${rw}`, run: () => this.readyForDeparture() });
        if (this.route) out.push({ label: "Say again (repeat the taxi clearance)", run: () => this.repeat() });
        if (this.net?.hasTaxiways) out.push({ label: "Request a new route from here", run: () => this.requestTaxi(true) });
        break;
      case "holding":
      case "lined-up":
        out.push({ label: `Ready for departure, runway ${rw}`, run: () => this.readyForDeparture() });
        break;
      case "airborne":
      case "final": {
        const apt = this.nearestAirport(w);
        if (apt) out.push({ label: `Request landing at ${apt.icao} (${this.city(apt)})`, run: () => this.requestLanding(apt) });
        break;
      }
      case "landed":
        out.push({ label: "Request taxi to the gate", run: () => this.requestTaxiIn() });
        break;
      case "taxi-in":
        if (this.route) out.push({ label: "Say again (repeat the taxi clearance)", run: () => this.repeat() });
        if (this.net?.hasTaxiways) out.push({ label: "Request a new route from here", run: () => this.requestTaxiIn(true) });
        break;
      default:
        break;
    }
    return out;
  }

  nearestAirport(w) {
    let best = null, bestD = Infinity;
    for (const a of this.app.airports) {
      const d = Math.hypot(a.runways[0].lat - w.lat, (a.runways[0].lon - w.lon) * Math.cos(w.lat * D2R)) * 60;
      const score = d - (a.tower ? 10 : 0);
      if (d < 40 && score < bestD) { bestD = score; best = a; }
    }
    return best;
  }

  // ------------------------------------------------------------ requests

  requestPushback() {
    const w = this.where();
    if (!w.wow || w.gsKt > 1 || !this.net) return;
    const park = this.parking;
    let path = this.net?.pushbackPath(park)?.slice(1);
    if (!path?.length) {
      // No pushback route at this spot: straight back, clear of it.
      const back = (w.heading + 180) % 360;
      const d = Math.max(25, park.radius * 1.6);
      path = [GroundNet.ahead(w, back, d * 0.5), GroundNet.ahead(w, back, d)];
    }
    const pts = path.map((n) => this.net.latlon(n.x, n.y));
    const last = path.at(-1), prev = path.at(-2) ?? w;
    const face = wrap360(GroundNet.course(prev, last) + 180);
    const faceMag = wrap360(face - this.props.get("/environment/magnetic-variation-deg"));
    const dir = COMPASS[Math.round(faceMag / 45) % 8];
    this.pilot(`${this.station("ground").name}, ${this.callsign.text} at ${park.name}, request pushback.`);
    this.say("ground", `push back approved, face ${dir}.`);
    this.pushback.connect(pts);
    this.pushEnd = last;
    this.pushed = true;
    this.phase = "pushback";
    this.app.routeView?.showPath(path, this.net, { kind: "pushback" });
    if (this.def.id === "747" || this.def.id === "f16") this.app.message?.("Release the parking brake (B) when the tug is connected");
  }

  /** Ground's taxi clearance to the departure runway. */
  requestTaxi(reroute = false) {
    const w = this.where();
    if (!w.wow) return;
    const rw = this.runwayId;
    const ground = this.station("ground");
    if (!reroute) this.pilot(`${ground.name}, ${this.callsign.text}${this.parking && this.phase === "parked" ? ` at ${this.parking.name}` : ""}, ready to taxi.`);
    // Nose in at a gate, or a spot with a pushback route: push first.
    if (this.phase === "parked" && this.parking && !this.pushed && (this.parking.pushback >= 0 || this.parking.type === "gate")) {
      this.say("ground", "push back first, then call me for taxi.");
      return;
    }
    const route = this.net?.hasTaxiways ? this.net.routeToRunway(this.nose(w), rw) : null;
    if (!route) {
      this.route = null;
      this.say("ground", `runway ${rw}, taxi at your discretion, hold short of runway ${rw}.`,
        `runway ${sayRunway(rw)}, taxi at your discretion, hold short of runway ${sayRunway(rw)}.`);
      this.phase = "taxi-out";
      return;
    }
    this.useRoute(route);
    this.phase = "taxi-out";
    this.clearance(reroute ? "New route: " : "");
    if (!this.enginesRunning()) this.app.message?.("Start the engines first: Shift+S");
    if (this.def.id === "747" && this.props.get("/controls/flight/flaps") < 0.3) {
      this.app.message?.("Set takeoff flaps on the way: ] to flaps 10 or 20", 6);
    }
  }

  enginesRunning() {
    const n = this.def.engines ?? 1;
    for (let i = 0; i < n; i++) if (this.props.getBool(`/engines/engine[${i}]/running`)) return true;
    return false;
  }

  useRoute(route) {
    this.route = route;
    this.track = { s: 0, index: 1, said: new Set() };
    this.offTimer = 0;
    this.app.routeView?.show(route, this.net, { span: this.def.wingspanM });
  }

  /** The taxi clearance for the current route: "runway 28R, taxi via F, Q, C, hold short of runway 28R". */
  clearance(prefix = "") {
    const r = this.route;
    const rw = this.runwayId;
    const cross = [];
    for (const c of r.crossings) {
      const id = this.activeEnd(c.runway.pair);
      if (!cross.includes(id)) cross.push(id);
    }
    const via = r.via.length ? ` via ${r.via.join(", ")}` : "";
    const viaSay = r.via.length ? ` via ${r.via.map(sayTaxiway).join(", ")}` : "";
    const crossText = cross.length ? `, cross runway${cross.length > 1 ? "s" : ""} ${sayList(cross)}` : "";
    const crossSay = cross.length ? `, cross runway${cross.length > 1 ? "s" : ""} ${sayList(cross.map(sayRunway))}` : "";
    if (r.parking) {
      const where = r.parking.type === "gate" ? `gate ${r.parking.name}` : r.parking.name;
      this.say("ground", `${prefix}taxi to ${where}${via}${crossText}.`, `${prefix}taxi to ${where}${viaSay}${crossSay}.`);
      this.pilot(`Taxi to ${where}${via}${crossText}, ${this.callsign.text}.`);
    } else {
      this.say("ground", `${prefix}runway ${rw}, taxi${via}${crossText}, hold short of runway ${rw}.`,
        `${prefix}runway ${sayRunway(rw)}, taxi${viaSay}${crossSay}, hold short of runway ${sayRunway(rw)}.`);
      this.pilot(`Runway ${rw}, taxi${via}${crossText}, hold short ${rw}, ${this.callsign.text}.`);
    }
  }

  repeat() {
    if (this.route) this.clearance();
  }

  readyForDeparture() {
    const w = this.where();
    const rw = this.runwayId;
    const tower = this.station("tower");
    this.pilot(`${tower.name}, ${this.callsign.text}, holding short runway ${rw}, ready for departure.`);
    const wind = this.wind();
    if (!this.towered) {
      this.say("tower", `no traffic reported, ${wind.text}, runway ${rw} in use, depart at your discretion.`,
        `no traffic reported, ${wind.say}, runway ${sayRunway(rw)} in use, depart at your discretion.`);
    } else {
      this.say("tower", `${wind.text}, runway ${rw}, cleared for takeoff.`, `${wind.say}, runway ${sayRunway(rw)}, cleared for takeoff.`);
      this.pilot(`Cleared for takeoff runway ${rw}, ${this.callsign.text}.`);
    }
    this.phase = "cleared";
    this.route = null;
    this.app.radio?.clearGuidance();
    this.app.radio?.setStation(tower);
    // The route stays drawn up to the runway; it goes once airborne.
    if (this.def.id === "747" && this.props.get("/controls/flight/flaps") < 0.3 && w.wow) {
      this.app.message?.("Takeoff flaps! ] sets flaps 10 or 20", 6);
    }
  }

  requestLanding(apt) {
    const p = this.props;
    const rwy = activeRunway(apt, p.get("/environment/wind-from-heading-deg"), p.get("/environment/wind-speed-kt"));
    const tower = this.station("tower", apt, null);
    this.landingAirport = apt;
    this.landingRunway = rwy.id;
    this.pilot(`${tower.name}, ${this.callsign.text}, inbound for landing.`);
    const wind = this.wind();
    if (apt.tower) {
      this.say("tower", `${wind.text}, runway ${rwy.id}, cleared to land.`, `${wind.say}, runway ${sayRunway(rwy.id)}, cleared to land.`, apt);
      this.pilot(`Cleared to land runway ${rwy.id}, ${this.callsign.text}.`);
    } else {
      this.say("tower", `${wind.text}, runway ${rwy.id} in use, no reported traffic.`, `${wind.say}, runway ${sayRunway(rwy.id)} in use, no reported traffic.`, apt);
    }
    this.app.radio?.setStation(tower);
    this.phase = "landing";
  }

  async requestTaxiIn(reroute = false) {
    const w = this.where();
    if (!w.wow) return;
    if (!reroute) this.pilot(`${this.station("ground").name}, ${this.callsign.text}, clear of the runway, request taxi to the gate.`);
    const net = this.net;
    if (!net?.hasTaxiways) {
      this.say("ground", "taxi to parking at your discretion.");
      this.phase = "taxi-in";
      return;
    }
    const prefer = this.def.id === "747" ? ["gate", "cargo"] : this.def.id === "f16" ? ["mil-fighter", "ga", "cargo"] : ["ga", "tie-down", "tie_down"];
    const park = reroute && this.route?.parking ? this.route.parking : net.arrivalParking(this.nose(w), this.def.wingspanM, prefer);
    const route = park && net.routeToParking(this.nose(w), park);
    if (!route) {
      this.say("ground", "unable to find you a parking spot, taxi to parking at your discretion.");
      this.phase = "taxi-in";
      return;
    }
    this.useRoute(route);
    this.parking = park;
    this.pushed = false;
    this.phase = "taxi-in";
    this.clearance(reroute ? "New route: " : "");
  }

  // -------------------------------------------------------------- update

  /** dt in simulation seconds (0 while paused). */
  update(dt) {
    if (this.phase === "idle" || !dt) return;
    this.clock += dt;
    this.pushback?.update(dt);
    this.timer -= dt;
    if (this.timer > 0) return;
    const step = 0.2 - this.timer;
    this.timer = 0.2;
    const w = this.where();
    switch (this.phase) {
      case "pushback":
        if (!this.pushback.active) {
          this.phase = "ready";
          this.app.routeView?.clear();
          this.app.message?.("Press ' and request taxi", 5);
        }
        break;
      case "taxi-out":
      case "taxi-in":
        this.follow(w, step);
        break;
      case "cleared":
        if (!w.wow && w.agl > 50) this.app.routeView?.clear();
        if (!w.wow && w.agl > 1000 && this.towered) {
          const dep = this.station("departure");
          this.say("tower", `contact ${dep.name}${this.freqText(dep)}, good day.`, `contact ${dep.name}${this.freqSay(dep)}, good day.`);
          this.pilot(`Over to Departure, ${this.callsign.text}, good day.`);
          this.app.radio?.setStation(dep);
          this.phase = "airborne";
        } else if (!w.wow && w.agl > 1000) {
          this.phase = "airborne";
        }
        break;
      case "landing":
        if (w.wow && w.gsKt < 40) {
          const apt = this.landingAirport;
          this.phase = "landed";
          this.switchAirport(apt);
          const ground = this.station("ground", apt);
          if (apt.tower) {
            this.say("tower", `exit the runway when able, contact ground${this.freqText(ground)}.`,
              `exit the runway when able, contact ground${this.freqSay(ground)}.`, apt);
          }
          this.app.radio?.setStation(ground);
          this.app.message?.("Clear the runway, then press ' to request taxi to the gate", 6);
        }
        break;
      case "airborne":
      case "final":
        // Landed without asking: still offer a taxi to the gate.
        if (w.wow && w.gsKt < 40 && this.clock > 20) {
          const apt = this.nearestAirport(w);
          if (apt) {
            this.landingAirport = apt;
            this.switchAirport(apt);
            this.phase = "landed";
          }
        }
        break;
      default:
        break;
    }
  }

  /** After landing somewhere else: that airport's ground network. */
  switchAirport(apt) {
    if (this.airport.icao === apt.icao && this.net) return;
    this.airport = apt;
    this.net = null;
    this.app.groundnet?.(apt.icao).then((net) => {
      if (this.airport.icao === apt.icao) this.net = net;
    });
  }

  /** Progressive taxi along the route, the hold line, and missed turns. */
  follow(w, dt) {
    const r = this.route;
    const rw = this.runwayId;
    if (!r) {
      // No ground network: hold short by distance from the runway.
      if (this.phase === "taxi-out" && this.net) {
        const end = this.net.runway(rw);
        if (end && GroundNet.runwayDistance(end, w) < GroundNet.holdMargin(end) + 30 && w.gsKt < 2) this.atHold();
      }
      return;
    }
    const n = this.nose(w);
    const t = GroundNet.track(r, n, this.track.index);
    if (t.off < 60) {
      this.track.index = t.index;
      this.track.s = Math.max(this.track.s, t.s);
    }
    const s = this.track.s;
    this.app.routeView?.progress(s);

    // Next thing to do along the route.
    const events = [];
    for (const turn of r.turns) {
      events.push({ at: turn.at, key: `turn${turn.at}`, text: turn.dir === "straight" ? `Continue onto ${turn.name}` : `Turn ${turn.dir} onto ${turn.name}`,
        radio: turn.dir === "straight" ? `continue on ${turn.name}.` : `turn ${turn.dir} on ${turn.name}.`,
        say: turn.dir === "straight" ? `continue on ${sayTaxiway(turn.name)}.` : `turn ${turn.dir} on ${sayTaxiway(turn.name)}.` });
    }
    for (const c of r.crossings) {
      const id = this.activeEnd(c.runway.pair);
      events.push({ at: c.at, key: `cross${c.at}`, text: `Cross runway ${id}`, radio: `cross runway ${id}.`, say: `cross runway ${sayRunway(id)}.` });
    }
    if (r.hold) events.push({ at: r.hold.at, key: "hold", text: `Hold short of runway ${rw}`, hold: true });
    if (r.parking) events.push({ at: r.length, key: "park", text: `Park at ${r.parking.name}`, park: true });
    events.sort((a, b) => a.at - b.at);
    const next = events.find((e) => e.at > s - 5);
    const speed = w.gsKt * KT;
    if (next) {
      const dist = Math.max(0, next.at - s);
      this.app.radio?.setGuidance({ next: next.text, distance: dist, summary: this.summary(), hold: !!next.hold });
      const lead = Math.max(70, speed * 9);
      if (next.radio && dist < lead && !this.track.said.has(next.key)) {
        this.track.said.add(next.key);
        this.say("ground", next.radio, next.say);
      }
    } else {
      this.app.radio?.setGuidance({ next: "Follow the line", distance: Math.max(0, r.length - s), summary: this.summary() });
    }

    // Holding short of the departure runway.
    if (r.hold && this.phase === "taxi-out") {
      const toHold = r.hold.at - s;
      if (toHold < 25 && w.gsKt < 2) {
        this.holdTimer += dt;
        if (this.holdTimer > 1.5) this.atHold();
      } else {
        this.holdTimer = 0;
      }
      // Past the hold line onto the runway without a clearance (crossing it
      // earlier on the way, as cleared, is fine).
      const end = this.net.runway(rw);
      if (end && s > r.hold.at && GroundNet.runwayDistance(end, n) < 2 && !this.warned.incursion) {
        this.warned.incursion = true;
        this.say("tower", `stop! Hold position. You are not cleared onto runway ${rw}.`,
          `stop! Hold position. You are not cleared onto runway ${sayRunway(rw)}.`);
      }
    }
    // Arriving at the gate.
    if (r.parking && this.phase === "taxi-in") {
      const end = r.points.at(-1);
      const d = Math.hypot(n.x - end.x, n.y - end.y);
      const dRef = Math.hypot(w.x - end.x, w.y - end.y);
      if ((r.length - s < 8 || Math.min(d, dRef) < 6) && w.gsKt < 1.5) this.arrived(Math.min(d, dRef));
    }

    // Too fast for a taxiway.
    if (w.gsKt > 30 && !this.warned.speed) {
      this.warned.speed = true;
      this.say("ground", "reduce taxi speed.");
    }
    // Missed a turn: a new route from where you are.
    const tolerance = Math.max(30, (this.def.wingspanM ?? 20) * 0.5);
    if (t.off > tolerance && w.gsKt > 2) this.offTimer += dt;
    else this.offTimer = Math.max(0, this.offTimer - dt);
    if (this.offTimer > 3 && this.clock - this.lastReroute > 15) {
      this.lastReroute = this.clock;
      this.offTimer = 0;
      const route = r.parking ? this.net.routeToParking(this.nose(w), r.parking) : this.net.routeToRunway(this.nose(w), rw);
      if (route) {
        this.say("ground", "looks like you missed the turn. Stand by for a new route.");
        this.useRoute(route);
        this.clearance("new route, ");
      }
    }
  }

  summary() {
    const r = this.route;
    if (!r) return "";
    const via = r.via.length ? ` via ${r.via.join(" › ")}` : "";
    return r.parking ? `To ${r.parking.name}${via}` : `To runway ${this.runwayId}${via} · hold short ${this.runwayId}`;
  }

  atHold() {
    if (this.phase !== "taxi-out") return;
    this.phase = "holding";
    this.app.radio?.setGuidance({ next: `Holding short of runway ${this.runwayId}`, distance: 0, summary: "Press ' when ready for departure", hold: true });
    const tower = this.station("tower");
    if (this.towered) {
      this.say("ground", `contact tower${this.freqText(tower)}.`, `contact tower${this.freqSay(tower)}.`);
      this.pilot(`Over to Tower, ${this.callsign.text}.`);
      this.app.radio?.setStation(tower);
    }
    this.app.message?.("Holding short. Press ' and tell the Tower you're ready", 6);
  }

  arrived(error) {
    this.phase = "parked";
    const park = this.route.parking;
    this.route = null;
    this.app.routeView?.clear();
    this.app.radio?.clearGuidance();
    const city = this.city();
    // Stopping right on the mark earns a word from the ground crew, who
    // have opinions about a certain tight end's footwork.
    const nice = error < 1.5 ? " Right on the stop mark: nicer footwork than a certain 49ers tight end." : "";
    this.say("ground", `welcome to ${city}. Set parking brake at ${park.name}.${nice}`);
    this.pushed = false;
  }
}
