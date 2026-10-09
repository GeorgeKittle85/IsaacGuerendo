#!/usr/bin/env python3
"""OpenStreetMap buildings, roads and railways for the scenery tiles.

Reads OpenStreetMap extracts (.osm.pbf, e.g. Geofabrik's oregon, norcal,
washington, idaho and nevada) and writes, for every land tile of
site/data/scenery/index.json:

  site/data/scenery/osm/<tile>.bin.gz   the tile's buildings and roads
  site/data/scenery/osm/index.json      per tile: how many, how big

Buildings are footprints with heights, as OSM's Simple 3D Buildings has
them: `height` (or `building:levels` at 3 m a level, or a default for the
kind of building), `min_height` / `building:min_level`, `roof:shape` and
`roof:height`, `building:colour` and `roof:colour`.  Where a building is
split into `building:part`s, the parts replace its outline.  Small houses
get pitched roofs.  Buildings a TerraSync model already stands on (the SFO
terminals, downtown San Francisco's towers, hangars) are left out, as
osm2city does for FlightGear.

Roads are the highway classes from motorways down to residential streets
and plain service roads, with their width from `width`, `lanes` or the
class; railways are the main lines.  Tunnels are left out; bridges are kept
and drawn as decks between their ends (except where a TerraSync model is the
bridge).  Roads are cut at tile edges, buildings belong to the tile of their
middle.

The site places everything on the terrain as the tile loads
(site/js/scene/osm.js), so the file holds no elevations.

File format (gzip'd, little-endian):
  "OSM1", u32 version, f64 lat0, lon0, lat1, lon1 (the tile's bounds),
  u32 buildings, u32 roads, u32 stream length, then a stream of LEB128
  varints, column by column:
    buildings: rings, then each ring's vertex count, height, min height and
      roof height (decimetres), style (kind | roof shape << 5 | wall colour
      << 8 | roof colour << 9), the colours (0xRRGGBB), then every vertex
    roads: class, width (decimetres), flags (1 bridge, 2 one way, lanes << 4),
      vertex count, then
      every vertex
  Vertices are zigzag deltas from the previous vertex in 1/65536 of the
  tile's width and height from its south-west corner (about 0.3 m).

Example:
    python3 tools/build_osm.py --scenery site/data/scenery \\
        --pbf build/osm/oregon-latest.osm.pbf --pbf build/osm/norcal-latest.osm.pbf ...
"""

import argparse
import array
import collections
import gzip
import json
import math
import os
import re
import struct
import sys
import time

import numpy as np
import osmium

sys.path.insert(0, os.path.dirname(__file__))
import regions  # noqa: E402

Q = 65536            # quantisation steps across a tile
M_PER_DEG = 111195.0
CELL = 4.0           # metres: grid of the ground TerraSync models cover

# ----------------------------------------------------------------- tags

BUILDING_KINDS = [
    "yes", "house", "residential", "apartments", "commercial", "retail", "office", "industrial",
    "warehouse", "garage", "shed", "religious", "school", "hospital", "hangar", "civic", "roof",
    "parking", "farm", "greenhouse", "tower",
]
KIND = {k: i for i, k in enumerate(BUILDING_KINDS)}
KIND_OF = {
    **dict.fromkeys(["house", "detached", "semidetached_house", "terrace", "bungalow", "cabin",
                     "static_caravan", "dwelling_house", "semi", "townhouse"], "house"),
    "residential": "residential",
    **dict.fromkeys(["apartments", "dormitory", "hotel", "condominium"], "apartments"),
    "commercial": "commercial",
    **dict.fromkeys(["retail", "supermarket", "kiosk", "store", "shop"], "retail"),
    "office": "office",
    **dict.fromkeys(["industrial", "manufacture", "factory", "works"], "industrial"),
    **dict.fromkeys(["warehouse", "storage", "depot"], "warehouse"),
    **dict.fromkeys(["garage", "garages", "carport"], "garage"),
    **dict.fromkeys(["shed", "hut", "outbuilding"], "shed"),
    **dict.fromkeys(["church", "chapel", "cathedral", "mosque", "temple", "synagogue", "shrine",
                     "religious", "monastery"], "religious"),
    **dict.fromkeys(["school", "university", "college", "kindergarten"], "school"),
    "hospital": "hospital",
    "hangar": "hangar",
    **dict.fromkeys(["civic", "public", "government", "fire_station", "train_station", "transportation",
                     "stadium", "sports_hall", "sports_centre", "grandstand", "museum", "library"], "civic"),
    "roof": "roof",
    **dict.fromkeys(["parking", "garage_parking"], "parking"),
    **dict.fromkeys(["barn", "farm", "farm_auxiliary", "cowshed", "stable", "silo", "sty"], "farm"),
    "greenhouse": "greenhouse",
    **dict.fromkeys(["tower", "water_tower", "transformer_tower", "bunker"], "tower"),
}
# Total height (with the roof) when nothing says: metres.
KIND_HEIGHT = {
    "house": 7.0, "residential": 7.0, "apartments": 12.0, "commercial": 7.0, "retail": 6.0, "office": 14.0,
    "industrial": 9.0, "warehouse": 9.0, "garage": 3.0, "shed": 3.0, "religious": 12.0, "school": 9.0,
    "hospital": 18.0, "hangar": 12.0, "civic": 10.0, "roof": 5.0, "parking": 9.0, "farm": 7.0,
    "greenhouse": 4.0, "tower": 15.0,
}
HOUSES = {"house", "residential", "farm", "garage", "shed"}
SKIP_BUILDINGS = {"no", "construction", "proposed", "demolished", "destroyed", "abandoned", "ruins", "collapsed",
                  "razed", "planned", "disused", "bridge", "canopy_frame", "tent"}

