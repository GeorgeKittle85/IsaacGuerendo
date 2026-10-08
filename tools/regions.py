#!/usr/bin/env python3
"""The scenery regions the site covers (tools/regions.json).

A region is either a list of whole 1x1 degree buckets (the San Francisco Bay
Area) or a boundary polygon (Oregon): then it has every scenery tile within
`marginKm` of the boundary, so the world does not end right at the state
line, and its airports are those within `airportMarginKm`.

The build scripts use this to pick the TerraSync buckets to download, the
tiles to convert and each airport's region; the start menu groups the
airports by region.

Examples:
    python3 tools/regions.py                    # summary of every region
    python3 tools/regions.py --paths oregon     # TerraSync paths to fetch
"""

import argparse
import json
import math
import os

REGIONS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "regions.json")
KM_PER_DEG = 111.195


def bucket_span(lat):
    """SGBucket longitude span in degrees for a latitude (newbucket.cxx)."""
    a = abs(lat)
    if a >= 89: return 12.0
    if a >= 86: return 4.0
    if a >= 83: return 2.0
    if a >= 76: return 1.0
    if a >= 62: return 0.5
    if a >= 22: return 0.25
    return 0.125


def bucket_bounds(index):
    """Decodes an SGBucket index into (lat0, lon0, lat1, lon1)."""
    lon = (index >> 14) - 180
    lat = ((index >> 6) & 0xFF) - 90
    y = (index >> 3) & 0x7
    x = index & 0x7
    span = bucket_span(lat + 0.0625 + y / 8.0)
    lat0 = lat + y / 8.0
    lon0 = lon + x * span
    return lat0, lon0, lat0 + 0.125, lon0 + span


def tile_index(lon, lat, x, y):
    """SGBucket::gen_index for the tile x, y of the 1x1 degree bucket at (lon, lat)."""
    return ((lon + 180) << 14) + ((lat + 90) << 6) + (y << 3) + x


def bucket_name(lon, lat):
    """1x1 degree bucket directory name, e.g. w123n45."""
    return f"{'w' if lon < 0 else 'e'}{abs(lon):03d}{'s' if lat < 0 else 'n'}{abs(lat):02d}"


def parse_bucket(name):
    """'w123n45' -> (-123, 45): the bucket's south-west corner."""
    lon = int(name[1:4]) * (-1 if name[0] == "w" else 1)
    lat = int(name[5:7]) * (-1 if name[4] == "s" else 1)
    return lon, lat


def top_dir(lon, lat):
    """TerraSync's 10x10 degree directory of a bucket, e.g. w130n40."""
    return bucket_name(math.floor(lon / 10) * 10, math.floor(lat / 10) * 10)


def bucket_tiles(lon, lat):
    """Every tile index of a 1x1 degree bucket."""
    out = []
    for y in range(8):
        cols = int(round(1.0 / bucket_span(lat + (y + 0.5) / 8.0)))
        out += [tile_index(lon, lat, x, y) for x in range(cols)]
    return out


def _seg_point(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def _cross(ax, ay, bx, by, cx, cy):
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)


def _seg_seg(a, b, c, d):
    """Distance between segments ab and cd (0 when they cross)."""
    d1, d2 = _cross(*c, *d, *a), _cross(*c, *d, *b)
    d3, d4 = _cross(*a, *b, *c), _cross(*a, *b, *d)
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)):
        return 0.0
    return min(_seg_point(*a, *c, *d), _seg_point(*b, *c, *d), _seg_point(*c, *a, *b), _seg_point(*d, *a, *b))


