#!/usr/bin/env python3
"""Build Wayfound's campus dataset from open data. Standard library only.

Inputs (see README, "Rebuilding the data"):
  --campus       preset: uoft (default), mcmaster or waterloo
  --osm-dir      OpenStreetMap API tiles from tools/fetch_osm.py
  --massing-shp  City of Toronto 3D Massing shapefile (.shp, Web Mercator); optional
  --c3d-dir      U of T campus map exports: c3d_cat_<id>.json and loc/<id>.json; optional
  --cobalt       cobalt-uoft buildings.json (building codes and addresses); optional
  --notices      snapshot from tools/fetch_notices.py; optional
  --buildings-geojson     official building list: points with buildingCode and buildingName; optional
  --accessible-entrances  official step-free doors: points named "Building Name (CODE)"; optional
Without --massing-shp, buildings are extruded from OpenStreetMap footprints with heights
estimated from their tags. Without an official building list (--c3d-dir, --cobalt or
--buildings-geojson), campus buildings are the named OpenStreetMap buildings inside the
preset's campus boundary.
Output: one compact JSON document that the browser app loads.
"""
import argparse
import datetime
import glob
import html as htmllib
import json
import math
import os
import re
import struct
import sys
from collections import defaultdict

# Per preset: "start" matches the transit place used as the default origin (a venue wins when
# there is one) and "picks" lists well-known building ids, of which the first four found are kept.
CAMPUSES = {
    "uoft": {
        "name": "University of Toronto, St. George", "short": "U of T",
        "bbox": (43.6535, -79.4045, 43.6705, -79.3835),  # south, west, north, east
        "venue": {"name": "Polish Combatants' Hall (ONHacks venue)", "match": r"polish combatant|\bSPK\b",
                  "house": "206", "street": "Beverley Street", "fallback": (-79.39478, 43.65653)},
        "picks": ("RL", "BA", "HH", "MS", "UC", "SS"),
    },
    "mcmaster": {
        "name": "McMaster University", "short": "McMaster",
        "bbox": (43.2560, -79.9290, 43.2712, -79.9085),
        "boundary": r"^mcmaster university$",  # name of the amenity=university area in OpenStreetMap
        "landmarks": False,  # leave out other named OSM buildings (shops, houses, residence wings)
        "start": r"bus terminal",
        "picks": ("MML", "MUSC", "JHE", "MDCL", "ITB", "UH"),
    },
    "waterloo": {
        "name": "University of Waterloo", "short": "Waterloo",
        "bbox": (43.4640, -80.5580, 43.4790, -80.5325),
        "boundary": r"^university of waterloo$",
        "landmarks": False,
        "start": r"^university of waterloo station$",
        "picks": ("MC", "DC", "SLC", "DP", "LIB", "QNC", "PAC"),
        "code_aliases": {"STP": "UTD"},  # the entrance layer still uses St. Paul's code for United College
        "official": {"name": "University of Waterloo open data",
                     "url": "https://services5.arcgis.com/z87D0RdgTttiUQbV/arcgis/rest/services/v2_UWaterloo_Open_Data/FeatureServer/1",
                     "licence": "open data published by the university, used with attribution"},
    },
}
R_MERC = 6378137.0


def use_bbox(south, west, north, east):
    """Set the working area. Coordinates are projected to metres around its centre."""
    global S, W, N, E, LAT0, LON0, KX, KY
    S, W, N, E = south, west, north, east
    LAT0, LON0 = (S + N) / 2, (W + E) / 2
    KX, KY = 111320 * math.cos(math.radians(LAT0)), 110540.0


use_bbox(*CAMPUSES["uoft"]["bbox"])

KIND = {"footway": 0, "sidewalk": 1, "crossing": 2, "path": 3, "pedestrian": 4, "steps": 5,
        "cycleway": 6, "service": 7, "street": 8, "corridor": 9, "link": 10, "elevator": 11}
ROAD_CLASS = {"motorway": 0, "trunk": 0, "primary": 0, "primary_link": 0, "secondary": 1,
              "secondary_link": 1, "tertiary": 2, "tertiary_link": 2, "residential": 3,
              "unclassified": 3, "living_street": 3, "service": 4}
ROUGH = {"sett", "cobblestone", "unhewn_cobblestone", "fine_gravel", "compacted", "grass_paver", "pebblestone"}
UNPAVED = {"unpaved", "gravel", "dirt", "ground", "grass", "sand", "mud", "earth", "woodchips", "rock"}
F_NO, F_LIMITED, F_YES, F_ROUGH, F_UNPAVED, F_SHELTER, F_RAMP, F_LIT, F_SIGNAL, F_MARKED, F_NARROW = (
    1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024)
NO_LINK_KINDS = {KIND["steps"], KIND["corridor"], KIND["elevator"], KIND["crossing"], KIND["link"]}

ENTRANCE_CATS = {48650: True, 48649: False}  # U of T map category id -> powered door
BUILDING_CAT, TRANSIT_CAT, NOTICE_CAT = 48654, 50079, 64738
WASHROOM_CATS = (50112, 50113, 50114, 48701, 48702, 48704)


# ---------- geometry ----------

def xy(lon, lat):
    return ((lon - LON0) * KX, (lat - LAT0) * KY)


def quant(p):
    """Metres -> integer micro-degrees relative to the south-west corner."""
    return [round((LON0 + p[0] / KX - W) * 1e6), round((LAT0 + p[1] / KY - S) * 1e6)]


def flat(points):
    out = []
    for p in points:
        out.extend(quant(p))
    return out


def in_bbox_xy(p, pad=0.0):
    lon, lat = LON0 + p[0] / KX, LAT0 + p[1] / KY
    return W - pad <= lon <= E + pad and S - pad <= lat <= N + pad