ROOF_SHAPES = {"flat": 0, "skillion": 0, "gabled": 1, "saltbox": 1, "gambrel": 1, "round": 1, "hipped": 2,
               "half-hipped": 2, "side_hipped": 2, "mansard": 2, "pyramidal": 3, "dome": 4, "onion": 4}

COLOURS = {
    "white": 0xF2F0EA, "black": 0x2C2C2C, "gray": 0x8C8C8C, "grey": 0x8C8C8C, "silver": 0xC0C0C0,
    "lightgray": 0xCFCFCF, "lightgrey": 0xCFCFCF, "darkgray": 0x5E5E5E, "darkgrey": 0x5E5E5E,
    "dimgray": 0x696969, "dimgrey": 0x696969, "gainsboro": 0xDCDCDC, "slategray": 0x708090,
    "red": 0xA8463A, "darkred": 0x7A2A22, "maroon": 0x6E2B25, "firebrick": 0x9E3A2F, "brown": 0x80583C,
    "saddlebrown": 0x7A4A28, "sienna": 0x8E5434, "chocolate": 0x9C5C2E, "peru": 0xB07D4A, "tan": 0xC9AE88,
    "burlywood": 0xD2B48C, "beige": 0xE3D9BE, "cream": 0xEEE6CC, "ivory": 0xF4F1E4, "linen": 0xF2ECE2,
    "wheat": 0xE8D8B0, "khaki": 0xCDBE8A, "sandybrown": 0xD6A26C, "yellow": 0xD9C35C, "gold": 0xC9A93C,
    "orange": 0xD08A45, "salmon": 0xD99482, "pink": 0xD9AAA8, "terracotta": 0xB8674A, "copper": 0xA86A3E,
    "bronze": 0x8C6A3A, "green": 0x4E7A4A, "darkgreen": 0x2F4F2F, "olive": 0x727046, "teal": 0x3C7A78,
    "blue": 0x4A6A9A, "lightblue": 0x9DB8D0, "navy": 0x2C3A5A, "darkblue": 0x2E3C66, "steelblue": 0x5A7FA0,
    "glass": 0x7E95A6, "brick": 0xA0573E, "concrete": 0xB4B0A8, "stone": 0xB3AA98, "sand": 0xD8C8A0,
}

ROAD_CLASSES = {  # highway -> (class, width in metres when nothing says)
    "motorway": (0, 11.0), "trunk": (1, 10.0), "primary": (2, 9.0), "secondary": (3, 8.0), "tertiary": (4, 7.0),
    "motorway_link": (5, 6.0), "trunk_link": (6, 6.0), "primary_link": (6, 6.0),
    "secondary_link": (7, 5.5), "tertiary_link": (7, 5.5),
    "unclassified": (8, 6.0), "road": (8, 6.0), "residential": (9, 6.0), "living_street": (9, 5.0),
    "service": (10, 4.0),
}
RAIL = (11, 4.5)
ROAD_CLASS_NAMES = ["motorway", "trunk", "primary", "secondary", "tertiary", "motorway_link", "trunk_link",
                    "minor_link", "unclassified", "residential", "service", "rail"]

_num = re.compile(r"[-+]?\d+(?:[.,]\d+)?")
_feet_inches = re.compile(r"^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*(?:\"|'')?)?$")


def parse_length(v):
    """OSM lengths: "12", "12 m", "12.5m", "40'", "40 ft", "12'6\"", "3;4" -> metres or None."""
    if not v:
        return None
    v = v.strip().lower()
    if ";" in v:
        vals = [x for x in (parse_length(p) for p in v.split(";")) if x is not None]
        return max(vals) if vals else None
    m = _feet_inches.match(v)
    if m:
        return float(m.group(1)) * 0.3048 + (float(m.group(2)) * 0.0254 if m.group(2) else 0.0)
    m = _num.search(v)
    if not m:
        return None
    x = float(m.group(0).replace(",", "."))
    if "ft" in v or "feet" in v or "foot" in v:
        x *= 0.3048
    return x if math.isfinite(x) else None


def parse_levels(v):
    x = parse_length(v)
    return None if x is None or x < 0 or x > 200 else x


