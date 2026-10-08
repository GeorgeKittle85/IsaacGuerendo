#!/usr/bin/env bash
# Rebuilds the Boeing 737 MAX 8's data in site/data from the 737-family
# project (https://github.com/naviat-dev/737-family, GPL-2.0):
#   - its dev branch: the JSBSim flight model (737-8.xml), engines, systems,
#     property rules and sound recordings;
#   - its fde branch: the 3D model and textures (Models/737-8.ac), which the
#     dev branch no longer carries;
# plus tools/b737/: the web version's model wrapper (737-8-web.xml: the
# model placed on the flight model's gear, the pushback tug, lights and
# spoilers) and sound configuration (b737-sound.xml), and the shared
# FlightGear data files it uses (FGData, as for the 747).
#
# Usage: tools/build_737.sh [WORK_DIR]
#   WORK_DIR  where the sources are unpacked (default: build/b737)
#
# Needs git, and Python 3 with Pillow and NumPy.
set -euo pipefail

cd "$(dirname "$0")/.."
WORK="${1:-build/b737}"
REPO="https://github.com/naviat-dev/737-family"
DEV=2d6ebdc77456896bfffb22f0c02fd0e2cc27cf0d # dev, 2026-04-26
FDE=8c2614073878c63eced268d80c4db7647a17a3d8 # fde, 2025-03-03
FGDATA="https://gitlab.com/flightgear/fgdata.git"
FGDATA_BRANCH="release/2024.1"
mkdir -p "$WORK"

# One commit of the 737-family repository, without the files it does not
# need: the Blender sources (src/, 70 MB) and the unused 95 MB cockpit.
fetch() {
  local sha=$1 dir=$2
  shift 2
  if [ ! -d "$dir/.git" ]; then
    git init -q "$dir"
    git -C "$dir" config extensions.partialClone origin
    git -C "$dir" remote add origin "$REPO"
  fi
  git -C "$dir" sparse-checkout set --no-cone "$@"
  git -C "$dir" fetch -q --depth 1 --filter=blob:none origin "$sha"
  git -C "$dir" checkout -q "$sha"
}
fetch "$DEV" "$WORK/dev" '/*' '!/src/'
fetch "$FDE" "$WORK/fde" '/Models/' '!/Models/Cockpit/cockpit.ac' '!/Models/Liveries-*/'

FG="$WORK/fgdata"
if [ ! -d "$FG/.git" ]; then
  git clone --depth 1 --branch "$FGDATA_BRANCH" --filter=blob:none --sparse "$FGDATA" "$FG"
  git -C "$FG" sparse-checkout set --no-cone /defaults.xml /Aircraft/Generic/ /Effects/ \
    /Models/Airport/Pushback/ /Sounds/click.wav
fi

# The aircraft: the dev branch, with the fde branch's 3D model files.
AC="$FG/Aircraft/737-family"
rm -rf "$AC"
mkdir -p "$AC"
git -C "$WORK/dev" archive "$DEV" | tar -x -C "$AC" --exclude='src'
(cd "$WORK/fde" && git ls-files Models) | while read -r f; do
  [ -e "$WORK/fde/$f" ] && [ ! -e "$AC/$f" ] && mkdir -p "$AC/$(dirname "$f")" && cp "$WORK/fde/$f" "$AC/$f"
done
# Its light effects say Models/lights/ for Models/Lights/.
ln -sfn Lights "$AC/Models/lights"
cp tools/b737/737-8-web.xml "$AC/Models/"

OUT=site/data/aircraft/737-8
python3 tools/build_fdm.py --fgdata "$FG" --aircraft 737-family --fdm 737-8 --out site/data/fdm/737-8.json
python3 tools/build_props.py --fgdata "$FG" --aircraft 737-family --set-file 737-8-set.xml --out "$OUT/props.json"
python3 tools/build_rules.py --fgdata "$FG" --aircraft 737-family --set-file 737-8-set.xml --out "$OUT/rules.json"
rm -rf "$OUT/model"
python3 tools/build_model.py --fgdata "$FG" --model Aircraft/737-family/Models/737-8-web.xml --out "$OUT/model" \
  --aircraft-dir Aircraft/737-family --exclude 'Cockpit/'
rm -rf "$OUT/sound"
python3 tools/build_sound.py --fgdata "$FG" --aircraft 737-family \
  --sound-file "$(pwd)/tools/b737/b737-sound.xml" --out "$OUT/sound"
echo "done: 737 MAX 8 data rebuilt"
