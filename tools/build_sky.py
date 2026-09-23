#!/usr/bin/env python3
"""Convert FlightGear's star catalogue (Astro/stars.gz, the Yale Bright Star
Catalogue with J2000 right ascension/declination in radians) into the
compact JSON the sky renderer loads.

Example:
    python3 tools/build_sky.py --fgdata FG_ROOT --out site/data/sky/stars.json
"""

import argparse
import gzip
import json
import os


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fgdata", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-magnitude", type=float, default=5.5)
    args = ap.parse_args()
    stars = []
    with gzip.open(os.path.join(args.fgdata, "Astro", "stars.gz"), "rt", encoding="latin-1") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split(",")
            if len(parts) < 4:
                continue
            ra, dec, mag = float(parts[1]), float(parts[2]), float(parts[3])
            if mag <= args.max_magnitude:
                stars.append([round(ra, 4), round(dec, 4), round(mag, 2)])
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump({"source": "FlightGear Astro/stars.gz (Yale Bright Star Catalogue)", "stars": stars}, fh,
                  separators=(",", ":"))
    print(f"wrote {args.out}: {len(stars)} stars")


if __name__ == "__main__":
    main()