def pip(pt, ring):
    x, y = pt
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def seg_project(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    c = (a[0] + t * dx, a[1] + t * dy)
    return math.hypot(p[0] - c[0], p[1] - c[1]), t, c


def ring_distance(pt, ring):
    return min(seg_project(pt, ring[i], ring[i + 1])[0] for i in range(len(ring) - 1))


def ring_area_centroid(ring):
    a = cx = cy = 0.0
    for i in range(len(ring) - 1):
        x0, y0 = ring[i]
        x1, y1 = ring[i + 1]
        cross = x0 * y1 - x1 * y0
        a += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if abs(a) < 1e-9:
        return 0.0, ring[0]
    return a / 2, (cx / (3 * a), cy / (3 * a))


def simplify(pts, tol):
    if len(pts) < 4:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        worst, worst_i = 0.0, -1
        for i in range(a + 1, b):
            d = seg_project(pts[i], pts[a], pts[b])[0]
            if d > worst:
                worst, worst_i = d, i
        if worst > tol:
            keep[worst_i] = True
            stack.append((a, worst_i))
            stack.append((worst_i, b))
    return [p for p, k in zip(pts, keep) if k]


class Grid:
    def __init__(self, cell):
        self.cell = cell
        self.cells = defaultdict(list)

    def _key(self, x, y):
        return int(math.floor(x / self.cell)), int(math.floor(y / self.cell))

    def add_box(self, x0, y0, x1, y1, item):
        kx0, ky0 = self._key(min(x0, x1), min(y0, y1))
        kx1, ky1 = self._key(max(x0, x1), max(y0, y1))
        for kx in range(kx0, kx1 + 1):
            for ky in range(ky0, ky1 + 1):
                self.cells[(kx, ky)].append(item)

    def near(self, x, y, r):
        kx0, ky0 = self._key(x - r, y - r)
        kx1, ky1 = self._key(x + r, y + r)
        seen = set()
        for kx in range(kx0, kx1 + 1):
            for ky in range(ky0, ky1 + 1):
                for item in self.cells.get((kx, ky), ()):
                    if item not in seen:
                        seen.add(item)
                        yield item


# ---------- loaders ----------

def load_osm(osm_dir):
    nodes, ntags, ways, rels = {}, {}, {}, {}
    paths = sorted(glob.glob(os.path.join(osm_dir, "tile_*.json")))
    if not paths:
        sys.exit(f"no OSM tiles in {osm_dir}; run tools/fetch_osm.py first")
    for path in paths:
        with open(path) as f:
            for el in json.load(f)["elements"]:
                if el["type"] == "node":
                    nodes[el["id"]] = xy(el["lon"], el["lat"])
                    if el.get("tags"):
                        ntags[el["id"]] = el["tags"]
                elif el["type"] == "way":
                    ways[el["id"]] = el
                else:
                    rels[el["id"]] = el
    return nodes, ntags, ways, rels


def load_massing(shp_path):
    """Yield (rings, avg_height, max_height) for footprints that overlap the bbox."""
    def merc(lon, lat):
        return R_MERC * math.radians(lon), R_MERC * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))

    def unmerc(x, y):
        return xy(math.degrees(x / R_MERC), math.degrees(2 * math.atan(math.exp(y / R_MERC)) - math.pi / 2))

    x0, y0 = merc(W, S)
    x1, y1 = merc(E, N)
    dbf_path = shp_path[:-4] + ".dbf"
    with open(dbf_path, "rb") as dbf, open(shp_path, "rb") as shp:
        header = dbf.read(32)
        _, hlen, rlen = struct.unpack("<IHH", header[4:12])
        fields, offset = {}, 1
        while True:
            fd = dbf.read(32)
            if fd[0] == 0x0D:
                break
            fields[fd[:11].split(b"\x00")[0].decode()] = (offset, fd[16])
            offset += fd[16]
        for required in ("AVG_HEIGHT", "MAX_HEIGHT"):
            if required not in fields:
                sys.exit(f"{dbf_path}: missing field {required}; found {sorted(fields)}")

        def attr(index, name):
            off, length = fields[name]
            dbf.seek(hlen + index * rlen + off)
            raw = dbf.read(length).strip()
            return float(raw) if raw else 0.0

        shp.seek(100)
        index = 0
        while True:
            rh = shp.read(8)
            if len(rh) < 8:
                break
            content_len = struct.unpack(">i", rh[4:8])[0] * 2
            head = shp.read(min(44, content_len))  # null shapes are only 4 bytes long
            shape_type = struct.unpack("<i", head[:4])[0]
            rest = content_len - len(head)
            if shape_type in (5, 15, 25) and len(head) == 44:
                bx0, by0, bx1, by1 = struct.unpack("<4d", head[4:36])
                if not (bx1 < x0 or bx0 > x1 or by1 < y0 or by0 > y1):
                    nparts, npoints = struct.unpack("<ii", head[36:44])
                    body = shp.read(rest)
                    rest = 0
                    parts = struct.unpack(f"<{nparts}i", body[:4 * nparts])
                    pts = struct.unpack(f"<{2 * npoints}d", body[4 * nparts:4 * nparts + 16 * npoints])
                    rings = []
                    for k, start in enumerate(parts):
                        end = parts[k + 1] if k + 1 < nparts else npoints
                        rings.append([unmerc(pts[2 * i], pts[2 * i + 1]) for i in range(start, end)])
                    yield rings, attr(index, "AVG_HEIGHT"), attr(index, "MAX_HEIGHT")
            if rest:
                shp.seek(rest, 1)
            index += 1


def c3d_locations(c3d_dir, cat_id):
    if not c3d_dir:
        return []
    path = os.path.join(c3d_dir, f"c3d_cat_{cat_id}.json")
    with open(path) as f:
        return (json.load(f).get("children") or {}).get("locations") or []


