#!/usr/bin/env bash
# Builds JSBSim (FlightGear's flight dynamics engine) to WebAssembly.
#
# Requirements: Emscripten SDK activated (emcc/emcmake on PATH), cmake, ninja, git.
# Output:       site/wasm/jsbsim.mjs + site/wasm/jsbsim.wasm
#
# Usage: wasm/build.sh [build-dir]

set -euo pipefail

JSBSIM_TAG="v1.3.1"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BUILD="${1:-$ROOT/build/wasm}"
OUT="$ROOT/site/wasm"

command -v emcc >/dev/null || { echo "emcc not found: activate the Emscripten SDK first" >&2; exit 1; }

mkdir -p "$BUILD" "$OUT"

if [ ! -d "$BUILD/jsbsim/.git" ]; then
  git clone --depth 1 --branch "$JSBSIM_TAG" https://github.com/JSBSim-Team/jsbsim.git "$BUILD/jsbsim"
fi

# Apply our Emscripten portability patch once.
if git -C "$BUILD/jsbsim" apply --check "$HERE/patches/jsbsim-emscripten.patch" 2>/dev/null; then
  git -C "$BUILD/jsbsim" apply "$HERE/patches/jsbsim-emscripten.patch"
fi

# Native WebAssembly exceptions: JSBSim reports load/trim errors by throwing.
CXXFLAGS_COMMON="-O3 -fwasm-exceptions"

emcmake cmake -S "$BUILD/jsbsim" -B "$BUILD/jsbsim-build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS="$CXXFLAGS_COMMON" \
  -DCMAKE_C_FLAGS="-O3" \
  -DBUILD_DOCS=OFF \
  -DBUILD_PYTHON_MODULE=OFF \
  -DBUILD_SHARED_LIBS=OFF
cmake --build "$BUILD/jsbsim-build" --target libJSBSim

em++ $CXXFLAGS_COMMON -std=c++17 \
  -I"$BUILD/jsbsim/src" \
  -DJSBSIM_VERSION="\"${JSBSIM_TAG#v}\"" \
  "$HERE/jsbsim_bridge.cpp" \
  -Dcalc_magvar=fgweb_calc_magvar -Dyymmdd_to_julian_days=fgweb_yymmdd_to_julian_days \
  "$HERE/third_party/simgear-magvar/coremag.cxx" \
  "$BUILD/jsbsim-build/src/libJSBSim.a" \
  -o "$OUT/jsbsim.mjs" \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createJSBSim \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=33554432 \
  -sSTACK_SIZE=1048576 \
  -sFORCE_FILESYSTEM=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,cwrap,ccall,HEAPF64,HEAP32,UTF8ToString,stringToUTF8,lengthBytesUTF8 \
  -sEXPORTED_FUNCTIONS=_malloc,_free

ls -l "$OUT"/jsbsim.*
