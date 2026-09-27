#!/usr/bin/env bash
# Rebuilds the F-16's data in site/data from its sources:
#   - the flight model: JSBSim's own F-16 (aircraft/f16 in the JSBSim sources)
#   - the sounds: recordings from FlightGear's F-16 (FGAddon), set up by
#     tools/f16/f16-sound.xml
#   - the 3D model: a Blender file, converted to glTF
#
# Usage: tools/build_f16.sh BLEND_FILE [WORK_DIR]
#   BLEND_FILE  F-16_EXP_animated.blend (texture images, if any, next to it)
#   WORK_DIR    where the sources are downloaded (default: build/f16)
#
# Needs git, curl, Python 3 with NumPy, and Blender 4.x: either a `blender`
# binary (or BLENDER=/path/to/blender), or BLENDER_PYTHON=/path/to/python for
# a Python 3.11 with `pip install bpy==4.2.*`.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 BLEND_FILE [WORK_DIR]" >&2
  exit 2
fi
BLEND="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
cd "$(dirname "$0")/.."
WORK="${2:-build/f16}"
JSBSIM_TAG="v1.3.1"
FGADDON="https://svn.code.sf.net/p/flightgear/fgaddon/trunk"
mkdir -p "$WORK"

# Flight model.
if [ ! -d "$WORK/jsbsim/.git" ]; then
  git clone --depth 1 --branch "$JSBSIM_TAG" --filter=blob:none --sparse \
    https://github.com/JSBSim-Team/jsbsim.git "$WORK/jsbsim"
  git -C "$WORK/jsbsim" sparse-checkout set aircraft/f16 engine systems
fi
python3 tools/build_fdm.py --jsbsim "$WORK/jsbsim" --aircraft f16 --out site/data/fdm/f16.json

# Sounds: only the recordings the sound configuration uses.
for f in $(grep -o '<path>[^<]*</path>' tools/f16/f16-sound.xml | sed 's|</\?path>||g' | sort -u); do
  dst="$WORK/fgaddon/Aircraft/f16/$f"
  if [ ! -f "$dst" ]; then
    mkdir -p "$(dirname "$dst")"
    curl -fsSL -o "$dst" "$FGADDON/Aircraft/f16/$f"
  fi
done
python3 tools/build_sound.py --fgdata "$WORK/fgaddon" --aircraft f16 \
  --sound-file "$(pwd)/tools/f16/f16-sound.xml" --out site/data/aircraft/f16/sound

# 3D model.
if [ -n "${BLENDER_PYTHON:-}" ]; then
  "$BLENDER_PYTHON" tools/build_gltf_model.py --blend "$BLEND" --out site/data/aircraft/f16/model/f16.glb
else
  "${BLENDER:-blender}" -b --python tools/build_gltf_model.py -- \
    --blend "$BLEND" --out site/data/aircraft/f16/model/f16.glb
fi
echo "done: F-16 data rebuilt"
