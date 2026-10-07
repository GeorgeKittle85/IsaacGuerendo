// An airport's ground network: FlightGear's groundnet (TerraSync's
// Airports/I/C/A/ICAO.groundnet.xml, packaged with taxiway names by
// tools/build_groundnets.py) with its parking positions, pushback routes and
// taxiway graph, and the taxi routing FlightGear's ground controller does on
// it (FGGroundNetwork::findShortestRoute), extended with what an ATC taxi
// clearance needs: the taxiways in order, runway crossings, the hold short
// point and the turns for progressive taxi.
//
// Positions are kept in flat metres east (x) and north (y) of the airport's
// first runway threshold, plenty at airport scale.  No DOM or three.js here:
// the browser and the Node tests (tools/atc_test.mjs) share it.

export const PUSHBACK = 1; // only for pushing back from a parking position
export const ONE_WAY = 2; // only from the first node to the second
export const RUNWAY = 4; // runs along a runway

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const EARTH_R = 6371008.8;

const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const wrap360 = (a) => ((a % 360) + 360) % 360;

/** Binary min-heap of [cost, value]. */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(cost, value) {
    const a = this.a;
    a.push([cost, value]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Turn cost in metres for a change of direction (big jets do not U-turn on a taxiway). */
function turnCost(deg) {
  const a = Math.abs(deg);
  if (a < 30) return 0;
  if (a < 100) return a * 0.6;
  if (a < 135) return 300;
  return 5000;
}

export class GroundNet {
  /** data: tools/build_groundnets.py output; airport: its airports.json entry. */
  constructor(data, airport) {
    this.icao = data.icao;
    this.airport = airport;
    this.frequencies = data.frequencies ?? {};
    const r0 = airport.runways[0];
    this.lat0 = r0.lat;
    this.lon0 = r0.lon;
    this.kx = EARTH_R * Math.cos(this.lat0 * D2R) * D2R;
    this.ky = EARTH_R * D2R;
    this.nodes = data.nodes.map(([lat, lon]) => ({ lat, lon, ...this.xy(lat, lon) }));
    this.edges = data.edges.map(([a, b, n, flags]) => {
      const A = this.nodes[a], B = this.nodes[b];
      return { a, b, name: n >= 0 ? data.names[n] : null, flags, len: Math.hypot(B.x - A.x, B.y - A.y) };
    });
    this.adj = this.nodes.map(() => []);
    this.edges.forEach((e, i) => {
      this.adj[e.a].push({ edge: i, to: e.b });
      if (!(e.flags & ONE_WAY)) this.adj[e.b].push({ edge: i, to: e.a });
    });
    this.parking = data.parking.map(([node, name, type, heading, radius, pushback]) => ({
      node, name, type, heading, radius, pushback, lat: this.nodes[node].lat, lon: this.nodes[node].lon,
    }));
    this.parkingNodes = new Set(this.parking.map((p) => p.node));
    this.hasTaxiways = this.edges.some((e) => !(e.flags & PUSHBACK) && !this.parkingNodes.has(e.a) && !this.parkingNodes.has(e.b));
    // Runway ends, with their pair, in local metres.
    this.runways = airport.runways.filter((r) => r.id.toLowerCase() !== "xxx").map((r) => {
      const p = this.xy(r.lat, r.lon);
      const h = r.heading * D2R;
      return { id: r.id, heading: r.heading, x: p.x, y: p.y, ux: Math.sin(h), uy: Math.cos(h),
        length: r.lengthM, half: r.widthM / 2, displacedM: r.displacedM ?? 0 };
    });
    for (const r of this.runways) {
      r.other = this.runways.find((o) => o !== r && Math.abs(wrap180(o.heading - r.heading - 180)) < 10
        && Math.hypot(o.x - (r.x + r.ux * r.length), o.y - (r.y + r.uy * r.length)) < 30) ?? null;
      r.pair = r.other ? [r.id, r.other.id].sort().join("/") : r.id;
    }
  }

  // ---------------------------------------------------------------- geometry

  xy(lat, lon) {
    return { x: (lon - this.lon0) * this.kx, y: (lat - this.lat0) * this.ky };
  }

  latlon(x, y) {
    return { lat: this.lat0 + y / this.ky, lon: this.lon0 + x / this.kx };
  }

  /** Point `dist` metres from p along true course `deg`. */
  static ahead(p, deg, dist) {
    return { x: p.x + Math.sin(deg * D2R) * dist, y: p.y + Math.cos(deg * D2R) * dist };
  }

  static course(a, b) {
    return wrap360(Math.atan2(b.x - a.x, b.y - a.y) * R2D);
  }

  /** Runway end by designator ("28R"). */
  runway(id) {
    return this.runways.find((r) => r.id === id) ?? null;
  }

  /** Along/across a runway end's centerline (along from its threshold). */
  static runwayCoords(r, p) {
    const dx = p.x - r.x, dy = p.y - r.y;
    return { along: dx * r.ux + dy * r.uy, across: -dx * r.uy + dy * r.ux };
  }

  /** Distance from p to a runway's rectangle (0 inside it). */
  static runwayDistance(r, p) {
    const c = GroundNet.runwayCoords(r, p);
    const da = Math.max(0, -c.along, c.along - r.length);
    const dc = Math.max(0, Math.abs(c.across) - r.half);
    return Math.hypot(da, dc);
  }

  /**
   * How far from a runway's edge aircraft hold short: about 250 ft from the
   * centerline of a wide runway, less on narrow ones.
   */
  static holdMargin(r) {
    return Math.max(25, Math.min(50, r.half * 1.5));
  }

  // ----------------------------------------------------------------- parking

  /** Parking positions big enough for a wingspan, the most fitting first. */
  parkingFor(spanM, { types } = {}) {
    const need = spanM / 2;
    return this.parking.filter((p) => p.radius >= need * 0.92 && (!types || types.includes(p.type)));
  }

  parkingByName(name) {
    return this.parking.find((p) => p.name === name) ?? null;
  }

  /** A parking position's pushback route as points (FlightGear's pushBackRoute), or null. */
  pushbackPath(park) {
    if (park.pushback < 0) return null;
    const prev = new Map([[park.node, -1]]);
    const queue = [park.node];
    while (queue.length) {
      const n = queue.shift();
      if (n === park.pushback) break;
      for (const { edge, to } of this.adj[n]) {
        if (!(this.edges[edge].flags & PUSHBACK) || prev.has(to)) continue;
        prev.set(to, n);
        queue.push(to);
      }
    }
    if (!prev.has(park.pushback)) return null;
    const path = [];
    for (let n = park.pushback; n !== -1; n = prev.get(n)) path.unshift(n);
    return path.length > 1 ? path.map((i) => this.nodes[i]) : null;
  }

  // ----------------------------------------------------------------- routing

  /**
   * Shortest taxi route (Dijkstra over directed edges, with turn costs) from
   * a position and heading to the cheapest of `goals` ([{node, cost}]).
   * Pushback-only edges cost extra and other parking positions are never
   * driven through.  Returns {nodes: [index], edges: [index]} or null.
   */
  findRoute(from, goals, { avoidRunways = true, reach = 150 } = {}) {
    const goalCost = new Map(goals.map((g) => [g.node, g.cost ?? 0]));
    const allowParking = new Set(goals.map((g) => g.node));
    // Start: nodes near the aircraft that it can reach going forward.
    const starts = [];
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const d = Math.hypot(n.x - from.x, n.y - from.y);
      if (d > reach || !this.adj[i].length) continue;
      if (this.parkingNodes.has(i) && d > 12 && !allowParking.has(i)) continue;
      const brg = d < 8 ? from.heading : GroundNet.course(from, n);
      const off = Math.abs(wrap180(brg - from.heading));
      if (off > 100 && d > 8) continue;
      starts.push({ node: i, cost: d + turnCost(off) * 0.5 + (off > 60 ? d : 0), dir: brg });
      if (this.parkingNodes.has(i)) allowParking.add(i);
    }
    // Far from the network (on a runway, on the grass): look further out.
    if (!starts.length) return reach < 600 ? this.findRoute(from, goals, { avoidRunways, reach: reach * 2 }) : null;
    // State: arrived at node `to` over edge `edge` (or -1 at the start).
    const best = new Map();
    const prev = new Map();
    const heap = new Heap();
    for (const s of starts) {
      const key = `${s.node}|-1|${s.node}`;
      best.set(key, s.cost);
      heap.push(s.cost, { node: s.node, edge: -1, dir: s.dir, key });
    }
    let found = null;
    let foundCost = Infinity;
    while (heap.size) {
      const [cost, st] = heap.pop();
      if (cost > (best.get(st.key) ?? Infinity) || cost >= foundCost) continue;
      if (goalCost.has(st.node)) {
        const total = cost + goalCost.get(st.node);
        if (total < foundCost) { foundCost = total; found = st; }
      }
      for (const { edge, to } of this.adj[st.node]) {
        if (edge === st.edge) continue;
        const e = this.edges[edge];
        if (this.parkingNodes.has(to) && !allowParking.has(to)) continue;
        const a = this.nodes[st.node], b = this.nodes[to];
        const dir = GroundNet.course(a, b);
        let c = e.len * (e.flags & PUSHBACK ? 3 : 1) * (avoidRunways && e.flags & RUNWAY ? 2.5 : 1);
        c += turnCost(wrap180(dir - st.dir));
        // A little for each change of taxiway: clearances stay short.
        const was = st.edge >= 0 ? this.edges[st.edge].name : null;
        if (was && e.name && was !== e.name) c += 40;
        const nc = cost + c;
        const key = `${to}|${edge}`;
        if (nc < (best.get(key) ?? Infinity)) {
          best.set(key, nc);
          prev.set(key, st);
          heap.push(nc, { node: to, edge, dir, key });
        }
      }
    }
    if (!found) return null;
    const nodes = [], edges = [];
    for (let st = found; st; st = prev.get(st.key)) {
      nodes.unshift(st.node);
      if (st.edge >= 0) edges.unshift(st.edge);
    }
    return { nodes, edges, cost: foundCost };
  }

  /**
   * Taxi route to a runway for departure: to the network node closest to its
   * threshold (FlightGear taxis to the runway's nearest node), preferring a
   * full-length departure, then onto the centerline.
   */
  routeToRunway(from, rwyId) {
    const r = this.runway(rwyId);
    if (!r) return null;
    // Near the threshold; where the taxiways do not reach it, an
    // intersection departure from the first half of the runway.
    const goals = [];
    for (const [maxAlong, side] of [[600, 160], [r.length / 2, 250]]) {
      for (let i = 0; i < this.nodes.length; i++) {
        if (this.parkingNodes.has(i) || !this.adj[i].length) continue;
        const c = GroundNet.runwayCoords(r, this.nodes[i]);
        if (c.along < -250 || c.along > maxAlong || Math.abs(c.across) > r.half + side) continue;
        goals.push({ node: i, cost: 3 * Math.abs(c.along) + Math.abs(c.across) * 0.5 });
      }
      if (goals.length) break;
    }
    if (!goals.length) return null;
    const route = this.findRoute(from, goals);
    if (!route) return null;
    const last = this.nodes[route.nodes.at(-1)];
    const along = Math.max(15, GroundNet.runwayCoords(r, last).along);
    const lineup = { x: r.x + r.ux * along, y: r.y + r.uy * along };
    const roll = { x: lineup.x + r.ux * 150, y: lineup.y + r.uy * 150 };
    return this.describe(from, route, { runway: r, extra: [lineup, roll] });
  }

  /** Taxi route to a parking position (its last leg may be its pushback route, driven forwards). */
  routeToParking(from, park) {
    const route = this.findRoute(from, [{ node: park.node, cost: 0 }], { avoidRunways: true });
    return route ? this.describe(from, route, { parking: park }) : null;
  }

  /**
   * The parking position for an arriving aircraft: one that fits, of the
   * first kind in `preferTypes` the airport has, nearest by taxi distance.
   */
  arrivalParking(from, spanM, preferTypes) {
    const fits = this.parkingFor(spanM);
    const kind = preferTypes.find((t) => fits.some((p) => p.type === t));
    const pool = (kind ? fits.filter((p) => p.type === kind) : fits)
      .map((p) => ({ p, d: Math.hypot(this.nodes[p.node].x - from.x, this.nodes[p.node].y - from.y) }))
      .sort((a, b) => a.d - b.d).slice(0, 25).map((c) => c.p);
    let best = null;
    for (const p of pool) {
      const r = this.findRoute(from, [{ node: p.node, cost: 0 }]);
      if (r && (!best || r.cost < best.cost)) best = { park: p, cost: r.cost };
    }
    return best?.park ?? null;
  }

  // ---------------------------------------------------------- instructions

  /**
   * Turns a route into what a ground controller says and shows: the
   * polyline, the taxiways in order, runway crossings, the hold short point
   * and the turns ("legs").
   */
  describe(from, route, { runway = null, parking = null, extra = [] } = {}) {
    const pts = [{ x: from.x, y: from.y }];
    for (const i of route.nodes) {
      const n = this.nodes[i];
      if (Math.hypot(n.x - pts.at(-1).x, n.y - pts.at(-1).y) > 0.5) pts.push({ x: n.x, y: n.y });
    }
    for (const p of extra) pts.push(p);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));

    // Taxiway legs from the edge names: unnamed apron segments join their
    // neighbours, runway segments are crossings (or the runway itself).
    const raw = [];
    let s = Math.hypot(this.nodes[route.nodes[0]].x - from.x, this.nodes[route.nodes[0]].y - from.y);
    route.edges.forEach((ei, k) => {
      const e = this.edges[ei];
      const isRwy = !!(e.flags & RUNWAY);
      const name = isRwy ? null : e.name;
      raw.push({ name, start: s, len: e.len, node: route.nodes[k] });
      s += e.len;
    });
    const legs = [];
    for (const r of raw) {
      const last = legs.at(-1);
      if (last && (r.name === null || r.name === last.name)) last.len += r.len;
      else legs.push({ ...r });
    }
    // Junction stubs: a few metres of another taxiway between two legs.
    for (let i = legs.length - 2; i > 0; i--) {
      if (legs[i].len < 25 && legs[i].name) {
        legs[i - 1].len += legs[i].len;
        legs.splice(i, 1);
        if (legs[i] && legs[i].name === legs[i - 1].name) {
          legs[i - 1].len += legs[i].len;
          legs.splice(i, 1);
        }
      }
    }
    const via = legs.map((l) => l.name).filter(Boolean);

    // Turns at the start of each named leg after the first.
    const turns = [];
    for (let i = 1; i < legs.length; i++) {
      if (!legs[i].name) continue;
      const at = legs[i].start;
      const before = this.pointAt(pts, cum, Math.max(0, at - 25));
      const here = this.pointAt(pts, cum, at);
      const after = this.pointAt(pts, cum, Math.min(cum.at(-1), at + 30));
      const d = wrap180(GroundNet.course(here, after) - GroundNet.course(before, here));
      const dir = Math.abs(d) < 25 ? "straight" : d < 0 ? "left" : "right";
      turns.push({ at, name: legs[i].name, dir });
    }

    // Runways the route enters: crossings, and the departure runway itself.
    const crossings = [];
    let hold = null;
    const step = 2;
    for (const r of this.runways) {
      if (r.other && r.id > r.other.id) continue; // one end per runway
      const margin = GroundNet.holdMargin(r);
      const dep = runway && (r === runway || r === runway.other);
      let was = GroundNet.runwayDistance(r, pts[0]) < margin;
      let entered = null;
      for (let d = step; d <= cum.at(-1); d += step) {
        const now = GroundNet.runwayDistance(r, this.pointAt(pts, cum, d)) < margin;
        if (now && !was) entered = d;
        if (!now && was && entered !== null) {
          // Vacated again: a crossing (only if it really reached the runway).
          let touched = false;
          for (let t = entered; t <= d; t += step) if (GroundNet.runwayDistance(r, this.pointAt(pts, cum, t)) === 0) touched = true;
          if (touched) crossings.push({ at: entered, runway: r });
          entered = null;
        }
        // The departure runway: hold where the route last enters its area.
        if (now && !was && dep) hold = { at: d, runway };
        was = now;
      }
    }
    crossings.sort((a, b) => a.at - b.at);
    if (hold) {
      // Lines the hold up with the first taxi point inside the hold area.
      const p = this.pointAt(pts, cum, hold.at);
      hold.x = p.x;
      hold.y = p.y;
      hold.dir = GroundNet.course(this.pointAt(pts, cum, Math.max(0, hold.at - 5)), p);
    }
    for (const c of crossings) {
      const p = this.pointAt(pts, cum, c.at);
      c.x = p.x;
      c.y = p.y;
      c.dir = GroundNet.course(this.pointAt(pts, cum, Math.max(0, c.at - 5)), p);
    }
    return { points: pts, cum, length: cum.at(-1), legs, via, turns, crossings, hold, runway, parking };
  }

  /** The point `d` metres along a polyline. */
  pointAt(pts, cum, d) {
    let i = 1;
    while (i < pts.length - 1 && cum[i] < d) i++;
    const seg = cum[i] - cum[i - 1];
    const t = seg > 0 ? Math.max(0, Math.min(1, (d - cum[i - 1]) / seg)) : 0;
    return { x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x), y: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y) };
  }

  /**
   * Progress along a route: {s (metres along), off (metres off the line),
   * index}, searching forward from the last index.
   */
  static track(route, p, hint = 0) {
    const pts = route.points;
    let best = { s: 0, off: Infinity, index: hint };
    for (let i = Math.max(1, hint - 2); i < Math.min(pts.length, hint + 12); i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
      const off = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
      if (off < best.off - 0.01) best = { s: route.cum[i - 1] + t * Math.sqrt(L2), off, index: i };
    }
    return best;
  }
}

