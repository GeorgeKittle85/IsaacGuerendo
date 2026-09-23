#!/usr/bin/env python3
"""Package a FlightGear 3D model (model XML tree + AC3D meshes + textures).

Starting at the aircraft's top-level model XML this follows every <model>
submodel (applying <overlay> blocks, as SimGear's model loader does), and
writes:

  <out>/model.json        every model XML as a JSON config tree, keyed by path,
                          with submodel references resolved; plus a texture
                          manifest (which textures have alpha)
  <out>/files/<path>.gz   the AC3D meshes, gzip'd
  <out>/files/<path>.webp the textures, converted for browsers

Paths are kept relative to FG_ROOT so the runtime can resolve them the way
FlightGear does.

Example:
    python3 tools/build_model.py --fgdata FG_ROOT --model Aircraft/c172p/Models/c172p.xml \
        --out site/data/aircraft/c172p/model --exclude 'Effects/(damage|pontoon|skis)'
"""

import argparse
import gzip
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from proplist import PropNode, PropertyListReader, to_json  # noqa: E402
from textures import convert_texture  # noqa: E402


def merge_overlay(dst, src):
    """SimGear copyProperties(overlay, model): overlay values win."""
    for key, child in src.children.items():
        target = dst.child(*key)
        if child.children:
            merge_overlay(target, child)
        else:
            target.value, target.type, target.alias = child.value, child.type, child.alias


class Builder:
    def __init__(self, fgdata, out, excludes, max_tex):
        self.fg = os.path.abspath(fgdata)
        self.out = out
        self.excludes = [re.compile(e) for e in excludes]
        self.max_tex = max_tex
        self.models = {}
        self.textures = {}
        self.acs = set()
        self.skipped = []

    def rel(self, path):
        return os.path.relpath(os.path.abspath(path), self.fg).replace(os.sep, "/")

    def resolve(self, ref, base_dir):
        ref = ref.strip()
        cands = [os.path.join(self.fg, ref.lstrip("/"))] if ref.startswith("/") else \
            [os.path.join(base_dir, ref), os.path.join(self.fg, ref)]
        for c in cands:
            if os.path.isfile(c):
                return os.path.normpath(c)
        return None

    def texture(self, abs_path):
        rel = self.rel(abs_path)
        if rel in self.textures:
            return rel
        src = abs_path
        if not os.path.isfile(src):
            stem = os.path.splitext(abs_path)[0]
            src = next((stem + e for e in (".png", ".rgb", ".rgba", ".dds", ".jpg", ".jpeg", ".sgi")
                        if os.path.isfile(stem + e)), None)
        if not src:
            self.textures[rel] = None
            return rel
        out_rel = os.path.splitext(rel)[0] + ".webp"
        dst = os.path.join(self.out, "files", out_rel)
        ok = convert_texture(src, dst, max_size=self.max_tex)
        alpha = False
        if ok:
            from PIL import Image
            with Image.open(dst) as im:
                alpha = im.mode in ("RGBA", "LA")
        self.textures[rel] = {"file": "files/" + out_rel, "alpha": alpha} if ok else None
        return rel

    def ac(self, abs_path):
        rel = self.rel(abs_path)
        if rel in self.acs:
            return rel
        self.acs.add(rel)
        text = open(abs_path, "rb").read()
        dst = os.path.join(self.out, "files", rel + ".gz")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with gzip.open(dst, "wb", compresslevel=9) as fh:
            fh.write(text)
        base = os.path.dirname(abs_path)
        for m in re.finditer(rb'^texture\s+"([^"]+)"', text, re.M):
            name = m.group(1).decode("latin-1")
            self.texture(os.path.join(base, name))
        return rel

    def excluded(self, rel):
        return any(e.search(rel) for e in self.excludes)

    def model(self, abs_path, overlay=None):
        rel = self.rel(abs_path)
        key = rel
        if overlay is not None:
            key += "#" + hashlib.sha1(json.dumps(to_json(overlay), sort_keys=True).encode()).hexdigest()[:10]
        if key in self.models:
            return key
        self.models[key] = None  # guard against cycles
        base = os.path.dirname(abs_path)
        if abs_path.endswith(".ac"):
            # A bare .ac referenced as a submodel.
            self.models[key] = {"dir": self.rel(base), "ac": self.ac(abs_path), "config": None}
            return key
        tree = PropertyListReader(self.fg, search_dirs=[base]).read(abs_path)
        if overlay is not None:
            merge_overlay(tree, overlay)
        entry = {"dir": self.rel(base), "ac": None, "config": None}
        p = tree.get("path")
        if p is not None and p.value:
            ac_path = self.resolve(p.value, base)
            if ac_path and ac_path.endswith(".ac"):
                entry["ac"] = self.ac(ac_path)
            elif ac_path and ac_path.endswith(".xml"):
                entry["base"] = self.model(ac_path)
        for (name, _i), child in list(tree.children.items()):
            if name != "model":
                continue
            sp = child.get("path")
            if sp is None or not sp.value:
                continue
            sub = self.resolve(sp.value, base)
            if not sub:
                self.skipped.append(f"missing {sp.value} (from {rel})")
                continue
            srel = self.rel(sub)
            if self.excluded(srel):
                self.skipped.append(f"excluded {srel}")
                child.child("resolved", 0).value = ""
                continue
            ov = child.get("overlay")
            child.child("resolved", 0).value = self.model(sub, ov)
        # Textures swapped in by material animations (liveries, lights).
        for (name, _i), anim in tree.children.items():
            if name != "animation":
                continue
            t = anim.get("texture")
            if t is not None and t.value and "." in t.value:
                tp = os.path.join(base, t.value.strip())
                if os.path.isfile(tp):
                    self.texture(tp)
        entry["config"] = to_json(tree)
        self.models[key] = entry
        return key


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fgdata", required=True)
    ap.add_argument("--model", required=True, help="model XML relative to FG_ROOT")
    ap.add_argument("--out", required=True)
    ap.add_argument("--exclude", action="append", default=[], help="regex of submodel paths to skip")
    ap.add_argument("--max-texture", type=int, default=2048)
    args = ap.parse_args()

    b = Builder(args.fgdata, args.out, args.exclude, args.max_texture)
    root = b.model(os.path.join(b.fg, args.model))
    out = {"root": root, "models": b.models, "textures": b.textures}
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "model.json"), "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    size = 0
    for dp, _dn, fn in os.walk(args.out):
        size += sum(os.path.getsize(os.path.join(dp, f)) for f in fn)
    print(f"{len(b.models)} model files, {len(b.acs)} meshes, "
          f"{sum(1 for t in b.textures.values() if t)} textures, {size / 1e6:.1f} MB total")
    for s in b.skipped:
        print("  " + s)


if __name__ == "__main__":
    main()
