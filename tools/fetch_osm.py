#!/usr/bin/env python3
"""Download OpenStreetMap data for a bounding box as API v0.6 map.json tiles.

The public Overpass servers are often saturated, so this uses the main OSM API,
which caps each request at 50,000 nodes. The bbox is split into a grid and each
tile is saved separately; build_campus.py merges them by element id.

Tiles that already exist in OUT_DIR are kept, so an interrupted run can be
resumed. Use a separate OUT_DIR for each bounding box.

Usage: fetch_osm.py OUT_DIR [south west north east] [grid]
  U of T (default):  fetch_osm.py osm_uoft
  Waterloo:          fetch_osm.py osm_waterloo 43.4640 -80.5580 43.4790 -80.5325 3
  McMaster:          fetch_osm.py osm_mcmaster 43.2560 -79.9290 43.2712 -79.9085 3
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

DEFAULT_BBOX = (43.6535, -79.4045, 43.6705, -79.3835)  # U of T St. George
USER_AGENT = "campus-access-map-prototype/1.0"
WORKERS = 4  # the API throttles each download to about a minute, so fetch a few tiles at once


def fetch_tile(bbox, path, attempts=4):
    west, south, east, north = bbox
    url = f"https://api.openstreetmap.org/api/0.6/map.json?bbox={west:.6f},{south:.6f},{east:.6f},{north:.6f}"
    last_error = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=150) as response:
                body = response.read()
            json.loads(body)  # fail here, not in the build, if the server sent an error page
            with open(path + ".part", "wb") as out:
                out.write(body)
            os.replace(path + ".part", path)  # a half-written tile must never look complete
            return len(body)
        except (urllib.error.URLError, TimeoutError, ValueError) as error:
            last_error = error
            time.sleep(2 + attempt * 2)
    raise RuntimeError(f"OSM tile {url} failed after {attempts} attempts: {last_error}")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    out_dir = sys.argv[1]
    south, west, north, east = (float(v) for v in sys.argv[2:6]) if len(sys.argv) >= 6 else DEFAULT_BBOX
    grid = int(sys.argv[6]) if len(sys.argv) >= 7 else 4
    os.makedirs(out_dir, exist_ok=True)
    jobs = []
    for i in range(grid):
        for j in range(grid):
            tile = (
                west + (east - west) * i / grid,
                south + (north - south) * j / grid,
                west + (east - west) * (i + 1) / grid,
                south + (north - south) * (j + 1) / grid,
            )
            jobs.append((f"{i},{j}", tile, os.path.join(out_dir, f"tile_{i}_{j}.json")))

    def fetch(job):
        label, tile, path = job
        if os.path.exists(path):
            return f"tile {label}: kept existing file"
        return f"tile {label}: {fetch_tile(tile, path)} bytes"

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for line in pool.map(fetch, jobs):
            print(line, flush=True)


if __name__ == "__main__":
    main()
