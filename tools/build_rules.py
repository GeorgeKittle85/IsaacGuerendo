#!/usr/bin/env python3
"""Collect an aircraft's property rules, autopilots, systems and instrument
configuration (the XML FlightGear's C++ subsystems read) into one JSON file.

The aircraft's -set.xml lists them under /sim/systems/{property-rule,autopilot},
/sim/systems/path and /sim/instrumentation/path.

Example:
    python3 tools/build_rules.py --fgdata /path/to/fgdata --aircraft c172p \
        --out site/data/aircraft/c172p/rules.json
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from proplist import PropertyListReader, to_json  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fgdata", required=True)
    ap.add_argument("--aircraft", default="c172p")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    acdir = os.path.join(args.fgdata, "Aircraft", args.aircraft)
    reader = PropertyListReader(args.fgdata, search_dirs=[acdir])
    setxml = reader.read(os.path.join(acdir, f"{args.aircraft}-set.xml"))
    sim = setxml.get("/sim")

    def resolve(ref):
        for base in (acdir, args.fgdata):
            p = os.path.normpath(os.path.join(base, ref))
            if os.path.isfile(p):
                return p
        return None

    groups = []
    systems = sim.get("systems")
    for (name, _idx), node in systems.children.items():
        if name not in ("property-rule", "autopilot"):
            continue
        ref = node.get("path").value if node.get("path") else None
        path = resolve(ref) if ref else None
        if not path:
            print(f"warning: cannot find {name} {ref}", file=sys.stderr)
            continue
        tree = PropertyListReader(args.fgdata, search_dirs=[acdir]).read(path)
        groups.append({"kind": name, "path": os.path.relpath(path, args.fgdata), "config": to_json(tree)})

    def single(node):
        if node is None or node.value is None:
            return None
        p = resolve(node.value)
        if not p:
            print(f"warning: cannot find {node.value}", file=sys.stderr)
            return None
        return to_json(PropertyListReader(args.fgdata, search_dirs=[acdir]).read(p))

    out = {
        "groups": groups,
        "systems": single(systems.get("path")),
        "instrumentation": single(sim.get("instrumentation/path")),
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"wrote {args.out}: {len(groups)} rule groups "
          f"({', '.join(os.path.basename(g['path']) for g in groups)})")


if __name__ == "__main__":
    main()
