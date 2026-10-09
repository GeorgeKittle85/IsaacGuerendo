#!/usr/bin/env python3
"""Aerial imagery for the scenery tiles, from the USGS National Map.

For every land tile of site/data/scenery/index.json this asks the USGS NAIP
image service (the National Agriculture Imagery Program's 0.6 m natural
colour orthoimagery, public domain) for one image in plain latitude and
longitude, and writes it as WebP:

  site/data/scenery/imagery/<tile>.webp      every land tile, ~10 m a pixel
  site/data/scenery/imagery/hi/<tile>.webp   the busiest tiles, ~5 m a pixel
  site/data/scenery/imagery/index.json       each image's bounds and size

The site drapes the image over the tile's land cover (site/js/scene/
materials.js).  An image covers its tile, or more where the tile's terrain
reaches past its bounds (an airport's grass belongs to the tile of the
airport's reference point).  Where NAIP has no pixels (offshore) the image is
transparent and FlightGear's own textures show through.

The hi-resolution images are for the tiles with the region's main airports,
plus the tiles with the most buildings (tools/build_osm.py's index), up to
--hi-count; --hi adds tiles by id.

The service returns at most 4000 pixels a side, so larger images are put
together from several requests.  Downloads are kept in --cache.

Example:
    python3 tools/build_imagery.py --scenery site/data/scenery --cache build/imagery
"""

import argparse
import concurrent.futures
import gzip
import io
import json
import math
import os
import struct
import sys
import time
import urllib.parse
import urllib.request

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from build_scenery import ecef_to_geodetic, enu_matrix  # noqa: E402

Image.MAX_IMAGE_PIXELS = None

SERVICE = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage"
MAX_REQUEST = 4000
KM_PER_DEG = 111.195

# The regions' airline and busiest general aviation airports: their tiles
# get the sharper imagery.
HI_AIRPORTS = ["KSFO", "KOAK", "KSJC", "KHWD", "KPAO", "KSQL", "KNUQ", "KLVK", "KCCR",
               "KPDX", "KHIO", "KTTD", "KUAO", "KVUO", "KSLE", "KEUG", "KMFR", "KRDM",
               "KBDN", "KLMT", "KOTH", "KPDT", "KAST", "KCVO", "KONP"]


def terrain_extent(path):
    """(lat0, lon0, lat1, lon1) of a tile's land-cover vertices (build_scenery.py's FGT2 format)."""
    with gzip.open(path, "rb") as fh:
        buf = fh.read()
    if buf[:4] != b"FGT2":
        raise ValueError(f"{path}: not an FGT2 tile")
    o = 8
    center = np.array(struct.unpack_from("<ddd", buf, o)); o += 24
    clat, clon = struct.unpack_from("<dd", buf, o); o += 16
    tv, _ti, tg, _wide = struct.unpack_from("<IIII", buf, o); o += 16
    lo = np.array(struct.unpack_from("<ddd", buf, o)); o += 24
    span = np.array(struct.unpack_from("<ddd", buf, o)); o += 24
    o += tg * 12
    if not tv:
        return None
    q = np.frombuffer(buf, dtype="<u2", count=tv * 3, offset=o).reshape(-1, 3).astype(np.float64)
    enu = lo + q / 65535.0 * span
    # Only the outline matters: the extreme points in each direction.
    pick = np.unique(np.concatenate([np.argsort(enu[:, k])[s] for k in (0, 1) for s in (slice(0, 64), slice(-64, None))]))
    ecef = center + enu[pick] @ enu_matrix(clat, clon)
    ll = np.array([ecef_to_geodetic(*p)[:2] for p in ecef])
    return float(ll[:, 0].min()), float(ll[:, 1].min()), float(ll[:, 0].max()), float(ll[:, 1].max())


def image_bounds(info, extent):
    """The tile's bounds, grown to its terrain's extent (rounded out to 1/4000 degree)."""
    lat0, lon0, lat1, lon1 = info["lat0"], info["lon0"], info["lat1"], info["lon1"]
    if extent:
        # Vertices on the tile's edges come back a few millimetres out.
        q, tol = 1 / 4000, 1e-5
        if extent[0] < lat0 - tol:
            lat0 = math.floor(extent[0] / q) * q
        if extent[1] < lon0 - tol:
            lon0 = math.floor(extent[1] / q) * q
        if extent[2] > lat1 + tol:
            lat1 = math.ceil(extent[2] / q) * q
        if extent[3] > lon1 + tol:
            lon1 = math.ceil(extent[3] / q) * q
    return [round(lat0, 6), round(lon0, 6), round(lat1, 6), round(lon1, 6)]