def c3d_detail(c3d_dir, loc_id):
    if not c3d_dir:
        return {}
    try:
        with open(os.path.join(c3d_dir, "loc", f"{loc_id}.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def html_lines(markup):
    text = re.sub(r"(?i)<\s*(br|/p|/div|/li|/h\d|/tr)\s*/?>", "\n", markup or "")
    text = htmllib.unescape(re.sub(r"<[^>]+>", " ", text))
    return [ln for ln in (re.sub(r"\s+", " ", raw).strip() for raw in text.split("\n")) if ln]


def classify_entrance(name, desc):
    """Read U of T's written door description. Returns (access, relies_on_lift)."""
    text = f"{name} {desc}".lower()
    no_ramp = re.search(r"no ramp|without (a )?ramp|not (wheelchair )?accessible|inaccessible", text)
    ramp = re.search(r"\bramp", text) and not no_ramp
    level = re.search(r"\blevel (\w+ )?(path|pathway|walkway|walk|entry|entrance|access|approach|surface|sidewalk|route|ground)"
                      r"|at[- ]grade|grade[- ]level|\bat street level|level (to|with) the sidewalk|no steps|step[- ]free"
                      r"|barrier[- ]free|sloped (\w+ )?(walkway|path|pathway|sidewalk)|low-slope|gentle slop", text)
    lift = bool(re.search(r"\blift\b", text))
    stairs = re.search(r"\bstair(?!\s*lift|well)|\bsteps?\b", text)  # "stair lift" and "stairwell" are indoors
    named_accessible = "accessible" in name.lower()
    if ramp:
        return "stepfree", lift
    if level:
        # A level approach that still ends in steps is only trusted when the text names an accessible door.
        if not stairs or re.search(r"accessible (entry|entrance|door)", text):
            return "stepfree", lift
        return "unknown", False
    if named_accessible and not stairs and not no_ramp:
        return "stepfree", lift
    if lift and not stairs and not no_ramp:
        return "stepfree", True
    if stairs or no_ramp:
        return "steps", False
    return "unknown", False


# ---------- OSM interpretation ----------

def stitch(node_lists):
    rings, open_lists = [], []
    for nl in node_lists:
        if len(nl) >= 4 and nl[0] == nl[-1]:
            rings.append(nl)
        elif len(nl) >= 2:
            open_lists.append(list(nl))
    while open_lists:
        cur = open_lists.pop()
        grew = True
        while cur[0] != cur[-1] and grew:
            grew = False
            for i, other in enumerate(open_lists):
                if other[0] == cur[-1]:
                    cur += other[1:]
                elif other[-1] == cur[-1]:
                    cur += other[-2::-1]
                else:
                    continue
                open_lists.pop(i)
                grew = True
                break
        if cur[0] == cur[-1] and len(cur) >= 4:
            rings.append(cur)
    return rings


def walk_kind(tg):
    hw = tg.get("highway")
    if hw == "footway":
        fw = tg.get("footway")
        return "sidewalk" if fw == "sidewalk" else "crossing" if fw == "crossing" else "footway"
    if hw in ("path", "track"):
        return "path"
    if hw in ("pedestrian", "steps", "corridor", "elevator", "service"):
        return hw
    if hw == "cycleway":
        return "cycleway" if tg.get("foot") in ("yes", "designated", "permissive") else None
    if hw in ("residential", "unclassified", "living_street", "tertiary", "tertiary_link"):
        return "street"
    return None


def walkable(tg):
    foot, access = tg.get("foot"), tg.get("access")
    if foot in ("no", "private"):
        return False
    if access in ("no", "private") and foot not in ("yes", "designated", "permissive"):
        return False
    return True


def way_flags(tg, kind):
    f = 0
    wc = tg.get("wheelchair")
    if wc == "no":
        f |= F_NO
    elif wc == "limited":
        f |= F_LIMITED
    elif wc in ("yes", "designated"):
        f |= F_YES
    if tg.get("surface") in ROUGH or tg.get("smoothness") in ("bad", "very_bad", "horrible", "very_horrible", "impassable"):
        f |= F_ROUGH
    if tg.get("surface") in UNPAVED:
        f |= F_UNPAVED
    if (tg.get("covered") in ("yes", "arcade", "colonnade") or tg.get("tunnel") in ("yes", "building_passage")
            or tg.get("indoor") == "yes" or kind == "corridor"):
        f |= F_SHELTER
    if kind == "steps" and tg.get("ramp:wheelchair") == "yes":
        f |= F_RAMP
    if tg.get("lit") == "yes":
        f |= F_LIT
    if kind == "crossing":
        crossing = tg.get("crossing", "")
        if crossing == "traffic_signals" or tg.get("crossing:signals") == "yes":
            f |= F_SIGNAL
        elif crossing in ("marked", "zebra", "uncontrolled") or tg.get("crossing:markings") not in (None, "no"):
            f |= F_MARKED
    try:
        if float(tg.get("width", "")) < 0.9:
            f |= F_NARROW
    except ValueError:
        pass
    return f


def node_flags(tg):
    f = 0
    kerb, barrier = tg.get("kerb"), tg.get("barrier")
    if kerb == "raised" or (barrier == "kerb" and kerb not in ("lowered", "flush", "no")):
        f |= 1
    if barrier in ("stile", "turnstile", "full-height_turnstile", "kissing_gate", "step", "log", "horse_stile"):
        f |= 1
    closed = tg.get("access") in ("no", "private") or tg.get("foot") in ("no", "private") or tg.get("locked") == "yes"
    if barrier in ("gate", "door", "fence", "wall") and closed and tg.get("foot") not in ("yes", "designated", "permissive"):
        f |= 2
    return f


def parse_incline(value):
    match = re.match(r"^\s*(-?\d+(?:\.\d+)?)\s*%\s*$", value or "")
    return min(60, round(abs(float(match.group(1))))) if match else 0


def parse_int(value):
    return int(value) if value and value.isdigit() else 0


def osm_height(tg):
    """Building height in metres from OSM tags: `height`, else levels x 4.2, else a flat 9."""
    for key, scale in (("height", 1.0), ("building:levels", 4.2)):
        match = re.match(r"^\s*(\d+(?:\.\d+)?)\s*m?\s*$", tg.get(key, ""))
        if match and float(match.group(1)) > 0:
            return float(match.group(1)) * scale
    return 9.0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--campus", choices=sorted(CAMPUSES), default="uoft")
    for flag in ("--osm-dir", "--out"):
        ap.add_argument(flag, required=True)
    for flag in ("--massing-shp", "--c3d-dir", "--cobalt", "--notices", "--buildings-geojson", "--accessible-entrances"):
        ap.add_argument(flag, help="optional; see the module docstring")
    args = ap.parse_args()
    campus_cfg = CAMPUSES[args.campus]
    venue_cfg = campus_cfg.get("venue")
    use_bbox(*campus_cfg["bbox"])

    nodes, ntags, ways, rels = load_osm(args.osm_dir)
    names, name_index = [], {}

    def name_id(name):
        if not name:
            return -1
        if name not in name_index:
            name_index[name] = len(names)
            names.append(name)
        return name_index[name]

    # ----- OSM buildings -----
    buildings = []  # {tags, rings (outer, metres), node_ids}

    def add_building(tags, node_lists):
        rings = [[nodes[n] for n in nl if n in nodes] for nl in node_lists]
        rings = [r for r in rings if len(r) >= 4]
        if rings and any(in_bbox_xy(p, 0.001) for p in rings[0]):
            buildings.append({"tags": tags, "rings": rings, "node_ids": {n for nl in node_lists for n in nl}})

    for way in ways.values():
        tg = way.get("tags") or {}
        nl = way["nodes"]
        if tg.get("building", "no") != "no" and len(nl) >= 4 and nl[0] == nl[-1]:
            add_building(tg, [nl])
    for rel in rels.values():
        tg = rel.get("tags") or {}
        if tg.get("type") == "multipolygon" and tg.get("building", "no") != "no":
            outers = [ways[m["ref"]]["nodes"] for m in rel["members"]
                      if m["type"] == "way" and m.get("role") != "inner" and m["ref"] in ways]
            rings = stitch(outers)
            if rings:
                add_building(tg, rings)
    bgrid = Grid(80)
    for bi, b in enumerate(buildings):
        xs = [p[0] for r in b["rings"] for p in r]
        ys = [p[1] for r in b["rings"] for p in r]
        b["box"] = (min(xs), min(ys), max(xs), max(ys))
        bgrid.add_box(*b["box"], bi)
        b["places"] = []

    def building_at(pt, reach=0.0):
        """Index of the OSM building containing pt, else the nearest within reach metres."""
        best, best_d = -1, reach
        for bi in bgrid.near(pt[0], pt[1], max(reach, 1.0)):
            b = buildings[bi]
            if any(pip(pt, r) for r in b["rings"]):
                return bi
            if reach:
                d = min(ring_distance(pt, r) for r in b["rings"])
                if d < best_d:
                    best, best_d = bi, d
        return best

    # ----- pedestrian network -----
    way_cols = {"kind": [], "flags": [], "name": [], "near": [], "incline": [], "steps": [], "osm": []}

    def add_way(kind, flags=0, name=-1, incline=0, steps=0, osm=0):
        for key, value in (("kind", KIND[kind]), ("flags", flags), ("name", name), ("near", -1),
                           ("incline", incline), ("steps", steps), ("osm", osm)):
            way_cols[key].append(value)
        return len(way_cols["kind"]) - 1

    raw_edges, way_mid = [], {}
    road_lines, road_segs = [], Grid(40)
    seg_store = []
    for wid, way in ways.items():
        tg = way.get("tags") or {}
        nl = [n for n in way["nodes"] if n in nodes]
        if len(nl) < 2 or not any(in_bbox_xy(nodes[n], 0.002) for n in nl):
            continue
        hw = tg.get("highway")
        if hw in ROAD_CLASS and tg.get("area") != "yes":
            pts = [nodes[n] for n in nl]
            road_lines.append((ROAD_CLASS[hw], name_id(tg.get("name")), pts))
            if tg.get("name"):
                for a, b in zip(pts, pts[1:]):
                    seg_store.append((a, b, name_index[tg["name"]]))
                    road_segs.add_box(a[0], a[1], b[0], b[1], len(seg_store) - 1)
        kind = walk_kind(tg)
        if kind is None or not walkable(tg):
            continue
        wi = add_way(kind, way_flags(tg, kind), name_id(tg.get("name")), parse_incline(tg.get("incline")),
                     parse_int(tg.get("step_count")), wid)
        a, b = nodes[nl[len(nl) // 2 - 1]], nodes[nl[len(nl) // 2]]
        way_mid[wi] = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        for a, b in zip(nl, nl[1:]):
            if a != b and (in_bbox_xy(nodes[a], 0.002) or in_bbox_xy(nodes[b], 0.002)):
                raw_edges.append((a, b, wi))

    # Name unnamed sidewalks and crossings after the street they follow or cross.
    for wi, mid in way_mid.items():
        kind = way_cols["kind"][wi]
        reach = 24 if kind == KIND["sidewalk"] else 14 if kind == KIND["crossing"] else 0
        if not reach or way_cols["name"][wi] >= 0:
            continue
        best = min(((seg_project(mid, *seg_store[si][:2])[0], seg_store[si][2])
                    for si in road_segs.near(mid[0], mid[1], reach)), default=None)
        if best and best[0] <= reach:
            way_cols["near"][wi] = best[1]

    # Keep the largest connected component so every snap target is reachable on foot.
    parent = {}

    def find(v):
        while parent.setdefault(v, v) != v:
            parent[v] = parent[parent[v]]
            v = parent[v]
        return v

    for a, b, _ in raw_edges:
        parent[find(a)] = find(b)
    sizes = defaultdict(int)
    for v in list(parent):
        sizes[find(v)] += 1
    main_root = max(sizes, key=sizes.get)
    node_of, P, edges = {}, [], []

    def graph_node(osm_id):
        if osm_id not in node_of:
            node_of[osm_id] = len(P)
            P.append(nodes[osm_id])
        return node_of[osm_id]

    for a, b, wi in raw_edges:
        if find(a) == main_root:
            edges.append([graph_node(a), graph_node(b), wi])
    dropped_edges = len(raw_edges) - len(edges)
    nflags = {}
    for osm_id, idx in node_of.items():
        flags = node_flags(ntags.get(osm_id, {}))
        if flags:
            nflags[idx] = flags

    edge_grid = Grid(40)
    for ei, (a, b, _) in enumerate(edges):
        edge_grid.add_box(P[a][0], P[a][1], P[b][0], P[b][1], ei)
    node_grid = Grid(40)
    for idx, p in enumerate(P):
        node_grid.add_box(p[0], p[1], p[0], p[1], idx)
    link_way = add_way("link")
    splits = defaultdict(list)
    link_stats = {"direct": 0, "linked": 0, "through_building": 0, "unlinked": 0}

    def crosses(a, b, rings):
        if math.hypot(b[0] - a[0], b[1] - a[1]) < 6:
            return False
        for t in (0.35, 0.5, 0.65, 0.8, 0.95):
            s = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            if any(pip(s, r) for r in rings):
                return True
        return False

    def link(pt, rings):
        """Create a door node at pt joined to the nearest path. Returns node index or -1."""
        fallback = None
        for reach in (30, 70, 140):
            cands = []
            for ei in edge_grid.near(pt[0], pt[1], reach):
                a, b, wi = edges[ei]
                if way_cols["kind"][wi] in NO_LINK_KINDS:
                    continue
                d, t, c = seg_project(pt, P[a], P[b])
                if d <= reach:
                    cands.append((d, ei, t, c))
            cands.sort()
            chosen = next((c for c in cands[:14] if not crosses(pt, c[3], rings)), None)
            if chosen is None and cands and fallback is None:
                fallback = cands[0]
            if chosen:
                break
        else:
            chosen = fallback
            if chosen is None:
                link_stats["unlinked"] += 1
                return -1
            link_stats["through_building"] += 1
        d, ei, t, c = chosen
        a, b, _ = edges[ei]
        seg_len = math.hypot(P[b][0] - P[a][0], P[b][1] - P[a][1])
        if t * seg_len < 0.6:
            target = a
        elif (1 - t) * seg_len < 0.6:
            target = b
        else:
            target = len(P)
            P.append(c)
            splits[ei].append((t, target))
        door = len(P)
        P.append(pt)
        edges.append([door, target, link_way])
        link_stats["linked"] += 1
        return door

    def nearest_node(pt, rings, reach=150):
        best, best_d = -1, reach
        for idx in node_grid.near(pt[0], pt[1], reach):
            d = min((ring_distance(P[idx], r) for r in rings), default=math.hypot(P[idx][0] - pt[0], P[idx][1] - pt[1]))
            if d < best_d:
                best, best_d = idx, d
        return best

    # ----- places -----
    places, entrances = [], []
    code_to_place = {}

    def add_place(pid, name, ptype, pt, bi=-1, **extra):
        place = {"id": pid, "name": name, "type": ptype, "pt": pt, "bi": bi, "ent": [], **extra}
        places.append(place)
        if bi >= 0:
            buildings[bi]["places"].append(len(places) - 1)
        return len(places) - 1

    cobalt = {}
    if args.cobalt:
        with open(args.cobalt) as f:
            for line in f:
                if line.strip():
                    row = json.loads(line)
                    code = (row.get("code") or "").strip()
                    if row.get("campus") == "UTSG" and re.fullmatch(r"[A-Z0-9]{2,3}", code):
                        cobalt[code] = row
    official = {}
    for loc in c3d_locations(args.c3d_dir, BUILDING_CAT):
        parts = [p.strip() for p in loc["name"].split("|")]
        if len(parts) >= 2 and re.fullmatch(r"[A-Z0-9]{2,3}", parts[1]):
            official[parts[1]] = (parts[0], loc)
    campus_unplaced = []
    for code in sorted(set(cobalt) | set(official)):
        row = cobalt.get(code)
        name, loc = official.get(code, (row["name"] if row else code, None))
        detail_lines = html_lines(c3d_detail(args.c3d_dir, loc["id"]).get("description")) if loc else []
        candidates = []
        if loc:
            candidates.append(xy(loc["lng"], loc["lat"]))
        if row:
            candidates.append(xy(row["lng"], row["lat"]))
        bi = next((b for b in (building_at(pt) for pt in candidates) if b >= 0), -1)
        if bi < 0:
            bi = next((b for b in (building_at(pt, 30) for pt in candidates) if b >= 0), -1)
        if bi < 0 or not in_bbox_xy(candidates[0]):
            campus_unplaced.append(code)
            continue
        area, centroid = ring_area_centroid(buildings[bi]["rings"][0])
        pt = centroid if pip(centroid, buildings[bi]["rings"][0]) else candidates[0]
        addr = ""
        if detail_lines and re.match(r"^\d", detail_lines[0]):
            addr = re.split(r"\s*,?\s*Toronto", detail_lines[0])[0]
        elif row and row.get("address"):
            addr = row["address"].get("street", "")
        rooms = []
        for ln in detail_lines:
            m = re.match(r"^(.{3,70}?)\s*\|\s*(?:(?:Room|Rm\.?|Suite)\s*([A-Za-z]{0,2}\d{1,5}[A-Za-z]?)|(\d+)(?:st|nd|rd|th)\s+Floor)", ln)
            if m and "Building #" not in ln:
                rooms.append({"n": m.group(1).strip(" :"), "r": m.group(2) or "", "f": m.group(3) or ""})
        aka = sorted({alt for alt in ((row["name"], row.get("short_name")) if row else ()) if alt and alt not in (name, code)})
        code_to_place[code] = add_place(code, name, "building", pt, bi, code=code, addr=addr, rooms=rooms[:12], wc=[], aka=aka)

    # An official building list as GeoJSON points (buildingCode, buildingName), such as Waterloo's campus map layer.
    official_names = {}
    if args.buildings_geojson:
        with open(args.buildings_geojson) as f:
            listed = json.load(f)["features"]
        for feature in listed:
            props = feature["properties"]
            code, name = (props.get("buildingCode") or "").strip(), (props.get("buildingName") or "").strip()
            pt = xy(*feature["geometry"]["coordinates"][:2])
            # Sub-units of a residence carry a parentBuildingCode: only the parent becomes a place.
            if (props.get("parentBuildingCode") or not re.fullmatch(r"[A-Z][A-Z0-9]{1,3}", code) or code in code_to_place
                    or not name or "under construction" in name.lower() or not in_bbox_xy(pt)):
                continue
            aka = [alt.strip() for alt in re.split(r"[;|]", props.get("alternateBuildingNames") or "")]
            former = re.search(r"\s*\[formerly (.+?)\]$", name)  # "... [formerly Engineering 7 (E7)]"
            if former:  # the former name and code stay searchable as aliases
                name = name[:former.start()].strip()
                aka += [part.strip() for part in re.split(r"[()]", former.group(1))]
            bi = building_at(pt)
            if bi < 0:
                bi = building_at(pt, 30)
            if bi < 0:
                campus_unplaced.append(code)
                continue
            centroid = ring_area_centroid(buildings[bi]["rings"][0])[1]
            code_to_place[code] = add_place(code, name, "building", centroid if pip(centroid, buildings[bi]["rings"][0]) else pt,
                                            bi, code=code, addr="", wc=[],
                                            aka=[alt for i, alt in enumerate(aka) if alt and alt not in (name, code, *aka[:i])])
            official_names[name.lower()] = code

    # Without an official directory, campus buildings are the named OSM buildings inside the campus boundary.
    if campus_cfg.get("boundary") and not args.buildings_geojson:
        boundary = [[nodes[n] for n in way["nodes"] if n in nodes] for way in ways.values()
                    if (way.get("tags") or {}).get("amenity") == "university"
                    and re.search(campus_cfg["boundary"], way["tags"].get("name", ""), re.I)
                    and len(way["nodes"]) >= 4 and way["nodes"][0] == way["nodes"][-1]]
        if not boundary:
            sys.exit(f"no closed amenity=university way named /{campus_cfg['boundary']}/ in {args.osm_dir}")
        by_name = {}
        for bi, b in enumerate(buildings):
            tags = b["tags"]
            name = tags.get("name")
            centroid = ring_area_centroid(b["rings"][0])[1]
            if not name or b["places"] or not any(pip(centroid, ring) for ring in boundary):
                continue
            if name in by_name:  # one place for a building mapped as several footprints
                b["places"].append(by_name[name])
                continue
            labels = [part.strip() for key in ("short_name", "ref", "alt_name", "official_name", "old_name")
                      for part in tags.get(key, "").split(";") if part.strip()]
            code = next((c for c in labels if re.fullmatch(r"[A-Z][A-Z0-9]{1,5}", c) and c not in code_to_place), None)
            pt = centroid if pip(centroid, b["rings"][0]) else b["rings"][0][0]
            street = " ".join(v for v in (tags.get("addr:housenumber"), tags.get("addr:street")) if v)
            by_name[name] = add_place(code or f"osm{bi}", name, "building", pt, bi, addr=street, wc=[],
                                      aka=sorted({alt for alt in labels if alt not in (name, code)}),
                                      **({"code": code} if code else {}))
            if code:
                code_to_place[code] = by_name[name]

    for bi, b in enumerate(buildings):
        name = b["tags"].get("name")
        if name and not b["places"] and campus_cfg.get("landmarks", True):
            area, centroid = ring_area_centroid(b["rings"][0])
            if in_bbox_xy(centroid):
                pt = centroid if pip(centroid, b["rings"][0]) else b["rings"][0][0]
                street = " ".join(v for v in (b["tags"].get("addr:housenumber"), b["tags"].get("addr:street")) if v)
                add_place(f"osm{bi}", name, "landmark", pt, bi, addr=street)

    venue_pi, venue_source = -1, "none"
    if venue_cfg:
        venue_addr = f"{venue_cfg['house']} {venue_cfg['street']}"
        for pi, place in enumerate(places):
            tags = buildings[place["bi"]]["tags"]
            if re.search(venue_cfg["match"], place["name"], re.I) or (
                    tags.get("addr:housenumber") == venue_cfg["house"] and tags.get("addr:street") == venue_cfg["street"]):
                venue_pi = pi
                place.update(type="venue", name=venue_cfg["name"], id="venue")
                break
        if venue_pi < 0:
            for bi, b in enumerate(buildings):
                if (b["tags"].get("addr:housenumber") == venue_cfg["house"]
                        and b["tags"].get("addr:street") == venue_cfg["street"]):
                    _, centroid = ring_area_centroid(b["rings"][0])
                    venue_pi = add_place("venue", venue_cfg["name"], "venue", centroid, bi, addr=venue_addr)
                    break
        if venue_pi < 0:
            pt = xy(*venue_cfg["fallback"])
            venue_pi = add_place("venue", venue_cfg["name"], "venue", pt, building_at(pt, 25), addr=venue_addr)
        venue_source = "osm" if places[venue_pi]["bi"] >= 0 else "fallback coordinate"

    def place_rings(place):
        return buildings[place["bi"]]["rings"] if place["bi"] >= 0 else []

    # ----- entrances: U of T official door descriptions first, then OSM -----
    seen_doors = {}
    for cat_id, powered in ENTRANCE_CATS.items():
        for loc in c3d_locations(args.c3d_dir, cat_id):
            key = (round(loc["lat"], 6), round(loc["lng"], 6))
            if key in seen_doors:
                seen_doors[key]["powered"] = seen_doors[key]["powered"] or powered
            else:
                seen_doors[key] = {"loc": loc, "powered": powered}
    official_skipped = 0
    for door in seen_doors.values():
        loc = door["loc"]
        pt = xy(loc["lng"], loc["lat"])
        if re.search(r"interior connection|cross[- ]?over", loc["name"].lower()) or not in_bbox_xy(pt):
            official_skipped += 1
            continue
        bi = building_at(pt, 22)
        owners = buildings[bi]["places"] if bi >= 0 else []
        if not owners:
            official_skipped += 1
            continue
        desc = " ".join(html_lines(c3d_detail(args.c3d_dir, loc["id"]).get("description")))
        access, lift = classify_entrance(loc["name"], desc)
        node = link(pt, buildings[bi]["rings"])
        if node < 0:
            official_skipped += 1
            continue
        entrances.append({"n": node, "pt": pt, "name": loc["name"].strip(), "desc": desc[:340], "src": "uoft",
                          "access": access, "powered": door["powered"], "lift": lift, "p": owners})
    # Official step-free doors as GeoJSON points named "Building Name (CODE)", such as Waterloo's open data.
    if args.accessible_entrances:
        with open(args.accessible_entrances) as f:
            accessible = json.load(f)["features"]
        for feature in accessible:
            props = feature["properties"]
            pt = xy(*feature["geometry"]["coordinates"][:2])
            label = (props.get("name") or "").strip()
            coded = re.search(r"\(([A-Z][A-Z0-9]{1,3})\)$", label)
            code = coded.group(1) if coded else official_names.get(label.lower())
            pi = code_to_place.get(campus_cfg.get("code_aliases", {}).get(code, code), -1)
            bi = building_at(pt, 40)
            owners = [pi] if pi >= 0 else buildings[bi]["places"] if bi >= 0 else []
            node = link(pt, buildings[bi]["rings"] if bi >= 0 else []) if owners and in_bbox_xy(pt) else -1
            if node < 0:
                official_skipped += 1
                continue
            note = (props.get("note") or "").strip()
            entrances.append({"n": node, "pt": pt, "name": f"Accessible entrance ({note})" if note else "Accessible entrance",
                              "desc": (props.get("description") or "").strip()[:340], "src": "uw", "access": "stepfree",
                              "powered": None, "lift": False, "p": owners})
    osm_entrances = 0
    for osm_id, tg in ntags.items():
        etype = tg.get("entrance")
        if not etype or etype in ("emergency", "exit", "service", "garage", "staff") or osm_id not in nodes:
            continue
        pt = nodes[osm_id]
        if not in_bbox_xy(pt):
            continue
        bi = next((i for i in bgrid.near(pt[0], pt[1], 2) if osm_id in buildings[i]["node_ids"]), -1)
        if bi < 0:
            bi = building_at(pt, 5)
        owners = buildings[bi]["places"] if bi >= 0 else []
        if not owners:
            continue
        if any(e["src"] in ("uoft", "uw") and set(e["p"]) & set(owners)
               and math.hypot(e["pt"][0] - pt[0], e["pt"][1] - pt[1]) < 9 for e in entrances):
            continue
        if osm_id in node_of:
            node = node_of[osm_id]
            link_stats["direct"] += 1
        else:
            node = link(pt, buildings[bi]["rings"])
        if node < 0:
            continue
        wc = tg.get("wheelchair")
        access = "stepfree" if wc in ("yes", "designated") else "steps" if wc == "no" else "unknown"
        label = tg.get("name") or ("Main entrance" if etype == "main" else "Entrance")
        entrances.append({"n": node, "pt": pt, "name": label, "desc": "", "src": "osm", "access": access,
                          "powered": tg.get("automatic_door") in ("yes", "button", "motion") or None,
                          "lift": False, "p": owners})
        osm_entrances += 1

    # The venue has no published door data: place its door on the facade facing its street.
    venue = places[venue_pi] if venue_cfg else {"bi": -1}
    if venue["bi"] >= 0:
        street = name_index.get(venue_cfg["street"], -2)
        ring = buildings[venue["bi"]]["rings"][0]
        best = None
        for a, b in zip(ring, ring[1:]):
            mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            for ei in edge_grid.near(mid[0], mid[1], 45):
                u, v, wi = edges[ei]
                if street in (way_cols["name"][wi], way_cols["near"][wi]):
                    d = seg_project(mid, P[u], P[v])[0]
                    if best is None or d < best[0]:
                        best = (d, mid)
        if best:
            node = link(best[1], buildings[venue["bi"]]["rings"])
            if node >= 0:
                entrances.append({"n": node, "pt": best[1],
                                  "name": f"{venue_cfg['street']} entrance (approximate position)",
                                  "desc": "", "src": "none", "access": "unknown", "powered": None, "lift": False,
                                  "p": [venue_pi]})

    # ----- transit -----
    subway_doors = [(osm_id, tg) for osm_id, tg in ntags.items()
                    if tg.get("railway") == "subway_entrance" and osm_id in nodes and in_bbox_xy(nodes[osm_id])]
    for loc in c3d_locations(args.c3d_dir, TRANSIT_CAT):
        pt = xy(loc["lng"], loc["lat"])
        if not in_bbox_xy(pt):
            continue
        name = loc["name"].split("|")[0].strip()
        pi = add_place(f"transit{loc['id']}", name, "transit", pt)
        if "subway" in name.lower() or "station" in name.lower():
            for osm_id, tg in subway_doors:
                dpt = nodes[osm_id]
                if math.hypot(dpt[0] - pt[0], dpt[1] - pt[1]) > 230:
                    continue
                node = node_of[osm_id] if osm_id in node_of else link(dpt, [])
                if node < 0:
                    continue
                wc = tg.get("wheelchair")
                entrances.append({"n": node, "pt": dpt, "name": tg.get("name") or "Station entrance", "desc": "",
                                  "src": "osm", "access": "stepfree" if wc == "yes" else "steps" if wc == "no" else "unknown",
                                  "powered": None, "lift": wc == "yes", "p": [pi]})

    if not args.c3d_dir:  # no campus map export: take rail and bus stations from OSM, rail first
        stations = sorted((tg.get("railway") != "station", osm_id) for osm_id, tg in ntags.items()
                          if (tg.get("amenity") == "bus_station" or tg.get("railway") == "station") and tg.get("name")
                          and osm_id in nodes and in_bbox_xy(nodes[osm_id]))
        station_names = set()
        for _, osm_id in stations:
            tg = ntags[osm_id]
            name = tg["name"] if re.search(r"station|terminal", tg["name"], re.I) else f"{tg['name']} Station"
            if name in station_names:  # a bus loop mapped beside the rail stop of the same name
                continue
            station_names.add(name)
            pi = add_place(f"transit{osm_id}", name, "transit", nodes[osm_id])
            if tg.get("wheelchair") == "yes":
                node = node_of[osm_id] if osm_id in node_of else link(nodes[osm_id], [])
                if node >= 0:
                    entrances.append({"n": node, "pt": nodes[osm_id], "name": "Platform", "desc": "", "src": "osm",
                                      "access": "stepfree", "powered": None, "lift": False, "p": [pi]})

    # Split linked edges, then give every place at least one routable anchor.
    rebuilt = []
    for ei, (a, b, wi) in enumerate(edges):
        if ei in splits:
            chain = [a] + [node for _, node in sorted(splits[ei])] + [b]
            rebuilt.extend([u, v, wi] for u, v in zip(chain, chain[1:]))
        else:
            rebuilt.append([a, b, wi])
    edges = rebuilt
    for ei, ent in enumerate(entrances):
        for pi in ent.pop("p"):
            places[pi]["ent"].append(ei)
    anchored = 0
    for pi, place in enumerate(places):
        if place["ent"]:
            continue
        node = nearest_node(place["pt"], place_rings(place))
        if node < 0:
            continue
        entrances.append({"n": node, "pt": P[node], "name": "Nearest mapped path", "desc": "", "src": "none",
                          "access": "unknown", "powered": None, "lift": False})
        place["ent"].append(len(entrances) - 1)
        anchored += 1
    places_kept = [p for p in places if p["ent"]]
    remap = {id(p): i for i, p in enumerate(places_kept)}

    # ----- accessible washrooms (official, with floor and room) -----
    washroom_seen, washroom_count = set(), 0
    for cat_id in WASHROOM_CATS:
        for loc in c3d_locations(args.c3d_dir, cat_id):
            if loc["id"] in washroom_seen or (loc["name"], loc["lat"]) in washroom_seen:
                continue
            washroom_seen.update({loc["id"], (loc["name"], loc["lat"])})
            pt = xy(loc["lng"], loc["lat"])
            if not in_bbox_xy(pt):
                continue
            code = loc["name"].split(" ")[0]
            pi = code_to_place.get(code, -1)
            if pi < 0:
                bi = building_at(pt, 20)
                pi = next((p for p in (buildings[bi]["places"] if bi >= 0 else []) if places[p]["type"] == "building"), -1)
            if pi < 0:
                continue
            desc = " ".join(html_lines(c3d_detail(args.c3d_dir, loc["id"]).get("description")))
            label = loc["name"][len(code):].strip() if code in code_to_place else loc["name"]
            places[pi]["wc"].append({"n": label, "d": desc[:200]})
            washroom_count += 1

    # ----- official access notices (entrance and elevator disruptions) -----
    access_meta = None
    if args.notices:
        with open(args.notices) as f:
            snap = json.load(f)
        stop = {"the", "of", "for", "and", "in", "at", "bldg", "building"}

        def tokens(text):
            return set(re.findall(r"[a-z0-9]+", text.lower())) - stop

        campus_tokens = [(pi, tokens(label)) for pi, p in enumerate(places_kept) if p["type"] == "building"
                         for label in [p["name"], *p.get("aka", [])]]

        def match_place(title):
            head = re.split(r"\s+[–-]\s+", title)[0]
            head = re.sub(r"^(EXTENDED|UPDATED?|CANCELLED|REVISED|RESOLVED|REMINDER)\b[:\s-]*", "", head)
            want = tokens(head)
            best, best_score = -1, 0.0
            for pi, have in campus_tokens:
                shared = len(want & have)
                if shared >= 2 or (shared == 1 and len(want) == 1):
                    score = shared / len(want) + 0.2 * shared / len(have)
                    if score > best_score:
                        best, best_score = pi, score
            return best if best_score >= 0.66 else -1

        def notice_kind(title):
            text = title.lower()
            if re.search(r"elevator|\blift|cars? out|cat ?\d|escalator", text):
                return "elevator"
            if re.search(r"entrance|door|access button|operator|ramp", text):
                return "entrance"
            return "other"

        today = snap["snapshot"][:10]
        year_ago = (datetime.date.fromisoformat(today) - datetime.timedelta(days=365)).isoformat()
        per_place, active, matched = defaultdict(list), [], 0
        for notice in snap["notices"]:
            pi = match_place(notice["title"])
            entry = {"title": notice["title"], "from": notice["from"], "to": notice["to"], "url": notice["url"],
                     "kind": notice_kind(notice["title"])}
            if notice.get("active"):
                entry["active"] = True
                active.append({**entry, "place": pi, "text": notice.get("text", "")[:520]})
            if pi >= 0:
                matched += 1
                per_place[pi].append(entry)
        top = []
        for pi, items in per_place.items():
            items.sort(key=lambda n: n["from"], reverse=True)
            past_year = [n for n in items if year_ago <= n["from"] <= today]
            places_kept[pi]["notices"] = {
                "count12": len(past_year), "elevator12": sum(1 for n in past_year if n["kind"] == "elevator"),
                "recent": [n for n in items if n["from"] <= today][:4]}
            if past_year:
                top.append({"place": pi, "count": len(past_year),
                            "elevator": places_kept[pi]["notices"]["elevator12"]})
        top.sort(key=lambda t: -t["count"])
        access_meta = {"source": snap["source"], "snapshot": snap["snapshot"], "parsed": len(snap["notices"]),
                       "matched": matched, "active": active, "top": top[:8]}

    # ----- 3D massing -----
    mass, mass_vertices = [], 0
    place_height = defaultdict(lambda: [0.0, 0.0])

    def footprints():
        """Yield (outer ring, hole rings, height, max height, OSM building index or None)."""
        if args.massing_shp:
            for rings, avg_h, max_h in load_massing(args.massing_shp):
                polygons = []
                for ring in rings:
                    if ring_area_centroid(ring)[0] < 0 or not polygons:  # shapefile outer rings run clockwise
                        polygons.append([ring, []])
                    else:
                        polygons[-1][1].append(ring)
                for outer, holes in polygons:
                    yield outer, holes, avg_h if avg_h > 0 else max_h, max_h, None
        else:  # no city massing: extrude OSM footprints, clockwise like the shapefile
            for bi, b in enumerate(buildings):
                height = osm_height(b["tags"])
                for ring in b["rings"]:
                    yield (ring[::-1] if ring_area_centroid(ring)[0] > 0 else ring), [], height, height, bi

    for outer, holes, height, max_h, bi in footprints():
        area, centroid = ring_area_centroid(outer)
        if abs(area) < 12 or height < 2 or not in_bbox_xy(centroid, 0.0005):
            continue
        if bi is None:
            bi = building_at(centroid)
        owners = [remap[id(places[p])] for p in buildings[bi]["places"] if id(places[p]) in remap] if bi >= 0 else []
        for pi in owners:
            place_height[pi][0] = max(place_height[pi][0], height)
            place_height[pi][1] = max(place_height[pi][1], max_h)
        campus = next((pi for pi in owners if places_kept[pi]["type"] in ("building", "venue")), -1)
        shape = [flat(simplify(outer, 0.35))]
        shape += [flat(simplify(h, 0.35)) for h in holes if abs(ring_area_centroid(h)[0]) > 12]
        mass_vertices += sum(len(r) for r in shape) // 2
        mass.append([round(height, 1), campus if campus >= 0 else (owners[0] if owners else -1),
                     1 if campus >= 0 else 0] + shape)

    # ----- context layers -----
    areas = []
    green = {"park": 0, "garden": 0, "common": 0, "playground": 0, "pitch": 1, "track": 1}
    landuse_green = {"grass", "recreation_ground", "meadow", "village_green", "flowerbed"}

    def area_type(tg):
        if tg.get("leisure") in green:
            return green[tg["leisure"]]
        if tg.get("landuse") in landuse_green or tg.get("natural") in ("wood", "scrub", "grassland"):
            return 0
        if tg.get("natural") == "water":
            return 2
        if tg.get("highway") in ("pedestrian", "footway") and tg.get("area") == "yes":
            return 3
        if tg.get("amenity") == "parking" and tg.get("parking", "surface") == "surface":
            return 4
        return None

    def add_area(tg, node_lists):
        kind = area_type(tg)
        if kind is None:
            return
        for nl in node_lists:
            ring = [nodes[n] for n in nl if n in nodes]
            if len(ring) >= 4 and any(in_bbox_xy(p) for p in ring):
                areas.append([kind, flat(simplify(ring, 0.6))])

    for way in ways.values():
        nl = way["nodes"]
        if way.get("tags") and len(nl) >= 4 and nl[0] == nl[-1]:
            add_area(way["tags"], [nl])
    for rel in rels.values():
        tg = rel.get("tags") or {}
        if tg.get("type") == "multipolygon" and area_type(tg) is not None:
            add_area(tg, stitch([ways[m["ref"]]["nodes"] for m in rel["members"]
                                 if m["type"] == "way" and m.get("role") != "inner" and m["ref"] in ways]))
    areas.sort(key=lambda a: a[0] == 1)  # pitches draw over parks
    roads = [[cls, nm, flat(simplify(pts, 0.5))] for cls, nm, pts in sorted(road_lines, key=lambda r: -r[0])]

    notices = []
    for loc in c3d_locations(args.c3d_dir, NOTICE_CAT):
        detail = c3d_detail(args.c3d_dir, loc["id"]) or loc
        shape = detail.get("shape") or loc.get("shape") or {}
        path = [xy(lng, lat) for lat, lng in (shape.get("path") or [])] if isinstance(shape, dict) else []
        if not in_bbox_xy(xy(loc["lng"], loc["lat"]), 0.002):
            continue
        notices.append({"name": loc["name"], "desc": " ".join(html_lines(detail.get("description")))[:400],
                        "pt": quant(xy(loc["lng"], loc["lat"])), "path": flat(path)})

    # ----- output -----
    out_places = []
    for pi, place in enumerate(places_kept):
        tags = buildings[place["bi"]]["tags"] if place["bi"] >= 0 else {}
        rec = {"id": place["id"], "name": place["name"], "type": place["type"], "pt": quant(place["pt"]),
               "ent": place["ent"]}
        for key in ("code", "addr", "aka", "rooms", "wc", "notices"):
            if place.get(key):
                rec[key] = place[key]
        if parse_int(tags.get("building:levels")):
            rec["levels"] = parse_int(tags["building:levels"])
        documented = [int(n) for wc in place.get("wc", []) for n in re.findall(r"\b(?:Floor|F)\s?(\d{1,2})\b", wc["d"])]
        documented += [int(room["f"]) for room in place.get("rooms", []) if room["f"]]
        if documented:
            rec["fmax"] = max(documented)  # highest floor U of T mentions; a lower bound when levels are unknown
        if place_height[pi][0] and args.massing_shp:  # estimated OSM heights are drawn but not stated as facts
            rec["h"] = round(place_height[pi][0], 1)
            rec["hmax"] = round(place_height[pi][1], 1)
        if place["bi"] >= 0 and not place_height[pi][0]:
            rec["ring"] = flat(simplify(buildings[place["bi"]]["rings"][0], 0.35))
        out_places.append(rec)
    out_entrances = []
    for e in entrances:
        rec = {"n": e["n"], "pt": quant(e["pt"]), "name": e["name"], "src": e["src"], "access": e["access"]}
        for key in ("desc", "powered", "lift"):
            if e[key]:
                rec[key] = e[key]
        out_entrances.append(rec)
    campus_places = [p for p in out_places if p["type"] == "building"]
    stepfree_places = sum(1 for p in campus_places if any(entrances[e]["access"] == "stepfree" for e in p["ent"]))
    counts = {
        "graphNodes": len(P), "graphEdges": len(edges), "walkWays": len(way_cols["kind"]),
        "stairWays": sum(1 for k in way_cols["kind"] if k == KIND["steps"]),
        "massing": len(mass), "massingVertices": mass_vertices, "places": len(out_places),
        "campusBuildings": len(campus_places), "campusWithStepFreeDoor": stepfree_places,
        "entrances": len(entrances), "officialEntrances": sum(1 for e in entrances if e["src"] in ("uoft", "uw")),
        "officialStepFree": sum(1 for e in entrances if e["src"] in ("uoft", "uw") and e["access"] == "stepfree"),
        "officialSteps": sum(1 for e in entrances if e["src"] in ("uoft", "uw") and e["access"] == "steps"),
        "osmEntrances": osm_entrances, "washrooms": washroom_count, "notices": len(notices),
    }
    transit = [p for p in out_places if p["type"] == "transit"]
    start = next((p["id"] for p in out_places if p["type"] == "venue"), None)
    if start is None and transit:
        start = next((p["id"] for p in transit if re.search(campus_cfg.get("start", "$."), p["name"], re.I)), transit[0]["id"])
    campus_ids = {p["id"] for p in campus_places}
    osm_use = "paths, stairs, crossings, streets, green space"
    sources = []
    if args.massing_shp:
        sources.append({"name": "City of Toronto Open Data, 3D Massing (2025)", "url": "https://open.toronto.ca/dataset/3d-massing/",
                        "licence": "Open Government Licence - Toronto", "use": "building footprints and heights"})
    else:
        osm_use += ", building footprints (building heights estimated from OpenStreetMap tags, 9 m where untagged)"
    if not args.c3d_dir:
        osm_use += ("" if args.buildings_geojson else ", building names") + ", entrances and their wheelchair tags"
    sources.append({"name": "OpenStreetMap contributors", "url": "https://www.openstreetmap.org/copyright",
                    "licence": "ODbL 1.0", "use": osm_use})
    official_use = [use for path, use in ((args.buildings_geojson, "building codes and names"),
                                          (args.accessible_entrances, "accessible entrances")) if path]
    if official_use and campus_cfg.get("official"):
        sources.append({**campus_cfg["official"], "use": ", ".join(official_use)})
    if args.c3d_dir:
        sources.append({"name": "University of Toronto campus map", "url": "https://map.utoronto.ca/",
                        "licence": "public map content, used with attribution",
                        "use": "building names, entrance descriptions, accessible washrooms, notices"})
    if args.cobalt:
        sources.append({"name": "Cobalt U of T datasets", "url": "https://github.com/cobalt-uoft/datasets",
                        "licence": "MIT", "use": "building codes and addresses"})
    doc = {
        "meta": {
            "campus": campus_cfg["name"], "bbox": [W, S, E, N], "generated": datetime.date.today().isoformat(),
            "counts": counts,
            "sources": sources,
            "id": args.campus, "short": campus_cfg["short"], "start": start,
            "picks": [pid for pid in campus_cfg["picks"] if pid in campus_ids][:4],
            "doorData": "official" if args.c3d_dir or args.accessible_entrances else "osm",
        },
        "names": names,
        "net": {"nodes": flat(P), "edges": [v for e in edges for v in e], "ways": way_cols,
                "nodeFlags": [v for item in sorted(nflags.items()) for v in item]},
        "mass": mass, "roads": roads, "areas": areas, "places": out_places, "entrances": out_entrances,
        "notices": notices,
    }
    if not args.massing_shp:
        doc["meta"]["heights"] = "estimated"  # lets the app avoid presenting OSM-derived heights as surveyed
    if access_meta:
        doc["meta"]["accessNotices"] = access_meta
        doc["meta"]["sources"].append({
            "name": "U of T Building Access Notices", "url": access_meta["source"],
            "licence": "public notices, used with attribution", "use": "entrance and elevator disruption history"})
    with open(args.out, "w") as f:
        json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)
    print(json.dumps(counts, indent=1))
    print("links", link_stats, "| dropped disconnected edges", dropped_edges, "| anchored without door", anchored,
          "| official doors skipped", official_skipped, "| venue", venue_source,
          "| campus codes not placed", len(campus_unplaced))
    print("output bytes", os.path.getsize(args.out))


if __name__ == "__main__":
    main()
