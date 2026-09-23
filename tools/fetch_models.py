#!/usr/bin/env python3
"""Fetch the TerraSync shared models used by the scenery tiles.

OBJECT_SHARED entries in the tiles' .stg files name models under TerraSync's
Models/ tree (fgdata only ships a few of them).  Rather than mirroring whole
directories, this downloads just the model files and everything they
reference (sub-models, AC3D meshes, textures), verifying each file against
its directory's .dirindex SHA-1 like FlightGear's TerraSync client.

Example:
    python3 tools/fetch_models.py --scenery site/data/scenery \
        --fgdata FG_ROOT --dest build/terrasync
"""

import argparse
import json
import os
import posixpath
import re
import sys
import threading
import concurrent.futures

sys.path.insert(0, os.path.dirname(__file__))
from fetch_terrasync import DEFAULT_SERVER, download_file, http_get, parse_dirindex  # noqa: E402

TEXTURE_EXTS = (".png", ".rgb", ".rgba", ".jpg", ".jpeg", ".dds", ".sgi")


class Fetcher:
    def __init__(self, server, dest, fgdata):
        self.server = server
        self.dest = dest
        self.fgdata = fgdata
        self.listings = {}
        self.lock = threading.Lock()
        self.done = set()
        self.missing = set()
        self.downloaded = 0
        self.file_locks = {}

    def listing(self, d):
        with self.lock:
            if d in self.listings:
                return self.listings[d]
        try:
            text = http_get(self.server + d + "/.dirindex", retries=4).decode("utf-8", "replace")
            entries = {name: sha for kind, name, sha, _ in parse_dirindex(text) if kind == "f"}
        except RuntimeError:
            entries = {}
        with self.lock:
            self.listings[d] = entries
        return entries

    def local(self, rel):
        for root in (self.dest, self.fgdata):
            p = os.path.join(root, rel)
            if os.path.isfile(p):
                return p
        return None

    def ensure(self, rel):
        """Makes `rel` (relative to the TerraSync root) available locally."""
        rel = posixpath.normpath(rel).lstrip("/")
        found = self.local(rel)
        entries = self.listing(posixpath.dirname(rel)) if not found else None
        if found:
            return rel
        name = posixpath.basename(rel)
        if name not in entries:
            # FlightGear falls back between texture formats.
            stem, ext = posixpath.splitext(name)
            if ext.lower() in TEXTURE_EXTS:
                for alt in TEXTURE_EXTS:
                    if stem + alt in entries:
                        name = stem + alt
                        rel = posixpath.join(posixpath.dirname(rel), name)
                        break
            if name not in entries:
                return None
        with self.lock:
            file_lock = self.file_locks.setdefault(rel, threading.Lock())
        with file_lock:  # models share textures: fetch each file once
            _, fetched = download_file(self.server, rel, self.dest, entries[name])
        with self.lock:
            self.downloaded += fetched
        return rel

    def resolve(self, ref, base_dir):
        """A reference from a file in base_dir: relative first, then from the root."""
        ref = ref.strip().replace("\\", "/")
        cands = [ref.lstrip("/")] if ref.startswith("/") else [posixpath.join(base_dir, ref), ref]
        for c in cands:
            c = posixpath.normpath(c)
            if self.local(c):
                return c
        for c in cands:
            got = self.ensure(c)
            if got:
                return got
        return None

    def model(self, rel):
        with self.lock:
            if rel in self.done:
                return
            self.done.add(rel)
        got = self.ensure(rel)
        if not got:
            self.missing.add(rel)
            return
        path = self.local(got)
        base = posixpath.dirname(got)
        text = open(path, "rb").read().decode("latin-1")
        if got.lower().endswith(".ac"):
            for tex in set(re.findall(r'^texture\s+"([^"]+)"', text, re.M)):
                if not self.resolve(tex, base):
                    self.missing.add(posixpath.join(base, tex))
            return
        if not got.lower().endswith(".xml"):
            return
        refs = re.findall(r"<path>\s*([^<]+?)\s*</path>", text)
        refs += re.findall(r'include="([^"]+)"', text)
        for ref in refs:
            sub = self.resolve(ref, base)
            if sub:
                self.model(sub)
            else:
                self.missing.add(posixpath.join(base, ref))
        for tex in re.findall(r"<texture>\s*([^<]+?)\s*</texture>", text):
            if "." in tex:
                self.resolve(tex, base)
        for eff in re.findall(r"<inherits-from>\s*([^<]+?)\s*</inherits-from>", text):
            self.resolve(eff + ".eff", base)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenery", required=True, help="scenery output dir with index.json")
    ap.add_argument("--fgdata", required=True)
    ap.add_argument("--dest", required=True, help="local TerraSync cache")
    ap.add_argument("--server", default=DEFAULT_SERVER)
    ap.add_argument("--jobs", type=int, default=8)
    args = ap.parse_args()
    server = args.server if args.server.endswith("/") else args.server + "/"
    index = json.load(open(os.path.join(args.scenery, "index.json")))
    shared = sorted({o["path"] for t in index["tiles"] for o in t["objects"] if o["kind"] == "shared"})
    f = Fetcher(server, args.dest, args.fgdata)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        list(pool.map(f.model, shared))
    print(f"{len(shared)} shared models, {len(f.done)} files walked, {f.downloaded} downloaded")
    for m in sorted(f.missing):
        print(f"  missing {m}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
