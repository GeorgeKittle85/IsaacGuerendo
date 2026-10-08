#!/usr/bin/env python3
"""Build the airports' ground networks (gates, taxiways, pushback routes) for
gate starts, the pushback tug and the taxi instructions of the web ATC.

The network is FlightGear's own: TerraSync's Airports/I/C/A/ICAO.groundnet.xml,
the file FlightGear's AI traffic and ATC taxi on.  It has the parking
positions (gates, ramps, cargo stands) with their pushback routes and the
taxiway graph, laid out on FlightGear's airport scenery, but its taxiway
segments carry no names.  The names come from the same airport on the X-Plane
Scenery Gateway (GPL, like FlightGear's apt.dat, which comes from there too):
its ATC taxi routes (apt.dat rows 1201/1202) are named, and each FlightGear
segment takes the name of the Gateway route lying along it.

Writes <scenery>/groundnets/ICAO.json for every airport in airports.json that
has a groundnet, and an index.json listing them.  Downloads are cached in
--cache and checked against TerraSync's SHA-1 indexes.

Example:
    python3 tools/build_groundnets.py --scenery site/data/scenery --cache build/groundnets
"""

import argparse
import base64
import io
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

sys.path.insert(0, os.path.dirname(__file__))
from fetch_terrasync import DEFAULT_SERVER, http_get, parse_dirindex, sha1_of  # noqa: E402

GATEWAY = "https://gateway.x-plane.com/apiv1"

# Edge flags in the output.
PUSHBACK = 1  # isPushBackRoute: only for pushing back from a parking position
ONE_WAY = 2   # only from the first node to the second
RUNWAY = 4    # runs along a runway

# FlightGear's groundnet frequencies (kHz / 10) -> names used by the ATC.
FREQUENCIES = {"AWOS": "atis", "CLEARANCE": "clearance", "GROUND": "ground", "TOWER": "tower",
               "APPROACH": "approach", "DEPARTURE": "departure", "UNICOM": "unicom"}


def parse_coord(text):
    """Groundnet coordinates: "N37 37.098" / "W122 22.851" -> degrees."""
    m = re.match(r"\s*([NSEW])\s*(\d+)\s+([\d.]+)", text)
    if not m:
        return float(text)
    v = int(m.group(2)) + float(m.group(3)) / 60
    return -v if m.group(1) in "SW" else v


class Local:
    """Flat metres east/north around an airport (plenty at airport scale)."""

    def __init__(self, lat, lon):
        self.lat0, self.lon0 = lat, lon
        self.kx = 111320.0 * math.cos(math.radians(lat))
        self.ky = 110540.0

    def xy(self, lat, lon):
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky)


def seg_dist(p, a, b):
    """Distance from p to segment ab, and ab's unit direction."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    L2 = dx * dx + dy * dy
    if L2 < 1e-9:
        return math.hypot(p[0] - a[0], p[1] - a[1]), (1.0, 0.0)
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2))
    L = math.sqrt(L2)
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy), (dx / L, dy / L)


# ------------------------------------------------------------------ fetching

def cached(path, fetch):
    if os.path.isfile(path):
        with open(path, "rb") as fh:
            return fh.read()
    data = fetch()
    if data is not None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)
    return data


def dirindex(url):
    """A TerraSync .dirindex, or b"" for a directory that does not exist."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "fgweb-groundnets/1.0"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return b""
        return http_get(url)  # anything else: retry with back-off
    except OSError:  # a dropped connection
        return http_get(url)