class Region:
    def __init__(self, spec):
        self.id = spec["id"]
        self.name = spec["name"]
        self.default = spec.get("default")
        self.buckets_spec = spec.get("buckets")
        self.margin_km = spec.get("marginKm", 0)
        self.airport_margin_km = spec.get("airportMarginKm", 0)
        self.boundary = spec.get("boundary")
        if self.boundary:
            lats = [p[1] for p in self.boundary]
            # Flat km around the region's middle latitude: plenty for margins of a few km.
            self.kx = KM_PER_DEG * math.cos(math.radians((min(lats) + max(lats)) / 2))
            self.poly = [(lon * self.kx, lat * KM_PER_DEG) for lon, lat in self.boundary]

    def _xy(self, lon, lat):
        return lon * self.kx, lat * KM_PER_DEG

    def _inside(self, x, y):
        inside = False
        p = self.poly
        for i in range(len(p)):
            (x1, y1), (x2, y2) = p[i - 1], p[i]
            if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
                inside = not inside
        return inside

    def distance_km(self, lat, lon):
        """Distance from a point to the region's boundary polygon (0 inside)."""
        x, y = self._xy(lon, lat)
        if self._inside(x, y):
            return 0.0
        p = self.poly
        return min(_seg_point(x, y, *p[i - 1], *p[i]) for i in range(len(p)))

    def _rect_distance_km(self, lat0, lon0, lat1, lon1):
        corners = [self._xy(lon0, lat0), self._xy(lon1, lat0), self._xy(lon1, lat1), self._xy(lon0, lat1)]
        if any(self._inside(*c) for c in corners):
            return 0.0
        (rx0, ry0), (rx1, ry1) = corners[0], corners[2]
        if any(rx0 <= x <= rx1 and ry0 <= y <= ry1 for x, y in self.poly):
            return 0.0
        p = self.poly
        return min(_seg_seg(corners[k - 1], corners[k], p[i - 1], p[i]) for k in range(4) for i in range(len(p)))

    def buckets(self):
        """(lon, lat) of the 1x1 degree buckets the region needs."""
        return sorted({(math.floor(bucket_bounds(t)[1]), math.floor(bucket_bounds(t)[0])) for t in self.tiles()})

    def tiles(self):
        """Indices of the scenery tiles in the region."""
        if not hasattr(self, "_tiles"):
            self._tiles = self._find_tiles()
        return self._tiles

    def _find_tiles(self):
        if self.buckets_spec:
            return sorted(t for b in self.buckets_spec for t in bucket_tiles(*parse_bucket(b)))
        lons = [p[0] for p in self.boundary]
        lats = [p[1] for p in self.boundary]
        pad = self.margin_km / KM_PER_DEG
        padx = self.margin_km / self.kx
        out = []
        for lat in range(math.floor(min(lats) - pad), math.floor(max(lats) + pad) + 1):
            for lon in range(math.floor(min(lons) - padx), math.floor(max(lons) + padx) + 1):
                for t in bucket_tiles(lon, lat):
                    if self._rect_distance_km(*bucket_bounds(t)) <= self.margin_km:
                        out.append(t)
        return sorted(out)

    def has_airport(self, lat, lon, tiles):
        """Whether an airport at (lat, lon) belongs to the region (tiles: its built tile infos)."""
        if self.boundary:
            return self.distance_km(lat, lon) <= self.airport_margin_km
        return any(t["lat0"] <= lat <= t["lat1"] and t["lon0"] <= lon <= t["lon1"] for t in tiles)

    def terrasync_paths(self):
        return [f"{kind}/{top_dir(lon, lat)}/{bucket_name(lon, lat)}"
                for lon, lat in self.buckets() for kind in ("Terrain", "Objects")]


def load(path=REGIONS_FILE):
    with open(path) as fh:
        return [Region(r) for r in json.load(fh)["regions"]]


def by_id(ids, path=REGIONS_FILE):
    regions = load(path)
    if not ids:
        return regions
    known = {r.id: r for r in regions}
    missing = [i for i in ids if i not in known]
    if missing:
        raise SystemExit(f"unknown region(s) {', '.join(missing)}; known: {', '.join(known)}")
    return [known[i] for i in ids]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("region", nargs="*", help="region ids (default: all)")
    ap.add_argument("--paths", action="store_true", help="print the TerraSync paths to download")
    args = ap.parse_args()
    regions = by_id(args.region)
    if args.paths:
        for r in regions:
            print("\n".join(r.terrasync_paths()))
        return
    for r in regions:
        print(f"{r.id}: {r.name}, {len(r.tiles())} tiles in {len(r.buckets())} buckets")


if __name__ == "__main__":
    main()