def image_size(bounds, ref_width, ref_lon_span=0.25):
    """Pixels for the bounds at the resolution of ref_width pixels over a standard tile's width."""
    lat0, lon0, lat1, lon1 = bounds
    w = max(16, round(ref_width * (lon1 - lon0) / ref_lon_span))
    kx = math.cos(math.radians((lat0 + lat1) / 2))
    h = max(16, round(w * (lat1 - lat0) / ((lon1 - lon0) * kx)))
    return w, h


def fetch(bounds, size, retries=6):
    """One exportImage request: RGBA, transparent where there is no imagery."""
    lat0, lon0, lat1, lon1 = bounds
    q = {
        "bbox": f"{lon0},{lat0},{lon1},{lat1}", "bboxSR": 4326, "imageSR": 4326,
        "size": f"{size[0]},{size[1]}", "format": "png32", "noData": 0,
        "renderingRule": json.dumps({"rasterFunction": "NaturalColor"}),
        "interpolation": "RSP_BilinearInterpolation", "f": "image",
    }
    url = SERVICE + "?" + urllib.parse.urlencode(q)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=300) as res:
                data = res.read()
            img = Image.open(io.BytesIO(data))
            img.load()
            if img.size != tuple(size):
                raise ValueError(f"got {img.size}, asked for {size}")
            return img.convert("RGBA")
        except Exception as exc:  # network hiccups and the service's busy replies
            if attempt == retries - 1:
                raise
            wait = 5 * 2 ** attempt
            print(f"  retry in {wait}s: {exc}", flush=True)
            time.sleep(wait)


def fetch_stitched(bounds, size):
    """The image for bounds at size, from requests of at most MAX_REQUEST pixels a side."""
    w, h = size
    nx, ny = math.ceil(w / MAX_REQUEST), math.ceil(h / MAX_REQUEST)
    if nx == 1 and ny == 1:
        return fetch(bounds, size)
    lat0, lon0, lat1, lon1 = bounds
    out = Image.new("RGBA", size)
    xs = [round(i * w / nx) for i in range(nx + 1)]
    ys = [round(j * h / ny) for j in range(ny + 1)]
    for j in range(ny):
        for i in range(nx):
            # Pixel edges -> degrees; rows go south from the top.
            b = [lat1 - (lat1 - lat0) * ys[j + 1] / h, lon0 + (lon1 - lon0) * xs[i] / w,
                 lat1 - (lat1 - lat0) * ys[j] / h, lon0 + (lon1 - lon0) * xs[i + 1] / w]
            out.paste(fetch(b, (xs[i + 1] - xs[i], ys[j + 1] - ys[j])), (xs[i], ys[j]))
    return out


def encode(img, dst, quality):
    """WebP; the alpha channel only when some pixels have no imagery.  False if none has any."""
    alpha = np.asarray(img.getchannel("A"))
    if not alpha.any():
        return False
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if alpha.min() < 255:
        # Keep edges crisp: a pixel either has imagery or not.
        a = np.where(alpha >= 128, 255, 0).astype(np.uint8)
        rgba = np.dstack([np.asarray(img.convert("RGB")), a])
        Image.fromarray(rgba, "RGBA").save(dst, "WEBP", quality=quality, method=6, alpha_quality=50)
    else:
        img.convert("RGB").save(dst, "WEBP", quality=quality, method=6)
    return True


def tile_job(info, scenery, cache, out, ref_width, quality, sub):
    tid = info["id"]
    dst = os.path.join(out, sub, f"{tid}.webp") if sub else os.path.join(out, f"{tid}.webp")
    extent = terrain_extent(os.path.join(scenery, info["file"]))
    bounds = image_bounds(info, extent)
    size = image_size(bounds, ref_width)
    raw = os.path.join(cache, str(ref_width), f"{tid}.png")
    if os.path.isfile(raw):
        img = Image.open(raw).convert("RGBA")
        if img.size != size:
            img = None
    else:
        img = None
    if img is None:
        img = fetch_stitched(bounds, size)
        os.makedirs(os.path.dirname(raw), exist_ok=True)
        img.save(raw + ".part", "PNG", compress_level=1)
        os.replace(raw + ".part", raw)
    has = encode(img, dst, quality)
    return tid, {"bounds": bounds, "size": list(size)} if has else None


