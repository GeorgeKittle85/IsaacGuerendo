#!/usr/bin/env python3
"""Package the scenery objects placed by the tiles' .stg files.

OBJECT_STATIC models (landmarks such as the Golden Gate Bridge, the SFO
terminals and downtown San Francisco) come from TerraSync's Objects/ tree,
OBJECT_SHARED models (hangars, windsocks, masts, trees, ...) from its Models/
tree or fgdata (see fetch_models.py).  Each model is packaged the same way
as the aircraft (tools/build_model.py): model XML trees as JSON, AC3D meshes
gzip'd and textures as WebP, plus a table from the tiles' object references
to model keys.  Signs (OBJECT_SIGN) are not converted.

Example:
    python3 tools/build_objects.py --fgdata FG_ROOT --terrasync build/terrasync \
        --scenery site/data/scenery --out site/data/scenery/objects
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from build_model import Builder  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fgdata", required=True)
    ap.add_argument("--terrasync", required=True)
    ap.add_argument("--scenery", required=True, help="scenery output dir with index.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-texture", type=int, default=1024)
    ap.add_argument("--exclude", action="append", default=[], help="regex of model paths to skip")
    args = ap.parse_args()

    index = json.load(open(os.path.join(args.scenery, "index.json")))
    b = Builder(args.fgdata, args.out, args.exclude, args.max_texture, roots=[args.terrasync, args.fgdata])
    refs = {}
    missing = set()
    for tile in index["tiles"]:
        for o in tile["objects"]:
            if o["kind"] == "sign":
                continue
            ref = object_ref(tile, o)
            if ref in refs or ref in missing:
                continue
            if o["kind"] == "static":
                path = os.path.join(args.terrasync, tile["objectsDir"], o["path"])
            else:
                path = next((os.path.join(r, o["path"]) for r in (args.terrasync, args.fgdata)
                             if os.path.isfile(os.path.join(r, o["path"]))), None)
            if not path or not os.path.isfile(path) or b.excluded(b.rel(path)):
                missing.add(ref)
                continue
            refs[ref] = b.model(path)

    out = {"models": b.models, "textures": b.textures, "effects": b.effects, "refs": refs}
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "model.json"), "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _dn, fn in os.walk(args.out) for f in fn)
    print(f"{len(refs)} object models ({len(b.models)} model files, {len(b.acs)} meshes, "
          f"{sum(1 for t in b.textures.values() if t)} textures), {size / 1e6:.1f} MB")
    for m in sorted(missing):
        print(f"  not packaged: {m}")
    for s in b.skipped:
        print(f"  {s}")


def object_ref(tile, o):
    """The key the runtime uses to find an object's model (see scene/objects.js)."""
    if o["kind"] == "static":
        return f"static:{tile['objectsDir']}/{o['path']}"
    return f"shared:{o['path']}"


if __name__ == "__main__":
    main()