def parse_colour(v):
    if not v:
        return None
    v = v.strip().lower().replace(" ", "").replace("_", "")
    if v.startswith("#"):
        h = v[1:]
        if len(h) == 3 and all(c in "0123456789abcdef" for c in h):
            return int("".join(c * 2 for c in h), 16)
        if len(h) == 6 and all(c in "0123456789abcdef" for c in h):
            return int(h, 16)
        return None
    return COLOURS.get(v)


def building_kind(tags):
    b = tags.get("building") or tags.get("building:part") or "yes"
    return KIND_OF.get(b, "yes")


# ----------------------------------------------------------------- geometry

def ring_area(xs, ys):
    """Signed area (counter-clockwise positive)."""
    a = 0.0
    n = len(xs)
    for i in range(n):
        j = i - 1
        a += xs[j] * ys[i] - xs[i] * ys[j]
    return a / 2


def simplify(xs, ys, tol, closed):
    """Douglas-Peucker; returns the indices to keep."""
    n = len(xs)
    if n <= 2:
        return list(range(n))
    keep = [False] * n
    if closed:
        # Split at the vertex farthest from the first one.
        far = max(range(n), key=lambda i: (xs[i] - xs[0]) ** 2 + (ys[i] - ys[0]) ** 2)
        spans = [(0, far), (far, n)]
        xs = list(xs) + [xs[0]]
        ys = list(ys) + [ys[0]]
        keep += [False]
    else:
        spans = [(0, n - 1)]
    tol2 = tol * tol
    for a, b in spans:
        keep[a] = keep[b] = True
        stack = [(a, b)]
        while stack:
            i, j = stack.pop()
            if j <= i + 1:
                continue
            ax, ay, bx, by = xs[i], ys[i], xs[j], ys[j]
            dx, dy = bx - ax, by - ay
            l2 = dx * dx + dy * dy
            best, bi = -1.0, -1
            for k in range(i + 1, j):
                px, py = xs[k] - ax, ys[k] - ay
                if l2 > 0:
                    t = max(0.0, min(1.0, (px * dx + py * dy) / l2))
                    ex, ey = px - t * dx, py - t * dy
                else:
                    ex, ey = px, py
                d = ex * ex + ey * ey
                if d > best:
                    best, bi = d, k
            if best > tol2:
                keep[bi] = True
                stack.append((i, bi))
                stack.append((bi, j))
    out = [i for i in range(n) if keep[i]]
    return out


def point_in_ring(x, y, xs, ys):
    inside = False
    n = len(xs)
    for i in range(n):
        x1, y1, x2, y2 = xs[i - 1], ys[i - 1], xs[i], ys[i]
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


class TileGrid:
    """The land tiles: lat/lon -> tile id, and each tile's quantisation frame."""

    def __init__(self, tiles):
        self.tiles = {t["id"]: t for t in tiles}
        lats = [t["lat0"] for t in tiles] + [t["lat1"] for t in tiles]
        lons = [t["lon0"] for t in tiles] + [t["lon1"] for t in tiles]
        self.bbox = (min(lats), min(lons), max(lats), max(lons))

    def tile_at(self, lat, lon):
        flon, flat = math.floor(lon), math.floor(lat)
        span = regions.bucket_span(lat)
        x = int((lon - flon) / span)
        y = int((lat - flat) * 8)
        tid = regions.tile_index(flon, flat, x, y)
        return tid if tid in self.tiles else None

    def inside(self, lat, lon):
        b = self.bbox
        return b[0] <= lat <= b[2] and b[1] <= lon <= b[3]


# ----------------------------------------------------------------- TerraSync models

def ac_triangles(path):
    """Triangles of an AC3D file in FlightGear model axes (x, y, z up), as an (n, 3, 3) array."""
    with gzip.open(path, "rt", errors="replace") as fh:
        lines = fh.read().splitlines()
    tris = []
    i = 0

    def obj(parent):
        nonlocal i
        i += 1
        rot, loc, verts = np.eye(3), np.zeros(3), None
        while i < len(lines):
            parts = lines[i].split()
            if not parts:
                i += 1
                continue
            k = parts[0]
            if k == "data":
                n, got = int(parts[1]), 0
                i += 1
                while got < n and i < len(lines):
                    got += len(lines[i]) + 1
                    i += 1
                continue
            if k == "rot":
                rot = np.array([float(p) for p in parts[1:10]]).reshape(3, 3)
            elif k == "loc":
                loc = np.array([float(p) for p in parts[1:4]])
            elif k == "numvert":
                n = int(parts[1])
                verts = np.array([[float(p) for p in lines[i + 1 + j].split()[:3]] for j in range(n)]) if n else None
                i += n
            elif k == "numsurf":
                n = int(parts[1])
                i += 1
                m_rot = parent[0] @ rot
                m_loc = parent[0] @ loc + parent[1]
                world = None if verts is None else verts @ m_rot.T + m_loc
                for _ in range(n):
                    flags = 0
                    while i < len(lines) and not lines[i].startswith("refs"):
                        if lines[i].startswith("SURF"):
                            flags = int(lines[i].split()[1], 0)
                        i += 1
                    nr = int(lines[i].split()[1])
                    idx = [int(lines[i + 1 + j].split()[0]) for j in range(nr)]
                    i += nr + 1
                    if world is not None and flags & 0xF == 0 and nr >= 3:
                        for j in range(1, nr - 1):
                            tris.append(world[[idx[0], idx[j], idx[j + 1]]])
                continue
            elif k == "kids":
                n = int(parts[1])
                i += 1
                me = (parent[0] @ rot, parent[0] @ loc + parent[1])
                for _ in range(n):
                    while i < len(lines) and not lines[i].startswith("OBJECT"):
                        i += 1
                    if i < len(lines):
                        obj(me)
                return
            i += 1

    while i < len(lines) and not lines[i].startswith("OBJECT"):
        i += 1
    if i < len(lines):
        obj((np.eye(3), np.zeros(3)))
    if not tris:
        return np.zeros((0, 3, 3))
    t = np.array(tris)
    # AC3D is y-up: (x, y, z) -> FlightGear's (x, -z, y).
    return np.stack([t[..., 0], -t[..., 2], t[..., 1]], axis=-1)


