#!/usr/bin/env python3
"""Build a small outdoor route graph from OpenStreetMap XML map extracts.

Fetch at most one map extract per campus in a refresh. Or pass --source-dir for
local files named waterloo.osm and mcmaster.osm from the same API bounds.
"""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

OSM_MAP = "https://api.openstreetmap.org/api/0.6/map"
# OpenStreetMap API order: west, south, east, north.
CAMPUS_BOUNDS = {
    "waterloo": (-80.5525, 43.4635, -80.5345, 43.4810),
    "mcmaster": (-79.9330, 43.2525, -79.9110, 43.2705),
}
PEDESTRIAN_WAYS = {
    "footway", "pedestrian", "steps", "path", "living_street", "residential",
    "service", "unclassified", "tertiary", "tertiary_link", "track",
}
EXPLICIT_FOOT = {"yes", "designated", "permissive", "official"}
LIMITED_ACCESS = {
    "no", "private", "customers", "delivery", "agricultural", "forestry",
    "use_sidepath",
}
INDOOR = {"yes", "room", "corridor", "area", "wall", "level"}

OUTPUT = Path(__file__).resolve().parents[1] / "dist" / "outdoor-network.mjs"


def tags(element):
    return {tag.attrib["k"]: tag.attrib["v"] for tag in element.iterfind("tag")}


def blocks_public_walking(values):
    return (
        values.get("access") in LIMITED_ACCESS
        or values.get("foot") in LIMITED_ACCESS
        or values.get("indoor") in INDOOR
        or values.get("locked") == "yes"
    )


def eligible_way(values):
    highway = values.get("highway")
    if blocks_public_walking(values) or any(
        values.get(key) == "yes" for key in ("area", "disused", "abandoned")
    ):
        return False
    if values.get("building") or values.get("building:part"):
        return False
    if highway in PEDESTRIAN_WAYS:
        return True
    return (
        highway in {"cycleway", "primary", "secondary", "primary_link", "secondary_link"}
        and values.get("foot") in EXPLICIT_FOOT
    )


def route_network(root, bounds, source_date):
    west, south, east, north = bounds
    coords = {}
    for node in root.iterfind("node"):
        if blocks_public_walking(tags(node)):
            continue
        lat, lng = float(node.attrib["lat"]), float(node.attrib["lon"])
        if south <= lat <= north and west <= lng <= east:
            coords[node.attrib["id"]] = [lat, lng]

    nodes = []
    indices = {}
    ways = []
    step_indices = []

    def add_segment(segment, is_steps):
        if len(segment) < 2:
            return
        indices_for_segment = []
        for osm_id in segment:
            if osm_id not in indices:
                indices[osm_id] = len(nodes)
                nodes.append(coords[osm_id])
            indices_for_segment.append(indices[osm_id])
        if is_steps:
            step_indices.append(len(ways))
        ways.append(indices_for_segment)

    for way in root.iterfind("way"):
        way_tags = tags(way)
        if not eligible_way(way_tags):
            continue
        is_steps = way_tags.get("highway") == "steps"
        segment = []
        for node in way.iterfind("nd"):
            osm_id = node.attrib["ref"]
            if osm_id not in coords:
                # Never bridge a blocked barrier or a gap in the source geometry.
                add_segment(segment, is_steps)
                segment = []
            elif not segment or coords[segment[-1]] != coords[osm_id]:
                segment.append(osm_id)
        add_segment(segment, is_steps)

    if not nodes or not ways:
        raise ValueError("No walkable geometry was found in this campus extract")

    return {
        "nodes": nodes,
        "ways": ways,
        "stepWayIndices": step_indices,
        "sourceDate": source_date,
        "bounds": [[south, west], [north, east]],
    }


def read_extract(campus, bounds, source_dir):
    if source_dir:
        return ET.parse(source_dir / f"{campus}.osm").getroot()
    params = urlencode({"bbox": ",".join(map(str, bounds))})
    request = Request(
        f"{OSM_MAP}?{params}",
        headers={"User-Agent": "WayfoundCampusPrototype/1.0 (campus routing data refresh)"},
    )
    with urlopen(request, timeout=40) as response:
        return ET.parse(response).getroot()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path)
    parser.add_argument(
        "--source-date",
        default=datetime.now(timezone.utc).date().isoformat(),
        help="Snapshot retrieval date, ISO YYYY-MM-DD (default: current UTC date)",
    )
    args = parser.parse_args()
    networks = {}
    for campus, bounds in CAMPUS_BOUNDS.items():
        root = read_extract(campus, bounds, args.source_dir)
        network = route_network(root, bounds, args.source_date)
        networks[campus] = network
        print(f"{campus}: {len(network['nodes'])} nodes, {len(network['ways'])} ways")

    lines = [
        "// Generated by scripts/refresh-outdoor-data.py from the OpenStreetMap map API.",
        "// Data © OpenStreetMap contributors, https://www.openstreetmap.org/copyright",
        "// This derivative route database is available under ODbL 1.0.",
        "// https://opendatacommons.org/licenses/odbl/1-0/",
        "export const outdoorNetworks = {",
    ]
    for campus, network in networks.items():
        lines.append(f"  {campus}: {json.dumps(network, separators=(',', ':'))},")
    lines.extend(["};", ""])
    OUTPUT.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
