#!/usr/bin/env python3
"""Mirror a small part of FlightGear's TerraSync scenery into a local cache.

TerraSync publishes a `.dirindex` file in every directory listing the files
(with SHA-1 and size) and sub-directories.  This script walks those indexes
for the requested paths and downloads anything missing or changed, the same
way FlightGear's built-in TerraSync client does.

Example:
    python3 tools/fetch_terrasync.py --dest build/terrasync \
        Terrain/w130n30/w123n37 Objects/w130n30/w123n37
"""

import argparse
import concurrent.futures
import hashlib
import os
import sys
import threading
import time
import urllib.request

DEFAULT_SERVER = "https://terrasync.b-cdn.net/"
USER_AGENT = "fgweb-terrasync-mirror/1.0"


def http_get(url, retries=6):
    delay = 2
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read()
        except Exception as exc:  # network hiccups: back off and retry
            if attempt == retries:
                raise RuntimeError(f"GET {url} failed: {exc}") from exc
            time.sleep(delay)
            delay *= 2


def parse_dirindex(text):
    entries = []
    for line in text.splitlines():
        parts = line.strip().split(":")
        if len(parts) < 3 or parts[0] not in ("d", "f", "t"):
            continue
        kind, name, sha = parts[0], parts[1], parts[2]
        size = int(parts[3]) if len(parts) > 3 and parts[3].isdigit() else None
        entries.append((kind, name, sha, size))
    return entries


def sha1_of(path):
    h = hashlib.sha1()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download_file(server, rel_path, dest_root, sha):
    out = os.path.join(dest_root, rel_path)
    if os.path.exists(out) and sha1_of(out) == sha:
        return rel_path, False
    os.makedirs(os.path.dirname(out), exist_ok=True)
    data = http_get(server + rel_path)
    got = hashlib.sha1(data).hexdigest()
    if got != sha:
        raise RuntimeError(f"SHA-1 mismatch for {rel_path}: {got} != {sha}")
    tmp = f"{out}.{os.getpid()}.{threading.get_ident()}.part"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, out)
    return rel_path, True


def collect(server, path, recursive, files):
    index = http_get(server + path + "/.dirindex").decode("utf-8", "replace")
    for kind, name, sha, _size in parse_dirindex(index):
        child = f"{path}/{name}"
        if kind == "f":
            files.append((child, sha))
        elif kind == "d" and recursive:
            collect(server, child, recursive, files)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", help="TerraSync paths, e.g. Terrain/w130n30/w123n37")
    ap.add_argument("--dest", required=True, help="local cache directory")
    ap.add_argument("--server", default=DEFAULT_SERVER)
    ap.add_argument("--no-recursive", action="store_true")
    ap.add_argument("--jobs", type=int, default=8)
    args = ap.parse_args()

    server = args.server if args.server.endswith("/") else args.server + "/"
    files = []
    for p in args.paths:
        collect(server, p.strip("/"), not args.no_recursive, files)

    fetched = 0
    failed = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = {pool.submit(download_file, server, rel, args.dest, sha): rel for rel, sha in files}
        for fut in concurrent.futures.as_completed(futures):
            try:
                _rel, was_fetched = fut.result()
                fetched += was_fetched
            except Exception as exc:  # keep going; report at the end
                failed.append((futures[fut], exc))
    print(f"{len(files)} files checked, {fetched} downloaded into {args.dest}")
    for rel, exc in failed:
        print(f"FAILED {rel}: {exc}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