def hi_tiles(scenery, tiles, extra, count):
    """The tiles with the main airports' runways, then the most built-up ones."""
    airports = json.load(open(os.path.join(scenery, "airports.json")))["airports"]
    by_icao = {a["icao"]: a for a in airports}
    land = {t["id"]: t for t in tiles if "ocean" not in t}
    picked = []

    def add(tid):
        if tid in land and tid not in picked:
            picked.append(tid)

    for icao in HI_AIRPORTS:
        a = by_icao.get(icao)
        if not a:
            continue
        # The tile carrying the airport's BTG, and the tiles under its runway ends.
        for t in land.values():
            if icao in t.get("airports", []):
                add(t["id"])
        for r in a["runways"]:
            for t in land.values():
                if t["lat0"] <= r["lat"] <= t["lat1"] and t["lon0"] <= r["lon"] <= t["lon1"]:
                    add(t["id"])
    for tid in extra:
        add(tid)
    osm_index = os.path.join(scenery, "osm", "index.json")
    if os.path.isfile(osm_index):
        osm = json.load(open(osm_index))["tiles"]
        busy = sorted(osm.items(), key=lambda kv: -kv[1].get("buildings", 0))
        for tid, _ in busy:
            if len(picked) >= count:
                break
            add(int(tid))
    return picked[:max(count, len(picked))]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenery", default="site/data/scenery")
    ap.add_argument("--cache", default="build/imagery")
    ap.add_argument("--width", type=int, default=2048, help="pixels across a standard 0.25 degree tile")
    ap.add_argument("--hi-width", type=int, default=4096)
    ap.add_argument("--hi-count", type=int, default=40, help="tiles that get the sharper images")
    ap.add_argument("--hi", type=int, action="append", default=[], help="a tile to give the sharper image")
    ap.add_argument("--quality", type=int, default=45)
    ap.add_argument("--hi-quality", type=int, default=45)
    ap.add_argument("--jobs", type=int, default=6)
    ap.add_argument("--only", type=int, action="append", help="only these tile ids")
    ap.add_argument("--skip-hi", action="store_true", help="only the base images")
    ap.add_argument("--hi-only", action="store_true", help="only the sharper images (the base ones are there)")
    args = ap.parse_args()

    out = os.path.join(args.scenery, "imagery")
    index_path = os.path.join(out, "index.json")
    tiles = json.load(open(os.path.join(args.scenery, "index.json")))["tiles"]
    land = [t for t in tiles if "ocean" not in t and (not args.only or t["id"] in args.only)]
    prev = json.load(open(index_path)) if os.path.isfile(index_path) else {}
    entries = {int(k): v for k, v in prev.get("tiles", {}).items()}

    work = [] if args.hi_only else [(t, args.width, args.quality, "") for t in land]
    hi = [] if args.skip_hi else hi_tiles(args.scenery, tiles, args.hi, args.hi_count)
    by_id = {t["id"]: t for t in land}
    work += [(by_id[h], args.hi_width, args.hi_quality, "hi") for h in hi if h in by_id]

    done = 0
    t0 = time.time()
    with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
        futs = {pool.submit(tile_job, t, args.scenery, args.cache, out, w, q, sub): (t["id"], sub)
                for t, w, q, sub in work}
        for fut in concurrent.futures.as_completed(futs):
            tid, sub = futs[fut]
            done += 1
            try:
                _tid, entry = fut.result()
            except Exception as exc:
                print(f"tile {tid}{' hi' if sub else ''}: FAILED {exc}", flush=True)
                continue
            if sub:
                if entry and tid in entries:
                    entries[tid]["hi"] = entry
            elif entry:
                keep_hi = entries.get(tid, {}).get("hi")
                entries[tid] = {**entry, **({"hi": keep_hi} if keep_hi else {})}
            else:
                entries.pop(tid, None)
            if done % 20 == 0 or done == len(work):
                rate = done / max(1e-6, time.time() - t0)
                print(f"{done}/{len(work)} images, {rate * 60:.0f}/min", flush=True)
    # Hi entries for tiles no longer picked go away with their files.
    for tid, e in entries.items():
        if "hi" in e and tid not in hi and not args.only and not args.skip_hi:
            e.pop("hi")
            p = os.path.join(out, "hi", f"{tid}.webp")
            if os.path.isfile(p):
                os.remove(p)
    index = {
        "version": 1,
        "source": "USGS The National Map: USGSNAIPImagery (USDA NAIP orthoimagery), public domain",
        "tiles": {str(k): entries[k] for k in sorted(entries)},
    }
    with open(index_path, "w") as fh:
        json.dump(index, fh, separators=(",", ":"))
    size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(out) for f in fs)
    print(f"{len(entries)} images ({sum(1 for e in entries.values() if 'hi' in e)} sharper), {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