def terrasync_groundnet(icao, cache, server):
    """The airport's groundnet.xml from TerraSync, or None."""
    d = "/".join(icao[:3])
    rel = f"Airports/{d}"
    index = cached(os.path.join(cache, "terrasync", rel, ".dirindex"), lambda: dirindex(server + rel + "/.dirindex"))
    entries = {name: sha for kind, name, sha, _ in parse_dirindex(index.decode("utf-8", "replace")) if kind == "f"}
    name = f"{icao}.groundnet.xml"
    if name not in entries:
        return None
    path = os.path.join(cache, "terrasync", rel, name)
    if os.path.isfile(path) and sha1_of(path) != entries[name]:
        os.remove(path)
    data = cached(path, lambda: http_get(f"{server}{rel}/{name}"))
    if sha1_of(path) != entries[name]:
        raise RuntimeError(f"SHA-1 mismatch for {rel}/{name}")
    return data


def gateway_get(url, retries=4):
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "fgweb-groundnets/1.0"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.read()
        except urllib.error.HTTPError:
            raise  # not on the Gateway
        except OSError:  # a dropped connection: try again
            if attempt == retries:
                raise
            time.sleep(2 ** attempt)


def gateway_apt(icao, cache):
    """(scenery id, apt.dat text) of the Gateway's recommended scenery, or (None, None)."""
    try:
        info = json.loads(cached(os.path.join(cache, "gateway", f"{icao}.json"),
                                 lambda: gateway_get(f"{GATEWAY}/airport/{icao}")))
    except Exception as exc:  # not on the Gateway
        print(f"  {icao}: no Gateway data ({exc})", file=sys.stderr)
        return None, None
    sid = info["airport"].get("recommendedSceneryId")
    if not sid:
        return None, None

    def fetch():
        pack = json.loads(gateway_get(f"{GATEWAY}/scenery/{sid}"))["scenery"]
        z = zipfile.ZipFile(io.BytesIO(base64.b64decode(pack["masterZipBlob"])))
        return z.read(f"{icao}.dat")

    text = cached(os.path.join(cache, "gateway", f"{icao}-{sid}.dat"), fetch)
    return sid, text.decode("latin-1")


# ------------------------------------------------------------------- parsing

def parse_groundnet(xml_bytes):
    """FlightGear groundnet.xml: frequencies, nodes, parking positions, arcs.
    Node keys are ("g", index); parking positions are nodes too."""
    root = ET.fromstring(xml_bytes)
    freqs = {}
    fr = root.find("frequencies")
    for child in list(fr) if fr is not None else []:
        key = FREQUENCIES.get(child.tag.upper())
        if key and child.text and child.text.strip().isdigit() and key not in freqs:
            freqs[key] = int(child.text.strip()) / 100
    nodes = {}
    parking = []
    for p in root.iter("Parking"):
        k = ("g", int(p.get("index")))
        nodes[k] = (parse_coord(p.get("lat")), parse_coord(p.get("lon")))
        push = int(p.get("pushBackRoute") or -1)
        parking.append({
            "key": k, "name": (p.get("name") or "").strip(), "number": (p.get("number") or "").strip(),
            "type": (p.get("type") or "").strip(), "heading": float(p.get("heading") or 0),
            "radius": float(p.get("radius") or 10), "pushback": ("g", push) if push >= 0 else None,
        })
    for n in root.iter("node"):
        nodes[("g", int(n.get("index")))] = (parse_coord(n.get("lat")), parse_coord(n.get("lon")))
    arcs = []
    for a in root.iter("arc"):
        b, e = ("g", int(a.get("begin"))), ("g", int(a.get("end")))
        if b in nodes and e in nodes and b != e:
            arcs.append({"a": b, "b": e, "push": a.get("isPushBackRoute") == "1", "name": None, "runway": False})
    return freqs, nodes, parking, arcs


# apt.dat frequency rows: 50-56 in 10 kHz units, 1050-1056 in kHz.
FREQ_ROWS = {"50": "atis", "51": "unicom", "52": "clearance", "53": "ground", "54": "tower",
             "55": "approach", "56": "departure"}
# Gateway ramp starts carry the aircraft classes they take; a spot's radius
# (half the span it fits) from the largest.
START_RADIUS = {"heavy": 36, "jets": 20, "turboprops": 15, "fighters": 9, "props": 8, "helos": 8}


