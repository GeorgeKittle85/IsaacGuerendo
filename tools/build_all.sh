#!/usr/bin/env bash
# Rebuilds every converted data file in site/data from FlightGear sources.
#
# Usage: tools/build_all.sh FG_ROOT TERRASYNC_CACHE
#   FG_ROOT          extracted FlightGear 2024.1 data (FlightGear-2024.1.x-data.txz)
#   TERRASYNC_CACHE  directory for the TerraSync downloads (created if missing)
#
# The flight model itself is built separately: wasm/build.sh (needs Emscripten).
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 FG_ROOT TERRASYNC_CACHE" >&2
  exit 2
fi
FG="$1"
TS="$2"
cd "$(dirname "$0")/.."

# The two 1x1 degree scenery buckets around the San Francisco Bay.
BUCKETS=(w123n37 w122n37)
paths=()
for b in "${BUCKETS[@]}"; do
  paths+=("Terrain/w130n30/$b" "Objects/w130n30/$b")
done

python3 tools/fetch_terrasync.py --dest "$TS" "${paths[@]}"
python3 tools/build_fdm.py --fgdata "$FG" --aircraft c172p --out site/data/fdm/c172p.json
python3 tools/build_props.py --fgdata "$FG" --aircraft c172p --out site/data/aircraft/c172p/props.json
python3 tools/build_rules.py --fgdata "$FG" --aircraft c172p --out site/data/aircraft/c172p/rules.json
python3 tools/build_scenery.py --fgdata "$FG" --terrasync "$TS" \
  $(for b in "${BUCKETS[@]}"; do echo --bucket "$b"; done) --out site/data/scenery
python3 tools/build_airports.py --fgdata "$FG" --scenery site/data/scenery
python3 tools/fetch_models.py --scenery site/data/scenery --fgdata "$FG" --dest "$TS"
python3 tools/build_objects.py --fgdata "$FG" --terrasync "$TS" --scenery site/data/scenery \
  --out site/data/scenery/objects
python3 tools/build_model.py --fgdata "$FG" --model Aircraft/c172p/Models/c172p.xml \
  --out site/data/aircraft/c172p/model \
  --exclude 'Models/Effects/(damage|pontoon|skis|tyresmoke|tyrespray|propspray|damage-smoke|exhaust)' \
  --exclude 'Models/Effects/interior/.*fg1000' --exclude 'c172sp-panel' --exclude 'fg1000' \
  --exclude 'Immat/' --exclude 'Exterior/rbf' --exclude 'Baggages' --exclude 'mooringharness' \
  --exclude 'garmin196' --exclude 'Aircraft/Generic/marker'
python3 tools/build_sound.py --fgdata "$FG" --aircraft c172p --out site/data/aircraft/c172p/sound
python3 tools/build_sky.py --fgdata "$FG" --out site/data/sky/stars.json
echo "done: site/data rebuilt"
