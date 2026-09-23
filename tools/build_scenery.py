#!/usr/bin/env python3
"""Convert FlightGear World Scenery 2.0 terrain into compact web tiles.

For every tile in the requested 1x1 degree buckets this reads the tile's
.stg file, its base BTG and the airport BTGs it includes, resolves every
material with FlightGear's regional material library, and writes:

  site/data/scenery/tiles/<index>.bin.gz   geometry in a local east/north/up
                                           frame (see site/js/scene/tiles.js)
  site/data/scenery/index.json             tile list + material table
  site/data/scenery/textures/*.webp        the terrain/runway textures used

Land-cover materials get texture coordinates in the shader from world
position (FlightGear's xsize/ysize in metres), runway and marking materials
keep the BTG's own texture coordinates.

Example:
    python3 tools/build_scenery.py --fgdata FG_ROOT --terrasync CACHE \
        --bucket w123n37 --bucket w122n37 --out site/data/scenery
"""

import argparse
import gzip
import io
import json
import math
import os
import re
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from btg import SG_POINTS, read_btg  # noqa: E402
from fgmaterials import MaterialLib  # noqa: E402
from textures import convert_texture  # noqa: E402

WGS84_A = 6378137.0
WGS84_F = 1 / 298.257223563
WGS84_E2 = WGS84_F * (2 - WGS84_F)


def ecef_to_geodetic(x, y, z):
    b = WGS84_A * (1 - WGS84_F)
    ep2 = WGS84_E2 / (1 - WGS84_E2)
    p = math.hypot(x, y)
    th = math.atan2(z * WGS84_A, p * b)
    lat = math.atan2(z + ep2 * b * math.sin(th) ** 3, p - WGS84_E2 * WGS84_A * math.cos(th) ** 3)
    lon = math.atan2(y, x)
    n = WGS84_A / math.sqrt(1 - WGS84_E2 * math.sin(lat) ** 2)
    alt = p / math.cos(lat) - n
    return math.degrees(lat), math.degrees(lon), alt


def enu_matrix(lat_deg, lon_deg):
    la, lo = math.radians(lat_deg), math.radians(lon_deg)
    sla, cla, slo, clo = math.sin(la), math.cos(la), math.sin(lo), math.cos(lo)
    return np.array([
        [-slo, clo, 0.0],
        [-sla * clo, -sla * slo, cla],
        [cla * clo, cla * slo, sla],
    ])


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


def parse_stg(path):
    base, airports, objects = None, [], []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            parts = line.split()
            if not parts or parts[0].startswith("#"):
                continue
            kind = parts[0]
            if kind == "OBJECT_BASE":
                base = parts[1]
            elif kind == "OBJECT":
                airports.append(parts[1])
            elif kind in ("OBJECT_SHARED", "OBJECT_STATIC") and len(parts) >= 6:
                objects.append({
                    "kind": "shared" if kind == "OBJECT_SHARED" else "static",
                    "path": parts[1], "lon": float(parts[2]), "lat": float(parts[3]),
                    "elev": float(parts[4]), "hdg": float(parts[5]),
                    "pitch": float(parts[6]) if len(parts) > 6 else 0.0,
                    "roll": float(parts[7]) if len(parts) > 7 else 0.0,
                })
            elif kind == "OBJECT_SIGN" and len(parts) >= 7:
                objects.append({"kind": "sign", "text": parts[1], "lon": float(parts[2]),
                                "lat": float(parts[3]), "elev": float(parts[4]),
                                "hdg": float(parts[5]), "size": int(parts[6])})
    return base, airports, objects


def material_kind(name, desc):
    effect = desc["effect"]
    if name.startswith("RWY_") or name.endswith("_LIGHTS"):
        return "light"
    if "water" in effect:
        return "water"
    if effect.endswith("lfeat") or name.startswith("lf_"):
        return "marking"
    if effect.endswith("runway") or name.startswith(("pa_", "pc_", "aa_")) or desc["xsize"] <= 0:
        return "runway"
    return "terrain"


