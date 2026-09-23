#!/usr/bin/env python3
"""Extract airports and runways inside the scenery area from FlightGear's
Airports/apt.dat.gz (X-Plane apt.dat 1000+ format) for the start menu.

Example:
    python3 tools/build_airports.py --fgdata FG_ROOT --scenery site/data/scenery
"""

import argparse
import gzip
import json
import math
import os


def bearing(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def distance_m(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(a))


SURFACES = {1: "asphalt", 2: "concrete", 3: "turf", 4: "dirt", 5: "gravel", 12: "lakebed", 13: "water",
            14: "snow", 15: "transparent"}


def parse(path, bounds):
    lat0, lon0, lat1, lon1 = bounds
    airports = []
    cur = None
    with gzip.open(path, "rt", encoding="latin-1") as fh:
        for line in fh:
            parts = line.split()
            if not parts:
                continue
            code = parts[0]
            if code in ("1", "16", "17"):
                if cur and cur["runways"]:
                    airports.append(cur)
                cur = None
                if code == "1" and len(parts) >= 6:
                    cur = {"icao": parts[4], "name": " ".join(parts[5:]), "elevationFt": float(parts[1]),
                           "runways": [], "tower": None, "parking": []}
            elif cur is None:
                continue
            elif code == "100" and len(parts) >= 26:
                width = float(parts[1])
                surface = SURFACES.get(int(parts[2]), "paved")
                e1 = parts[8:17]
                e2 = parts[17:26]
                la1, lo1, la2, lo2 = float(e1[1]), float(e1[2]), float(e2[1]), float(e2[2])
                length = distance_m(la1, lo1, la2, lo2)
                for a, b in ((e1, e2), (e2, e1)):
                    la, lo, lb, lob = float(a[1]), float(a[2]), float(b[1]), float(b[2])
                    cur["runways"].append({
                        "id": a[0], "lat": la, "lon": lo, "heading": round(bearing(la, lo, lb, lob), 2),
                        "displacedM": float(a[3]), "lengthM": round(length, 1), "widthM": width,
                        "surface": surface,
                    })
            elif code == "14" and len(parts) >= 3:
                cur["tower"] = {"lat": float(parts[1]), "lon": float(parts[2]),
                                "heightM": float(parts[3]) * 0.3048 if len(parts) > 3 else 20}
            elif code == "1300" and len(parts) >= 6:
                cur["parking"].append({"lat": float(parts[1]), "lon": float(parts[2]),
                                       "heading": float(parts[3]), "type": parts[4],
                                       "name": " ".join(parts[6:])})
    if cur and cur["runways"]:
        airports.append(cur)

    def inside(a):
        r = a["runways"][0]
        return lat0 <= r["lat"] <= lat1 and lon0 <= r["lon"] <= lon1

    return [a for a in airports if inside(a)]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fgdata", required=True)
    ap.add_argument("--scenery", required=True, help="scenery output dir with index.json")
    args = ap.parse_args()
    index = json.load(open(os.path.join(args.scenery, "index.json")))
    tiles = index["tiles"]
    bounds = (min(t["lat0"] for t in tiles), min(t["lon0"] for t in tiles),
              max(t["lat1"] for t in tiles), max(t["lon1"] for t in tiles))
    airports = parse(os.path.join(args.fgdata, "Airports", "apt.dat.gz"), bounds)
    # Keep parking positions for the larger fields only; they are long lists.
    for a in airports:
        a["parking"] = [p for p in a["parking"] if p["type"] in ("tie-down", "gate", "hangar", "misc")][:40]
    airports.sort(key=lambda a: -max(r["lengthM"] for r in a["runways"]))
    out = os.path.join(args.scenery, "airports.json")
    with open(out, "w") as fh:
        json.dump({"bounds": bounds, "airports": airports}, fh, separators=(",", ":"))
    print(f"wrote {out}: {len(airports)} airports")
    for a in airports[:15]:
        print(f"  {a['icao']:5} {a['name'][:40]:40} runways: {' '.join(r['id'] for r in a['runways'])}")


if __name__ == "__main__":
    main()
