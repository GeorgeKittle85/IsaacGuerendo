#!/usr/bin/env python3
"""Package a FlightGear JSBSim aircraft's flight-model files for the browser.

Collects the aircraft's JSBSim XML plus every engine, thruster and system
file it references (searching the aircraft's own Engines/ and Systems/
directories first, then FlightGear's shared Aircraft/Generic/JSBSim/Systems,
just like FlightGear does), and writes them into one JSON bundle that the
web app unpacks into JSBSim's virtual filesystem.

Example:
    python3 tools/build_fdm.py --fgdata /path/to/fgdata --aircraft c172p \
        --out site/data/fdm/c172p.json
"""

import argparse
import json
import os
import re
import sys
import xml.etree.ElementTree as ET


def strip_comments(text):
    return re.sub(r"<!--.*?-->", "", text, flags=re.S)


def find_file(name, search_dirs):
    for d in search_dirs:
        for candidate in (name, name + ".xml"):
            p = os.path.join(d, candidate)
            if os.path.isfile(p):
                return p
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fgdata", required=True, help="FlightGear data (FG_ROOT) directory")
    ap.add_argument("--aircraft", default="c172p")
    ap.add_argument("--fdm", help="JSBSim model name (default: same as --aircraft)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    model = args.fdm or args.aircraft
    acdir = os.path.join(args.fgdata, "Aircraft", args.aircraft)
    generic_systems = os.path.join(args.fgdata, "Aircraft", "Generic", "JSBSim", "Systems")
    main_xml = os.path.join(acdir, model + ".xml")
    if not os.path.isfile(main_xml):
        sys.exit(f"missing {main_xml}")

    files = {}  # virtual path -> text

    def add(vpath, path):
        with open(path, encoding="utf-8", errors="replace") as fh:
            files[vpath] = fh.read()

    add(f"aircraft/{args.aircraft}/{model}.xml", main_xml)

    queue = [main_xml]
    seen = {os.path.abspath(main_xml)}
    missing = []
    while queue:
        path = queue.pop()
        text = strip_comments(open(path, encoding="utf-8", errors="replace").read())
        try:
            root = ET.fromstring(text.encode("utf-8"))
        except ET.ParseError as exc:
            sys.exit(f"cannot parse {path}: {exc}")
        for el in root.iter():
            ref = el.get("file")
            if not ref:
                continue
            if el.tag in ("engine", "thruster"):
                dirs = [os.path.join(acdir, "Engines"), os.path.join(args.fgdata, "Aircraft", "Generic", "JSBSim", "Engines")]
                vdirs = [f"aircraft/{args.aircraft}/Engines", "engine"]
            elif el.tag in ("system", "include") or el.tag.startswith("channel"):
                dirs = [os.path.join(acdir, "Systems"), generic_systems, os.path.dirname(path)]
                vdirs = [f"aircraft/{args.aircraft}/Systems", "systems", None]
            else:
                continue
            found = None
            for d, vd in zip(dirs, vdirs):
                p = find_file(ref, [d])
                if p:
                    found = (p, vd)
                    break
            if not found:
                missing.append(f"{el.tag} file={ref} (from {os.path.relpath(path, args.fgdata)})")
                continue
            p, vd = found
            ap_ = os.path.abspath(p)
            if ap_ in seen:
                continue
            seen.add(ap_)
            if vd is None:
                vd = os.path.dirname(next(k for k in files if k.endswith(os.path.basename(path))))
            add(f"{vd}/{os.path.basename(p)}", p)
            queue.append(p)

    for m in missing:
        print("warning: not found:", m, file=sys.stderr)

    # Gear metadata FlightGear derives from the FDM (steering-norm etc.).
    gear = []
    fdm_root = ET.fromstring(strip_comments(files[f"aircraft/{args.aircraft}/{model}.xml"]).encode("utf-8"))
    for contact in fdm_root.iter("contact"):
        ms = contact.find("max_steer")
        max_steer = float(ms.text) if ms is not None and ms.text else 0.0
        if ms is not None and ms.get("unit", "DEG").upper() == "RAD":
            max_steer *= 57.29577951308232
        gear.append({"name": contact.get("name", ""), "type": contact.get("type", "BOGEY"),
                     "maxSteerDeg": max_steer})

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump({"aircraft": args.aircraft, "model": model, "gear": gear, "files": files}, fh,
                  separators=(",", ":"))
    total = sum(len(v) for v in files.values())
    print(f"wrote {args.out}: {len(files)} files, {total / 1024:.0f} KiB")
    for k in sorted(files):
        print("  ", k)


if __name__ == "__main__":
    main()
