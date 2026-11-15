# Data: sources, licences and rebuild commands

Each campus is one file in `data/`, produced by `tools/build_campus.py`. Raw downloads go under `dev/`, which is
git-ignored. The app never fetches any of this at runtime.

## Sources and licences

- **OpenStreetMap** (all campuses): paths, stairs, crossings, kerbs, streets, green space, and building footprints
  for Waterloo and McMaster. © OpenStreetMap contributors, Open Database Licence (ODbL).
  https://www.openstreetmap.org/copyright
- **University of Waterloo open data** (Waterloo): building codes and names, and the accessible-entrance layer.
  Published by the university on its public ArcGIS service, used with attribution.
  https://services5.arcgis.com/z87D0RdgTttiUQbV/arcgis/rest/services/v2_UWaterloo_Open_Data/FeatureServer/1
- **City of Toronto Open Data, 3D Massing 2025** (U of T): building footprints and heights. Contains information
  licensed under the Open Government Licence – Toronto. https://open.toronto.ca/dataset/3d-massing/
- **University of Toronto campus map** (U of T): building names, written entrance descriptions, accessible
  washrooms. Public map content, used with attribution. https://map.utoronto.ca/
- **U of T Building Access Notices** (U of T): a dated snapshot of entrance and elevator notices, listed under a
  building's Details. https://notices.aoda.utoronto.ca/browse/
- **Cobalt U of T datasets** (U of T): building codes and addresses. MIT licence.
  https://github.com/cobalt-uoft/datasets
- **MapLibre GL JS 4.7.1**: vendored under `vendor/` with its BSD 3-Clause licence.

Wayfound is a student prototype. It is not affiliated with or endorsed by any of these universities.

## How doors are classified

| Source (`src`) | Step-free when | Otherwise |
| --- | --- | --- |
| `uw` Waterloo accessible-entrance layer | always: the university lists it as accessible | not applicable |
| `uoft` U of T entrance description | the text describes a ramp or a level approach | stairs with no ramp is `steps`; unclear text is `unknown` |
| `osm` OpenStreetMap entrance | tagged `wheelchair=yes` | `wheelchair=no` is `steps`; untagged is `unknown` |
| `none` | never | a building with no mapped door gets a snap point on the nearest path, `unknown` |

Step-free routes use `stepfree` doors. If a building has none, the route uses an `unknown` door and says it is
unverified. If every door is `steps`, there is no step-free route to that building.

## Rebuild Waterloo

```sh
mkdir -p dev/cache
python3 tools/fetch_osm.py dev/cache/osm_waterloo 43.4640 -80.5580 43.4790 -80.5325 3
UW="https://services5.arcgis.com/z87D0RdgTttiUQbV/arcgis/rest/services"
curl -sS -o dev/cache/uw_buildings.geojson "$UW/BuildingsView/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson"
curl -sS -o dev/cache/uw_entrances.geojson "$UW/v2_UWaterloo_Open_Data/FeatureServer/1/query?where=1%3D1&outFields=*&outSR=4326&f=geojson"
python3 tools/build_campus.py --campus waterloo --osm-dir dev/cache/osm_waterloo \
  --buildings-geojson dev/cache/uw_buildings.geojson --accessible-entrances dev/cache/uw_entrances.geojson \
  --out data/waterloo.json
```

## Rebuild McMaster

```sh
python3 tools/fetch_osm.py dev/cache/osm_mcmaster 43.2560 -79.9290 43.2712 -79.9085 3
python3 tools/build_campus.py --campus mcmaster --osm-dir dev/cache/osm_mcmaster --out data/mcmaster.json
```

## Rebuild U of T

The massing file is about 81 MB. It is named WGS84 but its coordinates are Web Mercator; the build converts them.

```sh
mkdir -p dev/cache/osm dev/cache/massing dev/cache/uoft/loc
python3 tools/fetch_osm.py dev/cache/osm

curl -L -o dev/cache/massing/massing.zip "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/387b2e3b-2a76-4199-8b3b-0b7d22e2ec10/resource/667237d6-4d3c-4cf3-8cb7-e91c48d59375/download/3dmassingshapefile_2025_wgs84.zip"
unzip -o dev/cache/massing/massing.zip -d dev/cache/massing

# map.utoronto.ca is a Concept3D map (id 1809). Set C3D_KEY to the public key the map's own web client
# sends (open the map and look at its api.concept3d.com requests); it is not reproduced here.
# Categories: entrances 48650 (powered) and 48649, buildings 48654, transit 50079, closures 64738,
# accessible washrooms 50112 50113 50114 48701 48702 48704.
C3D="https://api.concept3d.com"; Q="map=1809&key=$C3D_KEY"
for id in 48650 48649 48654 50079 64738 50112 50113 50114 48701 48702 48704; do
  curl -sS -o "dev/cache/uoft/c3d_cat_$id.json" "$C3D/categories/$id?$Q&children"
done
python3 - > dev/cache/uoft/loc_ids.txt <<'EOF'
import glob, json
ids = set()
for path in glob.glob("dev/cache/uoft/c3d_cat_*.json"):
    for loc in (json.load(open(path)).get("children") or {}).get("locations") or []:
        if 43.650 < loc["lat"] < 43.674 and -79.409 < loc["lng"] < -79.380:
            ids.add(loc["id"])
print("\n".join(str(i) for i in sorted(ids)))
EOF
(cd dev/cache/uoft/loc && xargs -P 8 -I{} curl -sS -o "{}.json" "$C3D/locations/{}?$Q" < ../loc_ids.txt)

curl -sS -o dev/cache/uoft/cobalt_buildings.json https://raw.githubusercontent.com/cobalt-uoft/datasets/master/buildings.json
python3 tools/fetch_notices.py dev/cache/notices.json   # optional

python3 tools/build_campus.py --campus uoft --osm-dir dev/cache/osm \
  --massing-shp dev/cache/massing/3DMassingShapefile_2025_WGS84.shp \
  --c3d-dir dev/cache/uoft --cobalt dev/cache/uoft/cobalt_buildings.json \
  --notices dev/cache/notices.json --out data/uoft.json
```

After any rebuild run `npm test` and `npm run build:offline`.
