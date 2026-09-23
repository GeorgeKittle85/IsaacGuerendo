#!/usr/bin/env python3
"""Package an aircraft's FlightGear sound configuration for the browser.

Reads the aircraft's sound XML (/sim/sound/path, e.g. c172-sound.xml),
writes it as a JSON config tree (the same format as the other bundles), and
copies the WAV files it uses, resampled to 22.05 kHz mono 16-bit to keep the
download small.  Sounds for effects the web version does not simulate
(weather, floats, damage) can be left out with --exclude.

Example:
    python3 tools/build_sound.py --fgdata FG_ROOT --aircraft c172p \
        --out site/data/aircraft/c172p/sound
"""

import argparse
import json
import os
import re
import sys
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from proplist import PropertyListReader, to_json  # noqa: E402

DEFAULT_EXCLUDE = [r"thunder", r"rain", r"water", r"damage", r"repair", r"preheater", r"scratch",
                   r"checklist", r"gravel", r"crash"]


def resample_wav(src, dst, rate=22050):
    with wave.open(src) as w:
        ch, width, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    dtype = {1: np.uint8, 2: np.int16, 4: np.int32}[width]
    a = np.frombuffer(raw, dtype=dtype).astype(np.float64)
    if width == 1:
        a = (a - 128) * 256
    elif width == 4:
        a = a / 65536
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    if sr != rate and len(a) > 1:
        t = np.arange(0, len(a) - 1, sr / rate)
        a = np.interp(t, np.arange(len(a)), a)
    out = np.clip(np.round(a), -32768, 32767).astype("<i2")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with wave.open(dst, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(out.tobytes())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fgdata", required=True)
    ap.add_argument("--aircraft", default="c172p")
    ap.add_argument("--sound-file", default="c172-sound.xml", help="relative to the aircraft directory")
    ap.add_argument("--out", required=True)
    ap.add_argument("--exclude", action="append", help="regex of sound files to leave out")
    args = ap.parse_args()
    excludes = [re.compile(e) for e in (args.exclude or DEFAULT_EXCLUDE)]

    acdir = os.path.join(args.fgdata, "Aircraft", args.aircraft)
    tree = PropertyListReader(args.fgdata, search_dirs=[acdir]).read(os.path.join(acdir, args.sound_file))
    files = {}
    fx = tree.get("fx")
    kept = dropped = 0
    for (name, i), snd in list(fx.children.items()) if fx is not None else []:
        path = snd.get("path")
        if path is None or not path.value:
            continue
        rel = path.value.strip()
        if any(e.search(rel) for e in excludes):
            del fx.children[(name, i)]
            dropped += 1
            continue
        src = next((p for p in (os.path.join(acdir, rel), os.path.join(args.fgdata, rel)) if os.path.isfile(p)), None)
        if not src:
            del fx.children[(name, i)]
            dropped += 1
            continue
        if rel not in files:
            out_name = re.sub(r"[^A-Za-z0-9_.-]", "_", rel)
            resample_wav(src, os.path.join(args.out, out_name))
            files[rel] = out_name
        kept += 1
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "sound.json"), "w") as fh:
        json.dump({"config": to_json(tree), "files": files}, fh, separators=(",", ":"))
    size = sum(os.path.getsize(os.path.join(args.out, f)) for f in os.listdir(args.out))
    print(f"{kept} sounds kept, {dropped} left out, {len(files)} files, {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