def parse_gateway(text):
    """X-Plane apt.dat (1100+): ATC taxi routes (1201/1202), ramp starts
    (1300), frequencies and runway ends."""
    g = {"nodes": {}, "edges": [], "starts": [], "freqs": {}, "runways": []}
    for line in text.splitlines():
        p = line.split()
        if not p:
            continue
        c = p[0]
        if c == "1201" and len(p) >= 5:
            g["nodes"][p[4]] = (float(p[1]), float(p[2]))
        elif c == "1202" and len(p) >= 5:
            g["edges"].append((p[1], p[2], p[3] == "oneway", p[4] == "runway", p[5] if len(p) > 5 else ""))
        elif c == "1300" and len(p) >= 6:
            classes = p[5].split("|")
            g["starts"].append({"lat": float(p[1]), "lon": float(p[2]), "heading": float(p[3]), "type": p[4],
                                "name": " ".join(p[6:]).strip(),
                                "radius": max((START_RADIUS.get(k, 8) for k in classes), default=8)})
        elif c == "100" and len(p) >= 26:
            g["runways"].append(((float(p[9]), float(p[10])), (float(p[18]), float(p[19]))))
        elif len(p) >= 2 and p[1].isdigit():
            code = c[2:] if len(c) == 4 and c.startswith("10") else c
            key = FREQ_ROWS.get(code)
            if key and key not in g["freqs"]:
                g["freqs"][key] = int(p[1]) / (1000 if len(c) == 4 else 100)
    return g


def named_routes(g):
    """The Gateway's named taxiway edges as ((lat, lon), (lat, lon), name)."""
    n = g["nodes"]
    return [(n[a], n[b], name) for a, b, _one, rwy, name in g["edges"] if a in n and b in n and name and not rwy]


def label_parking(parking):
    """FlightGear names a spot name + number ("D" + "53"); unnamed ramp spots
    are numbered per type instead of all being "Startup Location"."""
    counters = {}
    kinds = {"gate": "Gate", "ga": "GA ramp", "cargo": "Cargo stand", "mil-fighter": "Fighter ramp",
             "mil-cargo": "Military ramp", "tie-down": "Tie-down", "tie_down": "Tie-down", "hangar": "Hangar"}
    seen = set()
    for p in parking:
        name, number = p["name"], p.get("number", "")
        generic = not name or name.lower().startswith("startup location")
        if generic:
            kind = kinds.get(p["type"], "Ramp")
            counters[kind] = counters.get(kind, 0) + 1
            label = f"{kind} {counters[kind]}"
        elif name[-1:].isdigit() or not number:
            label = name  # "D55" already carries its number
        else:
            label = name + number
        base, k = label, 2
        while label in seen:
            label = f"{base} ({k})"
            k += 1
        seen.add(label)
        p["label"] = label


# ------------------------------------------------------------------ building

def runway_rects(airport, local):
    """Runway rectangles in local metres: (id pair, start, unit dir, length, half width)."""
    rects = []
    rw = airport["runways"]
    done = set()
    for r in rw:
        if r["id"] in done:
            continue
        other = next((o for o in rw if o is not r and o["id"] not in done
                      and abs(((o["heading"] - r["heading"] + 540) % 360) - 180) > 170
                      and abs(o["lengthM"] - r["lengthM"]) < 1), None)
        done.add(r["id"])
        if other:
            done.add(other["id"])
        a = local.xy(r["lat"], r["lon"])
        h = math.radians(r["heading"])
        u = (math.sin(h), math.cos(h))
        name = f"{r['id']}/{other['id']}" if other else r["id"]
        rects.append((name, a, u, r["lengthM"], r["widthM"] / 2))
    return rects


