#!/usr/bin/env bash
# Rebuilds the Boeing 747-400's data in site/data from FlightGear's 747-400
# (the Aircraft-2024 package on the FlightGear download mirrors) and the few
# shared FlightGear data files it uses:
#   - defaults.xml, for the initial properties
#   - Aircraft/Generic/generic-systems.xml, the default pitot and static systems
#   - Effects/, for the model's effects
#   - Models/Airport/Pushback/, the Goldhofer pushback tug the 747 tows with
#   - Sounds/click.wav
# and, from the same FGData checkout, the F-16's pushback tug (FlightGear's
# military tug, Models/Airport/Pushback/Military.xml).
#
# Usage: tools/build_747.sh [ZIP] [WORK_DIR]
#   ZIP       747-400.zip (default: downloaded from the FlightGear mirror)
#   WORK_DIR  where the sources are unpacked (default: build/b744)
#
# Needs git, curl, unzip, and Python 3 with Pillow and NumPy.
set -euo pipefail

cd "$(dirname "$0")/.."
ZIP="${1:-}"
WORK="${2:-build/b744}"
URL="https://mirrors.ibiblio.org/flightgear/ftp/Aircraft-2024/747-400.zip"
FGDATA="https://gitlab.com/flightgear/fgdata.git"
FGDATA_BRANCH="release/2024.1"
mkdir -p "$WORK"

if [ -z "$ZIP" ]; then
  ZIP="$WORK/747-400.zip"
  [ -f "$ZIP" ] || curl -fsSL -o "$ZIP" "$URL"
fi

# Only the shared files the 747 uses, not the whole of FGData.
FG="$WORK/fgdata"
if [ ! -d "$FG/.git" ]; then
  git clone --depth 1 --branch "$FGDATA_BRANCH" --filter=blob:none --sparse "$FGDATA" "$FG"
  git -C "$FG" sparse-checkout set --no-cone /defaults.xml /Aircraft/Generic/generic-systems.xml /Effects/ \
    /Models/Airport/Pushback/ /Sounds/click.wav
fi
rm -rf "$FG/Aircraft/747-400"
mkdir -p "$FG/Aircraft"
unzip -q -o "$ZIP" -d "$FG/Aircraft/"

OUT=site/data/aircraft/747-400
python3 tools/build_fdm.py --fgdata "$FG" --aircraft 747-400 --out site/data/fdm/747-400.json
python3 tools/build_props.py --fgdata "$FG" --aircraft 747-400 --out "$OUT/props.json"
python3 tools/build_rules.py --fgdata "$FG" --aircraft 747-400 --out "$OUT/rules.json"
# Particle effects (contrails, fuel dump, fire, tyre smoke) and the canvas
# CDU are left out: the web renderer draws neither.
rm -rf "$OUT/model"
python3 tools/build_model.py --fgdata "$FG" --model Aircraft/747-400/Models/747-400.xml --out "$OUT/model" \
  --exclude 'Models/Effects/(contrail|fuel_jettison|fire|tyre-smoke)' --exclude 'Instruments-3d/cdu'
rm -rf "$OUT/sound"
python3 tools/build_sound.py --fgdata "$FG" --aircraft 747-400 --sound-file Sounds/747-sound.xml --out "$OUT/sound"
rm -rf site/data/models/pushback-military
python3 tools/build_model.py --fgdata "$FG" --model Models/Airport/Pushback/Military.xml \
  --out site/data/models/pushback-military
echo "done: 747-400 and pushback tug data rebuilt"