class MaterialTable:
    def __init__(self, lib, fgdata, tex_out):
        self.lib = lib
        self.fgdata = fgdata
        self.tex_out = tex_out
        self.entries = []
        self.index = {}
        self.textures = {}

    def texture(self, rel):
        if rel in self.textures:
            return self.textures[rel]
        src = os.path.join(self.fgdata, "Textures", rel)
        if not os.path.isfile(src):
            # FlightGear falls back to the .dds/.png sibling
            stem = os.path.splitext(src)[0]
            src = next((stem + e for e in (".png", ".dds", ".rgb", ".jpg") if os.path.isfile(stem + e)), None)
        out = None
        if src:
            name = re.sub(r"[^A-Za-z0-9_.-]", "_", os.path.splitext(rel)[0]) + ".webp"
            dst = os.path.join(self.tex_out, name)
            if convert_texture(src, dst, max_size=1024):
                out = "textures/" + name
        self.textures[rel] = out
        return out

    def get(self, name, lon, lat):
        mat = self.lib.find(name, lon, lat)
        if mat is None:
            desc = {"effect": "Effects/terrain-default", "textures": [], "xsize": 1000.0, "ysize": 1000.0,
                    "ambient": [0.2] * 3 + [1], "diffuse": [0.8] * 3 + [1], "specular": [0, 0, 0, 1],
                    "emissive": [0, 0, 0, 1], "shininess": 1.0, "solid": True, "frictionFactor": 1.0,
                    "rollingFriction": 0.02, "bumpiness": 0.0, "loadResistance": 1e30, "lightCoverage": 0}
        else:
            desc = mat.describe()
        key = (name, json.dumps(desc, sort_keys=True))
        if key in self.index:
            return self.index[key], desc
        kind = material_kind(name, desc)
        entry = {"name": name, "kind": kind, **{k: v for k, v in desc.items() if k != "textures"}}
        tex = desc["textures"][0] if desc["textures"] else None
        entry["texture"] = self.texture(tex) if tex and kind != "light" else None
        self.index[key] = len(self.entries)
        self.entries.append(entry)
        return self.index[key], desc


def pad4(buf):
    while len(buf) % 4:
        buf.append(0)


def morton_order(xy):
    """Sort order along a Z-curve, for vertex/index locality (better gzip)."""
    q = xy - xy.min(axis=0)
    q = (q / max(float(q.max()), 1e-9) * 65535).astype(np.uint64)
    def spread(v):
        v = (v | (v << 16)) & 0x0000FFFF0000FFFF
        v = (v | (v << 8)) & 0x00FF00FF00FF00FF
        v = (v | (v << 4)) & 0x0F0F0F0F0F0F0F0F
        v = (v | (v << 2)) & 0x3333333333333333
        v = (v | (v << 1)) & 0x5555555555555555
        return v
    code = spread(q[:, 0]) | (spread(q[:, 1]) << np.uint64(1))
    return np.argsort(code, kind="stable")


def group_corners(btg):
    """Per material: flat arrays of triangle corner indices (vertex, normal, texcoord)."""
    per = {}
    for g in btg.groups:
        if g.kind == SG_POINTS:
            d = per.setdefault(("pts", g.material), [[], []])
            d[0].extend(g.v)
            d[1].extend(g.n if g.n and len(g.n) == len(g.v) else g.v)
            continue
        n = len(g.v)
        if g.kind == 10:
            order = range(n - n % 3)
        elif g.kind == 11:
            order = [j for i in range(2, n) for j in ((i - 1, i - 2, i) if i % 2 else (i - 2, i - 1, i))]
        else:
            order = [j for i in range(2, n) for j in (0, i - 1, i)]
        d = per.setdefault(("tri", g.material), [[], [], []])
        vs, ns = g.v, (g.n if g.n and len(g.n) == len(g.v) else g.v)
        tcs = g.tc if g.tc and len(g.tc) == len(g.v) else ([g.tc[0]] * n if g.tc else [-1] * n)
        for j in order:
            d[0].append(vs[j]); d[1].append(ns[j]); d[2].append(tcs[j])
    return per