def on_runway(p, rects, margin=4.0):
    for name, a, u, length, half in rects:
        dx, dy = p[0] - a[0], p[1] - a[1]
        along = dx * u[0] + dy * u[1]
        across = abs(-dx * u[1] + dy * u[0])
        if -margin <= along <= length + margin and across <= half + margin:
            return name
    return None


def layout_matches(airport, gw_runways, local, offset=15.0, angle=3.0):
    """True if the Gateway's runways lie on FlightGear's and the other way
    round (thresholds may have moved along them): then the Gateway's taxi
    routes fit FlightGear's scenery."""
    rects = [r for r in runway_rects(airport, local) if r[0].lower() != "xxx"]
    if not gw_runways or not rects:
        return False

    def along(rect, a, b):
        _name, o, u, _length, half = rect
        d = (b[0] - a[0], b[1] - a[1])
        L = math.hypot(*d)
        if L < 1 or abs(d[0] * u[0] + d[1] * u[1]) / L < math.cos(math.radians(angle)):
            return False
        return all(abs(-(q[0] - o[0]) * u[1] + (q[1] - o[1]) * u[0]) < half + offset for q in (a, b))

    gw = [(local.xy(*a), local.xy(*b)) for a, b in gw_runways]
    return (all(any(along(r, a, b) for r in rects) for a, b in gw)
            and all(any(along(r, a, b) for a, b in gw) for r in rects))