/** The runway with the most headwind (FlightGear picks the active runway the same way). */
export function activeRunway(airport, windFromDeg, windKt) {
  let best = airport.runways[0];
  let bestScore = -Infinity;
  for (const r of airport.runways) {
    if (r.id.toLowerCase() === "xxx") continue;
    const head = windKt * Math.cos(((windFromDeg - r.heading) * Math.PI) / 180);
    const score = head * 1000 + r.lengthM / 10;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

// ------------------------------------------------------------- phraseology

const PHONETIC = {
  A: "Alpha", B: "Bravo", C: "Charlie", D: "Delta", E: "Echo", F: "Foxtrot", G: "Golf", H: "Hotel",
  I: "India", J: "Juliett", K: "Kilo", L: "Lima", M: "Mike", N: "November", O: "Oscar", P: "Papa",
  Q: "Quebec", R: "Romeo", S: "Sierra", T: "Tango", U: "Uniform", V: "Victor", W: "Whiskey", X: "X-ray",
  Y: "Yankee", Z: "Zulu",
};
const DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "niner"];
const NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];

/** "F1" -> "Foxtrot One" (taxiway names as ATC says them). */
export function sayTaxiway(name) {
  const m = /^([A-Z]{1,2})(\d{0,2})$/.exec(name);
  if (!m) return name;
  const letters = [...m[1]].map((c) => PHONETIC[c]).join(" ");
  if (!m[2]) return letters;
  const n = +m[2];
  const num = n < 20 ? NUMBERS[n] : [...m[2]].map((d) => NUMBERS[+d]).join(" ");
  return `${letters} ${num.charAt(0).toUpperCase()}${num.slice(1)}`;
}

/** "28R" -> "two eight right", "01L" -> "one left". */
export function sayRunway(id) {
  const m = /^0?(\d{1,2})([LRC]?)$/.exec(id);
  if (!m) return id;
  const side = { L: " left", R: " right", C: " center", "": "" }[m[2]];
  return [...m[1]].map((d) => DIGITS[+d]).join(" ") + side;
}

/** Digit by digit, ATC style ("280" -> "two eight zero"). */
export function sayDigits(text) {
  return [...String(text)].map((c) => (c === "." ? "point" : DIGITS[+c] ?? c)).join(" ");
}

/** 120.5 -> "one two zero point five". */
export function sayFrequency(mhz) {
  return sayDigits(formatFrequency(mhz));
}

export function formatFrequency(mhz) {
  let t = mhz.toFixed(3);
  while (t.endsWith("0") && !t.endsWith(".0")) t = t.slice(0, -1);
  return t;
}

/** A list read out: "A, B and C". */
export function sayList(items, word = "and") {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${word} ${items.at(-1)}`;
}
