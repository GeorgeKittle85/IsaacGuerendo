#!/usr/bin/env python3
"""Flatten an aircraft's -set.xml into the initial property values for the web.

FlightGear loads <aircraft>-set.xml (plus everything it includes) into the
global property tree before the flight model starts; JSBSim systems and the
3D model animations read those values.  This writes them as a JSON list of
[path, value] pairs plus [path, target] aliases.

Example:
    python3 tools/build_props.py --fgdata /path/to/fgdata --aircraft c172p \
        --out site/data/aircraft/c172p/props.json
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from proplist import PropertyListReader, PropNode, typed_value  # noqa: E402

# Top-level branches of FlightGear's defaults.xml the web build uses.
DEFAULT_BRANCHES = ("controls", "environment", "instrumentation", "systems",
                    "position", "velocities", "orientation", "accelerations",
                    "autopilot", "engines", "consumables", "gear")

# Subtrees that only matter to FlightGear's GUI, input, Nasal or multiplayer.
SKIP_PREFIXES = (
    "/sim/help", "/sim/checklists", "/sim/tutorials", "/sim/menubar", "/sim/gui",
    "/sim/flight-recorder", "/sim/multiplay", "/sim/previews", "/sim/remote",
    "/sim/state", "/sim/aircraft-data", "/sim/walker", "/sim/weight", "/sim/sound",
    "/sim/systems", "/sim/instrumentation", "/sim/hud", "/sim/rendering",
    "/input", "/nasal", "/payload", "/limits/mass-and-balance",
    "/sim/model/walker", "/sim/model/crew/walker", "/systems/mooring",
    "/environment/config", "/environment/params", "/environment/clouds",
    "/environment/metar", "/environment/local-weather", "/environment/aircraft-effects/frost",
    "/autopilot/route-manager", "/autopilot/settings/", "/environment/weather-scenarios", "/environment/cloudlayers",
)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fgdata", required=True)
    ap.add_argument("--aircraft", default="c172p")
    ap.add_argument("--set-file", help="default: <aircraft>-set.xml")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    acdir = os.path.join(args.fgdata, "Aircraft", args.aircraft)
    set_file = os.path.join(acdir, args.set_file or f"{args.aircraft}-set.xml")
    reader = PropertyListReader(args.fgdata, search_dirs=[acdir])
    # FlightGear loads defaults.xml first, then the aircraft on top of it.
    defaults = reader.read(os.path.join(args.fgdata, "defaults.xml"))
    root = PropNode()
    for key, node in defaults.children.items():
        if key[0] in DEFAULT_BRANCHES:
            root.children[key] = node
    reader.read(set_file, node=root)
    for m in reader.missing:
        print("warning: unresolved include", m, file=sys.stderr)

    values, aliases = [], []
    for path, node in root.walk():
        if path.startswith(SKIP_PREFIXES):
            continue
        if node.alias:
            aliases.append([path, node.alias])
            continue
        if node.children:
            continue
        v = typed_value(node)
        if v is None or v == "":
            continue
        values.append([path, v])

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump({"values": values, "aliases": aliases}, fh, separators=(",", ":"))
    print(f"wrote {args.out}: {len(values)} values, {len(aliases)} aliases")


if __name__ == "__main__":
    main()