def build_airport(airport, gn_bytes, apt_text):
    """FlightGear's groundnet where TerraSync has one, the Gateway's taxi
    routes and ramp starts where it has none; returns (json, stats) or None."""
    freqs, nodes, parking, arcs = parse_groundnet(gn_bytes) if gn_bytes else ({}, {}, [], [])
    r0 = airport["runways"][0]
    local = Local(r0["lat"], r0["lon"])
    gw = parse_gateway(apt_text) if apt_text else None
    gw_ok = bool(gw) and layout_matches(airport, gw["runways"], local)
    src = {"graph": "groundnet" if arcs else None, "parking": "groundnet" if parking else None}
    if gw:
        freqs = {**gw["freqs"], **freqs}

    if gw_ok and not any(not a["push"] for a in arcs) and gw["edges"]:
        n = gw["nodes"]
        for k, ll in n.items():
            nodes[("x", k)] = ll
        for a, b, one, rwy, name in gw["edges"]:
            if a in n and b in n and a != b:
                arcs.append({"a": ("x", a), "b": ("x", b), "push": False, "name": name or "", "runway": rwy,
                             "oneway": one})
        src["graph"] = "gateway"
    if gw_ok and not parking and gw["starts"]:
        for k, st in enumerate(gw["starts"]):
            key = ("s", k)
            nodes[key] = (st["lat"], st["lon"])
            parking.append({"key": key, "name": st["name"], "type": st["type"], "heading": st["heading"],
                            "radius": st["radius"], "pushback": None})
        src["parking"] = "gateway"
    if not parking:
        return None
    label_parking(parking)

    xy = {k: local.xy(*ll) for k, ll in nodes.items()}
    rects = runway_rects(airport, local)
    rwy_of = {k: on_runway(p, rects) for k, p in xy.items()}

    # Parking positions the graph does not reach (ramp starts, parking-only
    # groundnets) join it at the nearest taxi node.
    linked = {a["a"] for a in arcs} | {a["b"] for a in arcs}
    park_keys = {p["key"] for p in parking}
    taxi_nodes = [k for k in linked if k not in park_keys and not rwy_of[k]]
    for p in parking:
        if p["key"] in linked or not taxi_nodes:
            continue
        q = xy[p["key"]]
        best = min(taxi_nodes, key=lambda k: math.hypot(xy[k][0] - q[0], xy[k][1] - q[1]))
        if math.hypot(xy[best][0] - q[0], xy[best][1] - q[1]) < 250:
            arcs.append({"a": p["key"], "b": best, "push": False, "name": "", "runway": False})

    # Names only travel a few metres between parallel segments, so they are
    # safe to take even where the layouts differ elsewhere.
    routes = [(local.xy(*a), local.xy(*b), name) for a, b, name in named_routes(gw)] if gw else []

    def name_for(i, j):
        """The Gateway taxiway along segment i-j, by votes of points on it."""
        a, b = xy[i], xy[j]
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        if L < 1e-3 or not routes:
            return None
        d = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
        votes = {}
        for t in ([0.5] if L < 30 else [0.2, 0.5, 0.8]):
            p = (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
            best = None
            for ra, rb, name in routes:
                dist, u = seg_dist(p, ra, rb)
                if dist > 30 or abs(u[0] * d[0] + u[1] * d[1]) < 0.75:
                    continue
                if best is None or dist < best[0]:
                    best = (dist, name)
            if best:
                votes[best[1]] = votes.get(best[1], 0) + 1 / (1 + best[0])
        return max(votes, key=votes.get) if votes else None

    # Dense indices: parking positions first (their order is the menu's).
    order = [p["key"] for p in parking] + [k for k in nodes if k not in park_keys and k in linked]
    dense = {g: k for k, g in enumerate(order)}
    names, name_idx = [], {}

    def nidx(name):
        if not name:
            return -1
        if name not in name_idx:
            name_idx[name] = len(names)
            names.append(name)
        return name_idx[name]

    pairs = {}
    for arc in arcs:
        i, j = arc["a"], arc["b"]
        key = (min(i, j), max(i, j))
        ent = pairs.setdefault(key, {"dirs": set(), "arc": arc, "push": arc["push"]})
        ent["dirs"].add((i, j) if not arc.get("oneway") else (i, j, "one"))
        if not arc.get("oneway"):
            ent["dirs"].add((j, i))
        ent["push"] = ent["push"] and arc["push"]
    edges, named, total = [], 0, 0
    for (i, j), ent in pairs.items():
        arc = ent["arc"]
        flags = PUSHBACK if ent["push"] else 0
        two_way = (i, j) in ent["dirs"] and (j, i) in ent["dirs"]
        a, b = (i, j) if two_way or (i, j) in ent["dirs"] or (i, j, "one") in ent["dirs"] else (j, i)
        if not two_way:
            flags |= ONE_WAY
        name = arc["name"]
        if (rwy_of[i] and rwy_of[i] == rwy_of[j]) or arc["runway"]:
            flags |= RUNWAY
            name = rwy_of[i] or rwy_of[j] or name
        elif not ent["push"]:
            total += 1
            if name is None:
                name = name_for(i, j)
            if name:
                named += 1
        edges.append([dense[a], dense[b], nidx(name), flags, math.hypot(xy[a][0] - xy[b][0], xy[a][1] - xy[b][1])])

    smooth_names(edges, names)
    out_parking = [[dense[p["key"]], p["label"], p["type"], round(p["heading"], 1), round(p["radius"], 1),
                    dense.get(p["pushback"], -1)] for p in parking]
    out_nodes = [[round(nodes[g][0], 7), round(nodes[g][1], 7)] for g in order]
    stats = {"parking": len(parking), "nodes": len(order), "taxi_edges": total, "named": named, "src": src,
             "gateway_layout": gw_ok}
    return {"icao": airport["icao"], "frequencies": freqs, "names": names, "nodes": out_nodes, "edges": edges,
            "parking": out_parking}, stats


def smooth_names(edges, names):
    """One name per stretch of taxiway: along a chain of segments between
    junctions the names transferred point by point can flip between two
    close parallel Gateway taxiways; the chain takes the name most of its
    length has (and its unnamed bits too, when that is most of it)."""
    taxi = [e for e in edges if not e[3] & (PUSHBACK | RUNWAY)]
    deg = {}
    for a, b, *_rest in taxi:
        deg[a] = deg.get(a, 0) + 1
        deg[b] = deg.get(b, 0) + 1
    by_node = {}
    for e in taxi:
        by_node.setdefault(e[0], []).append(e)
        by_node.setdefault(e[1], []).append(e)
    seen = set()
    for e in taxi:
        if id(e) in seen:
            continue
        # Grow the chain both ways through nodes with exactly two segments.
        chain = [e]
        seen.add(id(e))
        for end in (e[0], e[1]):
            n, prev = end, e
            while deg.get(n) == 2:
                nxt = next(x for x in by_node[n] if x is not prev)
                if id(nxt) in seen:
                    break
                seen.add(id(nxt))
                chain.append(nxt)
                n = nxt[1] if nxt[0] == n else nxt[0]
                prev = nxt
        votes = {}
        for x in chain:
            votes[x[2]] = votes.get(x[2], 0) + x[4]
        named = {k: v for k, v in votes.items() if k >= 0}
        if not named:
            continue
        top = max(named, key=named.get)
        total = sum(votes.values())
        for x in chain:
            if x[2] >= 0 or named[top] > 0.5 * total:
                x[2] = top
    for e in edges:
        del e[4:]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenery", required=True, help="scenery output dir with airports.json")
    ap.add_argument("--cache", default="build/groundnets")
    ap.add_argument("--server", default=DEFAULT_SERVER)
    ap.add_argument("--airport", action="append", help="only these airports (default: all)")
    ap.add_argument("--region", action="append", help="only the airports of these regions (tools/regions.json)")
    args = ap.parse_args()
    server = args.server if args.server.endswith("/") else args.server + "/"
    airports = json.load(open(os.path.join(args.scenery, "airports.json")))["airports"]
    out_dir = os.path.join(args.scenery, "groundnets")
    os.makedirs(out_dir, exist_ok=True)
    wanted = [a for a in airports if (not args.airport or a["icao"] in args.airport)
              and (not args.region or a.get("region") in args.region)]
    # Building some airports keeps the others' ground networks.
    index = {}
    index_path = os.path.join(out_dir, "index.json")
    if (args.airport or args.region) and os.path.isfile(index_path):
        known = {a["icao"] for a in airports} - {a["icao"] for a in wanted}
        index = {k: v for k, v in json.load(open(index_path)).items() if k in known}
    for a in wanted:
        icao = a["icao"]
        gn = terrasync_groundnet(icao, args.cache, server)
        sid, apt = gateway_apt(icao, args.cache)
        built = build_airport(a, gn, apt)
        if not built:
            print(f"{icao}: no parking positions")
            if os.path.isfile(os.path.join(out_dir, f"{icao}.json")):
                os.remove(os.path.join(out_dir, f"{icao}.json"))
            continue
        data, st = built
        src = st["src"]
        data["sources"] = {
            "groundnet": f"TerraSync Airports/{'/'.join(icao[:3])}/{icao}.groundnet.xml" if gn else None,
            "gateway": f"X-Plane Scenery Gateway scenery {sid}" if sid else None,
            "graph": src["graph"], "parking": src["parking"],
        }
        with open(os.path.join(out_dir, f"{icao}.json"), "w") as fh:
            json.dump(data, fh, separators=(",", ":"))
        index[icao] = {"parking": st["parking"], "taxi": st["taxi_edges"] > 0}
        print(f"{icao}: {st['parking']} parking ({src['parking']}), {st['nodes']} nodes, "
              f"{st['named']}/{st['taxi_edges']} taxi segments named, graph from {src['graph']}"
              + ("" if st["gateway_layout"] or not sid else f" [Gateway scenery {sid}: runways differ]"))
    order = {a["icao"]: i for i, a in enumerate(airports)}
    index = dict(sorted(index.items(), key=lambda kv: order[kv[0]]))
    with open(index_path, "w") as fh:
        json.dump(index, fh, separators=(",", ":"))
    print(f"wrote {len(index)} ground networks to {out_dir}")


if __name__ == "__main__":
    main()