def build_tile(stg_path, bucket_dir, mats, out_dir):
    index = int(os.path.basename(stg_path).split(".")[0])
    base_name, airport_names, objects = parse_stg(stg_path)
    if not base_name:
        return None
    lat0, lon0, lat1, lon1 = bucket_bounds(index)
    gz = lambda n: n if n.endswith(".gz") else n + ".gz"
    base = read_btg(os.path.join(bucket_dir, gz(base_name)))
    clat, clon, calt = ecef_to_geodetic(*base.center)
    R = enu_matrix(clat, clon)
    center = np.array(base.center)
    mlon, mlat = (lon0 + lon1) / 2, (lat0 + lat1) / 2

    terrain_pos, terrain_tris = [], {}   # shared pool (ENU float64), material -> list of index arrays
    surface = {}                         # material -> [positions, normals, uvs]
    lights = {}
    pool_offset = 0
    for src_name in [base_name] + airport_names:
        path = os.path.join(bucket_dir, gz(src_name))
        btg = base if src_name == base_name else (read_btg(path) if os.path.isfile(path) else None)
        if btg is None or not btg.vertices:
            continue
        verts = (np.asarray(btg.vertices, dtype=np.float64) + np.asarray(btg.center) - center) @ R.T
        norms = (np.asarray(btg.normals, dtype=np.float64) @ R.T) if btg.normals else np.zeros_like(verts)
        tcs = np.asarray(btg.texcoords, dtype=np.float64) if btg.texcoords else np.zeros((1, 2))
        used_terrain = False
        for (kind, name), corners in group_corners(btg).items():
            mi, desc = mats.get(name, mlon, mlat)
            if kind == "pts":
                v = np.asarray(corners[0]); n = np.asarray(corners[1])
                lp = lights.setdefault(mi, ([], []))
                lp[0].append(verts[v]); lp[1].append(norms[np.minimum(n, len(norms) - 1)])
                continue
            v = np.asarray(corners[0]); n = np.asarray(corners[1]); t = np.asarray(corners[2])
            mk = mats.entries[mi]["kind"]
            if mk in ("runway", "marking"):
                xs, ys = desc["xsize"], desc["ysize"]
                scale = np.array([1000.0 / xs if xs > 0 else 1.0, 1000.0 / ys if ys > 0 else 1.0])
                uv = tcs[np.clip(t, 0, len(tcs) - 1)] * scale
                uv[t < 0] = 0
                sp = surface.setdefault(mi, [[], [], []])
                sp[0].append(verts[v]); sp[1].append(norms[np.minimum(n, len(norms) - 1)]); sp[2].append(uv)
            else:
                terrain_tris.setdefault(mi, []).append(v + pool_offset)
                used_terrain = True
        if used_terrain:
            terrain_pos.append(verts)
            pool_offset += len(verts)

    buf = bytearray()
    buf += b"FGT2"
    buf += struct.pack("<I", 2)
    buf += struct.pack("<ddd", *base.center)
    buf += struct.pack("<dd", clat, clon)
    tri_count = 0
    zmin, zmax = 1e9, -1e9

    # --- land-cover mesh: shared, quantised vertex pool; normals computed on load
    if terrain_tris:
        P = np.concatenate(terrain_pos)
        used = np.zeros(len(P), dtype=bool)
        for arrs in terrain_tris.values():
            for a in arrs:
                used[a] = True
        remap = np.full(len(P), -1, dtype=np.int64)
        used_idx = np.nonzero(used)[0]
        order = morton_order(P[used_idx][:, :2])
        used_idx = used_idx[order]
        remap[used_idx] = np.arange(len(used_idx))
        Pu = P[used_idx]
        lo, hi = Pu.min(axis=0), Pu.max(axis=0)
        span = np.maximum(hi - lo, 1e-3)
        Q = np.round((Pu - lo) / span * 65535).astype(np.uint16)
        zmin, zmax = float(lo[2]), float(hi[2])
        groups, idx_all = [], []
        start = 0
        for mi, arrs in sorted(terrain_tris.items()):
            tri = remap[np.concatenate(arrs)].reshape(-1, 3)
            tri = tri[np.argsort(tri.min(axis=1), kind="stable")]
            flat = tri.reshape(-1)
            groups.append((mi, start, len(flat)))
            idx_all.append(flat)
            start += len(flat)
            tri_count += len(tri)
        idx = np.concatenate(idx_all)
        wide = len(Pu) > 65535
        buf += struct.pack("<IIII", len(Pu), len(idx), len(groups), 1 if wide else 0)
        buf += struct.pack("<dddddd", *lo, *span)
        for g in groups:
            buf += struct.pack("<III", *g)
        buf += Q.tobytes()
        pad4(buf)
        buf += idx.astype(np.uint32 if wide else np.uint16).tobytes()
        pad4(buf)
    else:
        buf += struct.pack("<IIII", 0, 0, 0, 0)
        buf += struct.pack("<dddddd", 0, 0, 0, 1, 1, 1)

    # --- airport surfaces: float positions, BTG normals and texture coords
    groups, pos_all, nrm_all, uv_all, idx_all = [], [], [], [], []
    vcount = start = 0
    for mi, (ps, ns, uvs) in sorted(surface.items()):
        P = np.concatenate(ps); N = np.concatenate(ns); U = np.concatenate(uvs)
        key = np.concatenate([np.round(P * 1000), np.round(N * 100), np.round(U * 10000)], axis=1).astype(np.int64)
        _u, first, inverse = np.unique(key, axis=0, return_index=True, return_inverse=True)
        inverse = inverse.reshape(-1)
        pos_all.append(P[first]); nrm_all.append(N[first]); uv_all.append(U[first])
        idx_all.append(inverse + vcount)
        groups.append((mi, start, len(inverse)))
        start += len(inverse)
        vcount += len(first)
        tri_count += len(inverse) // 3
        zmin, zmax = min(zmin, float(P[:, 2].min())), max(zmax, float(P[:, 2].max()))
    wide = vcount > 65535
    buf += struct.pack("<IIII", vcount, start, len(groups), 1 if wide else 0)
    for g in groups:
        buf += struct.pack("<III", *g)
    if vcount:
        buf += np.concatenate(pos_all).astype(np.float32).tobytes()
        n4 = np.zeros((vcount, 4), dtype=np.int8)
        n4[:, :3] = np.clip(np.round(np.concatenate(nrm_all) * 127), -127, 127)
        buf += n4.tobytes()
        buf += np.concatenate(uv_all).astype(np.float32).tobytes()
        buf += np.concatenate(idx_all).astype(np.uint32 if wide else np.uint16).tobytes()
        pad4(buf)

    # --- light points (runway/taxiway lights) with their facing normals
    buf += struct.pack("<I", len(lights))
    for mi, (ps, ns) in sorted(lights.items()):
        P = np.concatenate(ps).astype(np.float32)
        n4 = np.zeros((len(P), 4), dtype=np.int8)
        n4[:, :3] = np.clip(np.round(np.concatenate(ns) * 127), -127, 127)
        buf += struct.pack("<II", mi, len(P))
        buf += P.tobytes()
        buf += n4.tobytes()

    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"{index}.bin.gz")
    with gzip.open(out, "wb", compresslevel=9) as fh:
        fh.write(bytes(buf))
    return {
        "id": index, "file": f"tiles/{index}.bin.gz", "lat0": lat0, "lon0": lon0, "lat1": lat1, "lon1": lon1,
        "center": [clat, clon, calt], "minZ": zmin, "maxZ": zmax,
        "triangles": tri_count, "bytes": os.path.getsize(out), "objects": objects,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fgdata", required=True)
    ap.add_argument("--terrasync", required=True)
    ap.add_argument("--bucket", action="append", required=True, help="e.g. w123n37")
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", type=int, action="append", help="build only these tile indices")
    args = ap.parse_args()

    lib = MaterialLib(args.fgdata)
    mats = MaterialTable(lib, args.fgdata, os.path.join(args.out, "textures"))
    tiles = []
    for b in args.bucket:
        m = re.match(r"([ew])(\d+)([ns])(\d+)", b)
        lon10 = int(m.group(2)) * (-1 if m.group(1) == "w" else 1)
        lat10 = int(m.group(4)) * (-1 if m.group(3) == "s" else 1)
        top = f"{'w' if lon10 < 0 else 'e'}{abs(math.floor(lon10 / 10) * 10):03d}{'s' if lat10 < 0 else 'n'}{abs(math.floor(lat10 / 10) * 10):02d}"
        bdir = os.path.join(args.terrasync, "Terrain", top, b)
        for stg in sorted(os.listdir(bdir)):
            if not stg.endswith(".stg"):
                continue
            if args.only and int(stg.split(".")[0]) not in args.only:
                continue
            t = build_tile(os.path.join(bdir, stg), bdir, mats, os.path.join(args.out, "tiles"))
            if t:
                objs = os.path.join(args.terrasync, "Objects", top, b, stg)
                if os.path.isfile(objs):
                    t["objects"] += parse_stg(objs)[2]
                t["objectsDir"] = f"Objects/{top}/{b}"
                tiles.append(t)
                print(f"tile {t['id']}: {t['triangles']} triangles, {t['bytes'] / 1e6:.2f} MB, "
                      f"{len(t['objects'])} objects", flush=True)

    index = {"version": 1, "tiles": tiles, "materials": mats.entries}
    with open(os.path.join(args.out, "index.json"), "w") as fh:
        json.dump(index, fh, separators=(",", ":"))
    total = sum(t["bytes"] for t in tiles)
    print(f"{len(tiles)} tiles, {total / 1e6:.1f} MB, {len(mats.entries)} materials, "
          f"{sum(1 for v in mats.textures.values() if v)} textures")


if __name__ == "__main__":
    main()