# Shared models that are not buildings and stand where buildings may be.
NOT_COVERING = re.compile(r"^Models/(Trees|Fauna|Effects|Boundaries|Maritime|Aircraft|Airport/Vehicle|StreetFurniture)/")


class Covered:
    """The ground TerraSync's models stand on, per tile: CELL-metre cells."""

    def __init__(self, scenery, grid):
        self.cells = collections.defaultdict(set)
        objdir = os.path.join(scenery, "objects")
        manifest = os.path.join(objdir, "model.json")
        if not os.path.isfile(manifest):
            return
        m = json.load(open(manifest))
        refs, models = m.get("refs", {}), m.get("models", {})
        cache = {}
        for tid, t in grid.tiles.items():
            for o in t.get("objects", []):
                if o["kind"] == "sign":
                    continue
                if o["kind"] == "shared" and NOT_COVERING.match(o["path"]):
                    continue
                ref = f"static:{t['objectsDir']}/{o['path']}" if o["kind"] == "static" else f"shared:{o['path']}"
                key = refs.get(ref)
                if not key or key not in models:
                    continue
                if key not in cache:
                    cache[key] = self._model_tris(objdir, models[key])
                tris = cache[key]
                if len(tris):
                    self._mark(tid, t, o, tris)

    @staticmethod
    def _model_tris(objdir, model):
        ac = model.get("ac")
        path = ac and os.path.join(objdir, "files", ac + ".gz")
        if not path or not os.path.isfile(path):
            return np.zeros((0, 3, 3))
        tris = ac_triangles(path)
        off = next((c for c in (model.get("config") or {}).get("c", []) if c["n"] == "offsets"), None)
        if off is not None and len(tris):
            vals = {c["n"]: float(c.get("v", 0) or 0) for c in off.get("c", [])}
            h = math.radians(vals.get("heading-deg", 0.0))
            c, s = math.cos(h), math.sin(h)
            x, y = tris[..., 0].copy(), tris[..., 1].copy()
            tris[..., 0] = c * x - s * y + vals.get("x-m", 0.0)
            tris[..., 1] = s * x + c * y + vals.get("y-m", 0.0)
        return tris

    def _mark(self, tid, t, o, tris):
        kx = M_PER_DEG * math.cos(math.radians((t["lat0"] + t["lat1"]) / 2))
        ox = (o["lon"] - t["lon0"]) * kx
        oy = (o["lat"] - t["lat0"]) * M_PER_DEG
        h = math.radians(o["hdg"])
        c, s = math.cos(h), math.sin(h)
        x, y = tris[..., 0], tris[..., 1]
        # SimGear's placement: x south, y east, rotated by the heading.
        xr, yr = c * x - s * y, s * x + c * y
        east, north = ox + yr, oy - xr
        cells = self.cells[tid]
        for e, n in zip(east, north):
            cx0, cx1 = int(math.floor(e.min() / CELL)), int(math.floor(e.max() / CELL))
            cy0, cy1 = int(math.floor(n.min() / CELL)), int(math.floor(n.max() / CELL))
            for k in range(3):
                cells.add((int(math.floor(e[k] / CELL)), int(math.floor(n[k] / CELL))))
            if (cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 250000:
                continue
            gx, gy = np.meshgrid(np.arange(cx0, cx1 + 1), np.arange(cy0, cy1 + 1))
            px, py = (gx + 0.5) * CELL, (gy + 0.5) * CELL
            d = (n[1] - n[2]) * (e[0] - e[2]) + (e[2] - e[1]) * (n[0] - n[2])
            if abs(d) < 1e-6:
                continue
            a = ((n[1] - n[2]) * (px - e[2]) + (e[2] - e[1]) * (py - n[2])) / d
            b = ((n[2] - n[0]) * (px - e[2]) + (e[0] - e[2]) * (py - n[2])) / d
            inside = (a >= 0) & (b >= 0) & (a + b <= 1)
            for gxx, gyy in zip(gx[inside], gy[inside]):
                cells.add((int(gxx), int(gyy)))

    def fraction(self, tid, t, pts):
        """Share of the (lat, lon) points that are on covered ground."""
        cells = self.cells.get(tid)
        if not cells:
            return 0.0
        kx = M_PER_DEG * math.cos(math.radians((t["lat0"] + t["lat1"]) / 2))
        hit = sum(1 for lat, lon in pts
                  if (int(math.floor((lon - t["lon0"]) * kx / CELL)), int(math.floor((lat - t["lat0"]) * M_PER_DEG / CELL))) in cells)
        return hit / max(1, len(pts))


# ----------------------------------------------------------------- collecting

def quantiser(t):
    """(lon, lat) points -> flat array('i') of the tile's 1/65536 steps from its south-west corner."""
    lon0, lat0 = t["lon0"], t["lat0"]
    sx, sy = Q / (t["lon1"] - lon0), Q / (t["lat1"] - lat0)
    return lambda pts: array.array("i", [v for p in pts for v in (round((p[0] - lon0) * sx), round((p[1] - lat0) * sy))])


def dequantise(t, x, y):
    """Tile steps -> (lat, lon)."""
    return (t["lat0"] + y * (t["lat1"] - t["lat0"]) / Q, t["lon0"] + x * (t["lon1"] - t["lon0"]) / Q)


# Records, kept small (millions of them):
#   building: (rings: tuple of array('i'), height, min height, roof height, kind, roof shape, wall colour,
#              roof colour, is a part)
#   road: (class, width, flags, array('i'))
B_RINGS, B_H, B_MIN, B_ROOF, B_KIND, B_SHAPE, B_WALL, B_ROOFC, B_PART = range(9)


class Collector:
    def __init__(self, grid, covered, min_area):
        self.grid = grid
        self.covered = covered
        self.min_area = min_area
        self.buildings = collections.defaultdict(list)  # tile -> [record]
        self.roads = collections.defaultdict(list)
        self.seen = set()
        self.stats = collections.Counter()
        self.quant = {tid: quantiser(t) for tid, t in grid.tiles.items()}

    # --- buildings
    def area(self, a):
        tags = a.tags
        is_part = "building:part" in tags and "building" not in tags
        b = tags.get("building") or tags.get("building:part")
        if not b or b in SKIP_BUILDINGS or (is_part and b == "no"):
            return
        key = ("a", a.id)
        if key in self.seen:
            return
        rings = []
        for outer in a.outer_rings():
            pts = [(n.lon, n.lat) for n in outer]
            holes = [[(n.lon, n.lat) for n in inner] for inner in a.inner_rings(outer)]
            rings.append((pts, holes))
        if not rings:
            return
        lon0, lat0 = rings[0][0][0]
        if not self.grid.inside(lat0, lon0):
            return
        self.seen.add(key)
        for pts, holes in rings:
            self._building(pts, holes, tags, is_part)

    def _building(self, pts, holes, tags, is_part):
        if len(pts) < 4:
            return
        pts = pts[:-1] if pts[0] == pts[-1] else pts
        clon = sum(p[0] for p in pts) / len(pts)
        clat = sum(p[1] for p in pts) / len(pts)
        tid = self.grid.tile_at(clat, clon)
        if tid is None:
            return
        t = self.grid.tiles[tid]
        kx = M_PER_DEG * math.cos(math.radians(clat))
        xs = [(p[0] - clon) * kx for p in pts]
        ys = [(p[1] - clat) * M_PER_DEG for p in pts]
        area = ring_area(xs, ys)
        kind = building_kind(tags)
        height = parse_length(tags.get("height"))
        levels = parse_levels(tags.get("building:levels"))
        roof_levels = parse_levels(tags.get("roof:levels")) or 0.0
        roof_h = parse_length(tags.get("roof:height"))
        shape_tag = (tags.get("roof:shape") or "").strip().lower()
        shape = ROOF_SHAPES.get(shape_tag, 0)
        if height is None and levels is not None:
            height = (levels + roof_levels) * 3.0 + (roof_h if roof_h and not roof_levels else 0.0)
        if height is None:
            height = KIND_HEIGHT.get(kind)
            if height is None:
                a = abs(area)
                height = 5.0 if a < 150 else 7.0 if a < 600 else 9.0 if a < 3000 else 11.0
        min_h = parse_length(tags.get("min_height"))
        if min_h is None:
            ml = parse_levels(tags.get("building:min_level"))
            min_h = ml * 3.0 if ml else 0.0
        if kind == "roof" and min_h == 0.0:
            min_h = max(0.0, height - 1.0)
        height = min(height, 600.0)
        if not (height > min_h + 0.5):
            self.stats["bad height"] += 1
            return
        if abs(area) < self.min_area and height < 6:
            self.stats["tiny"] += 1
            return
        keep = simplify(xs, ys, 0.3, True)
        if len(keep) < 3:
            return
        pts = [pts[i] for i in keep]
        xs = [xs[i] for i in keep]
        ys = [ys[i] for i in keep]
        if ring_area(xs, ys) < 0:
            pts.reverse()
            xs.reverse()
            ys.reverse()
        # Small houses with four corners get a pitched roof when OSM gives none.
        if not shape_tag and kind in HOUSES and len(pts) == 4 and not holes and abs(area) < 400 and kind not in ("garage", "shed"):
            shape = 1 if (hash((round(clat, 5), round(clon, 5))) & 3) else 2
        if shape and roof_h is None:
            sides = [math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]) for i in range(len(xs))]
            short = min(sides) if len(sides) == 4 else math.sqrt(abs(area))
            roof_h = max(1.2, min(4.0, 0.35 * short))
        roof_h = min(roof_h or 0.0, (height - min_h) * 0.7) if shape else 0.0
        hole_rings = []
        for h in holes:
            h = h[:-1] if len(h) > 1 and h[0] == h[-1] else h
            if len(h) < 3:
                continue
            hx = [(p[0] - clon) * kx for p in h]
            hy = [(p[1] - clat) * M_PER_DEG for p in h]
            k = simplify(hx, hy, 0.3, True)
            if len(k) < 3:
                continue
            h = [h[i] for i in k]
            if ring_area([hx[i] for i in k], [hy[i] for i in k]) > 0:
                h.reverse()
            hole_rings.append(h)
        wall = parse_colour(tags.get("building:colour") or tags.get("building:color") or tags.get("colour"))
        roof = parse_colour(tags.get("roof:colour") or tags.get("roof:color"))
        q = self.quant[tid]
        self.buildings[tid].append((tuple(q(r) for r in [pts] + hole_rings), height, min_h, roof_h, KIND[kind],
                                    shape if not hole_rings else 0, wall, roof, is_part))
        self.stats["parts" if is_part else "buildings"] += 1

    # --- roads and railways
    def way(self, w):
        tags = w.tags
        hw = tags.get("highway")
        if hw:
            spec = ROAD_CLASSES.get(hw)
            if not spec or tags.get("area") == "yes":
                return
            if hw == "service" and tags.get("service") not in (None, "alley"):
                return
        elif tags.get("railway") == "rail" and "service" not in tags and tags.get("usage") != "industrial":
            spec = RAIL
        else:
            return
        if tags.get("tunnel") not in (None, "no") or tags.get("covered") == "yes":
            return
        layer = parse_length(tags.get("layer")) or 0
        if layer < 0 and tags.get("bridge") in (None, "no"):
            return
        key = ("w", w.id)
        if key in self.seen:
            return
        try:
            pts = [(n.lon, n.lat) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(pts) < 2 or not any(self.grid.inside(p[1], p[0]) for p in (pts[0], pts[-1], pts[len(pts) // 2])):
            return
        self.seen.add(key)
        cls, width = spec
        wt = parse_length(tags.get("width"))
        lanes = parse_levels(tags.get("lanes"))
        if wt and 2.0 <= wt <= 60.0:
            width = wt
        elif lanes and 1 <= lanes <= 12 and cls != RAIL[0]:
            width = lanes * 3.5 + (3.0 if cls in (0, 1) else 0.0)
        bridge = tags.get("bridge") not in (None, "no")
        oneway = tags.get("oneway") in ("yes", "1", "-1", "true") or (
            tags.get("oneway") is None and hw in ("motorway", "motorway_link"))
        nl = int(lanes) if lanes and 1 <= lanes <= 15 and cls != RAIL[0] else 0
        flags = (1 if bridge else 0) | (2 if oneway else 0) | (nl << 4)
        self._road(pts, cls, width, flags)

    def _road(self, pts, cls, width, flags):
        clat = pts[0][1]
        kx = M_PER_DEG * math.cos(math.radians(clat))
        xs = [(p[0] - pts[0][0]) * kx for p in pts]
        ys = [(p[1] - pts[0][1]) * M_PER_DEG for p in pts]
        keep = simplify(xs, ys, 1.0, False)
        pts = [pts[i] for i in keep]
        if flags & 1:
            # A bridge stays in one piece, in the tile of its middle, so its
            # deck spans from bank to bank.
            mid = pts[len(pts) // 2] if len(pts) > 2 else ((pts[0][0] + pts[-1][0]) / 2, (pts[0][1] + pts[-1][1]) / 2)
            tid = self.grid.tile_at(mid[1], mid[0])
            if tid is None:
                return
            t = self.grid.tiles[tid]
            samples = [((a[1] + b[1]) / 2, (a[0] + b[0]) / 2) for a, b in zip(pts, pts[1:])]
            if self.covered.fraction(tid, t, samples) > 0.3:
                self.stats["bridges under models"] += 1
                return
            self.roads[tid].append((cls, width, flags, self.quant[tid](pts)))
            self.stats["roads"] += 1
            return
        for tid, piece in self._split(pts):
            self.roads[tid].append((cls, width, flags, self.quant[tid](piece)))
            self.stats["roads"] += 1

    def _split(self, pts):
        """Cuts a polyline at tile edges -> [(tile, points)]."""
        out = []
        cur, cur_tid = [pts[0]], None
        for a, b in zip(pts, pts[1:]):
            ts = [0.0, 1.0]
            for k, step in ((1, 0.125), (0, regions.bucket_span(a[1]))):
                lo, hi = sorted((a[k], b[k]))
                g = math.floor(lo / step) * step + step
                while g < hi:
                    ts.append((g - a[k]) / (b[k] - a[k]))
                    g += step
            ts = sorted(set(ts))
            for t0, t1 in zip(ts, ts[1:]):
                p1 = (a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1)
                tm = (t0 + t1) / 2
                tid = self.grid.tile_at(a[1] + (b[1] - a[1]) * tm, a[0] + (b[0] - a[0]) * tm)
                if tid != cur_tid:
                    if cur_tid is not None and len(cur) >= 2:
                        out.append((cur_tid, cur))
                    p0 = (a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0)
                    cur, cur_tid = [p0], tid
                cur.append(p1)
        if cur_tid is not None and len(cur) >= 2:
            out.append((cur_tid, cur))
        return out

    # --- per tile clean-up
    def finish_tile(self, tid):
        """Parts replace the outline they are in; models' ground removes buildings."""
        t = self.grid.tiles[tid]
        recs = self.buildings.pop(tid, [])
        parts = [r for r in recs if r[B_PART]]
        outlines = [r for r in recs if not r[B_PART]]
        if parts:
            cell = 512  # tile steps
            index = collections.defaultdict(list)
            boxes = []
            for i, r in enumerate(outlines):
                ring = r[B_RINGS][0]
                xs, ys = ring[0::2], ring[1::2]
                x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
                boxes.append((x0, y0, x1, y1))
                for gx in range(x0 // cell, x1 // cell + 1):
                    for gy in range(y0 // cell, y1 // cell + 1):
                        index[(gx, gy)].append(i)
            dropped = set()
            for p in parts:
                ring = p[B_RINGS][0]
                n = len(ring) // 2
                cx = sum(ring[0::2]) / n
                cy = sum(ring[1::2]) / n
                for i in index.get((int(cx // cell), int(cy // cell)), []):
                    if i in dropped:
                        continue
                    x0, y0, x1, y1 = boxes[i]
                    o = outlines[i][B_RINGS][0]
                    if x0 <= cx <= x1 and y0 <= cy <= y1 and point_in_ring(cx, cy, o[0::2], o[1::2]):
                        dropped.add(i)
            outlines = [r for i, r in enumerate(outlines) if i not in dropped]
            self.stats["outlines replaced by parts"] += len(dropped)
        recs = outlines + parts
        if self.covered.cells.get(tid):
            kept = []
            for r in recs:
                ring = r[B_RINGS][0]
                n = len(ring) // 2
                cx, cy = sum(ring[0::2]) / n, sum(ring[1::2]) / n
                pts = [(cx, cy)] + [(cx + (ring[2 * k] - cx) * 0.7, cy + (ring[2 * k + 1] - cy) * 0.7) for k in range(min(n, 12))]
                if self.covered.fraction(tid, t, [dequantise(t, x, y) for x, y in pts]) >= 0.4:
                    self.stats["under TerraSync models"] += 1
                    continue
                kept.append(r)
            recs = kept
        return recs


# ----------------------------------------------------------------- writing

def uvarints(vals):
    """LEB128 encoding of non-negative integers (vectorised)."""
    v = np.asarray(vals, dtype=np.uint64)
    if not len(v):
        return b""
    n = np.ones(len(v), dtype=np.int64)
    t = v >> np.uint64(7)
    while t.any():
        n += t > 0
        t >>= np.uint64(7)
    pos = np.concatenate([[0], np.cumsum(n)[:-1]])
    buf = np.zeros(int(n.sum()), dtype=np.uint8)
    cur = v.copy()
    for k in range(int(n.max())):
        m = n > k
        b = (cur[m] & np.uint64(0x7F)).astype(np.uint8)
        more = (n[m] > k + 1).astype(np.uint8) << 7
        buf[pos[m] + k] = b | more
        cur[m] >>= np.uint64(7)
    return buf.tobytes()


def zigzag(vals):
    v = np.asarray(vals, dtype=np.int64)
    return ((v << 1) ^ (v >> 63)).astype(np.uint64)


def morton(qx, qy):
    def spread(v):
        v = np.asarray(v, dtype=np.uint64) & np.uint64(0xFFFF)
        for s, m in ((8, 0x00FF00FF), (4, 0x0F0F0F0F), (2, 0x33333333), (1, 0x55555555)):
            v = (v | (v << np.uint64(s))) & np.uint64(m)
        return v
    return spread(np.clip(qx, 0, 65535)) | (spread(np.clip(qy, 0, 65535)) << np.uint64(1))


def deltas(flat, last):
    """Flat absolute (x, y, x, y, ...) -> zigzag deltas from the previous point, continuing from `last`."""
    a = np.asarray(flat, dtype=np.int64)
    if not len(a):
        return np.zeros(0, dtype=np.uint64), last
    d = np.diff(np.concatenate([np.asarray(last, dtype=np.int64), a]).reshape(-1, 2), axis=0).reshape(-1)
    return zigzag(d), (int(a[-2]), int(a[-1]))


def write_tile(path, t, buildings, roads):
    lat0, lon0, lat1, lon1 = t["lat0"], t["lon0"], t["lat1"], t["lon1"]
    if buildings:
        order = np.argsort(morton([b[B_RINGS][0][0] for b in buildings], [b[B_RINGS][0][1] for b in buildings]),
                           kind="stable")
        buildings = [buildings[i] for i in order]
    if roads:
        rorder = np.argsort(morton([r[3][0] for r in roads], [r[3][1] for r in roads]), kind="stable")
        roads = [roads[i] for i in rorder]

    cols = []
    dm = lambda x: max(0, int(round(x * 10)))  # noqa: E731
    cols.append([len(b[B_RINGS]) for b in buildings])
    cols.append([len(r) // 2 for b in buildings for r in b[B_RINGS]])
    cols.append([dm(b[B_H]) for b in buildings])
    cols.append([dm(b[B_MIN]) for b in buildings])
    cols.append([dm(b[B_ROOF]) for b in buildings])
    cols.append([b[B_KIND] | (b[B_SHAPE] << 5) | ((b[B_WALL] is not None) << 8) | ((b[B_ROOFC] is not None) << 9)
                 for b in buildings])
    cols.append([c for b in buildings for c in (b[B_WALL], b[B_ROOFC]) if c is not None])
    stream = b"".join(uvarints(c) for c in cols)
    d, last = deltas([v for b in buildings for r in b[B_RINGS] for v in r], (0, 0))
    stream += uvarints(d)
    rcols = [[r[0] for r in roads], [dm(r[1]) for r in roads], [r[2] for r in roads], [len(r[3]) // 2 for r in roads]]
    stream += b"".join(uvarints(c) for c in rcols)
    d, last = deltas([v for r in roads for v in r[3]], last)
    stream += uvarints(d)
    head = b"OSM1" + struct.pack("<I", 1) + struct.pack("<dddd", lat0, lon0, lat1, lon1)
    head += struct.pack("<III", len(buildings), len(roads), len(stream))
    with open(path, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=9, mtime=0) as fh:
        fh.write(head + stream)
    return os.path.getsize(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenery", default="site/data/scenery")
    ap.add_argument("--pbf", action="append", required=True, help="an OpenStreetMap extract (.osm.pbf)")
    ap.add_argument("--min-area", type=float, default=12.0, help="leave out lower buildings smaller than this (m2)")
    ap.add_argument("--only", type=int, action="append", help="write only these tiles")
    args = ap.parse_args()

    index = json.load(open(os.path.join(args.scenery, "index.json")))
    land = [t for t in index["tiles"] if "ocean" not in t]
    grid = TileGrid(land)
    t0 = time.time()
    covered = Covered(args.scenery, grid)
    print(f"TerraSync models cover {sum(len(c) for c in covered.cells.values())} cells "
          f"in {len(covered.cells)} tiles ({time.time() - t0:.0f}s)", flush=True)
    col = Collector(grid, covered, args.min_area)
    for pbf in args.pbf:
        t1 = time.time()
        fp = (osmium.FileProcessor(pbf).with_locations().with_areas()
              .with_filter(osmium.filter.KeyFilter("building", "building:part", "highway", "railway")))
        for o in fp:
            if o.is_area():
                if "building" in o.tags or "building:part" in o.tags:
                    col.area(o)
            elif o.is_way():
                if "highway" in o.tags or "railway" in o.tags:
                    col.way(o)
        print(f"{os.path.basename(pbf)}: {time.time() - t1:.0f}s, {dict(col.stats)}", flush=True)

    out = os.path.join(args.scenery, "osm")
    os.makedirs(out, exist_ok=True)
    entries = {}
    total = 0
    for t in sorted(land, key=lambda t: t["id"]):
        tid = t["id"]
        if args.only and tid not in args.only:
            continue
        b = col.finish_tile(tid)
        r = col.roads.pop(tid, [])
        path = os.path.join(out, f"{tid}.bin.gz")
        if not b and not r:
            if os.path.isfile(path):
                os.remove(path)
            continue
        size = write_tile(path, t, b, r)
        total += size
        entries[str(tid)] = {"buildings": len(b), "roads": len(r), "bytes": size,
                             "maxHeight": round(max((x[B_H] for x in b), default=0), 1)}
    meta = {
        "version": 1,
        "source": "OpenStreetMap contributors (ODbL 1.0): " + ", ".join(os.path.basename(p) for p in args.pbf),
        "kinds": BUILDING_KINDS,
        "roadClasses": ROAD_CLASS_NAMES,
        "tiles": entries,
    }
    with open(os.path.join(out, "index.json"), "w") as fh:
        json.dump(meta, fh, separators=(",", ":"))
    print(f"{len(entries)} tiles, {sum(e['buildings'] for e in entries.values())} buildings, "
          f"{sum(e['roads'] for e in entries.values())} roads, {total / 1e6:.1f} MB; {dict(col.stats)}")


if __name__ == "__main__":
    main()
