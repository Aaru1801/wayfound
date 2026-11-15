# Wayfound 3D — build contract

Three modules are built in parallel and must fit together without changes. If you need to
deviate, keep the exported names and shapes below and be tolerant of missing optional fields.

Static site, no build step, ES modules, no frameworks, no network calls at runtime.

```
index.html            app shell (owner: UI)
src/styles.css        all CSS (owner: UI)
src/app.js            state, panels, search, wiring (owner: UI)
src/map3d.js          MapLibre scene (owner: MAP)
src/engine.js         routing, search, audit; no DOM (owner: ENGINE)
tests/*.test.mjs      node --test (owner: ENGINE)
data/uoft.json        dataset (owner: lead; a partial west-campus build is there now, full build replaces it)
vendor/maplibre-gl.js|css   MapLibre GL JS 4.7.1 UMD, loaded by a <script> tag as global `maplibregl`
```

## Dataset (`data/<campus>.json`)

Written by `tools/build_campus.py` (read it for exact semantics). Coordinates are integers:
`lng = bbox[0] + x / 1e6`, `lat = bbox[1] + y / 1e6`. Flat arrays are `[x0,y0,x1,y1,...]`.

```
meta      { campus, bbox:[W,S,E,N], generated, counts:{...}, sources:[{name,url,licence,use}] }
names     string[]                       street/path names referenced by index
net.nodes int[]                          flat xy per graph node
net.edges int[]                          flat triples [a, b, wayIdx]
net.ways  { kind[], flags[], name[], near[], incline[], steps[], osm[] }   columns indexed by wayIdx
          kind: 0 footway 1 sidewalk 2 crossing 3 path 4 pedestrian 5 steps 6 cycleway 7 service 8 street 9 corridor 10 link(door connector) 11 elevator
          flags bits: 1 wheelchair=no, 2 limited, 4 yes, 8 rough surface, 16 unpaved, 32 sheltered,
                      64 steps with wheelchair ramp, 128 lit, 256 signalised crossing, 512 marked crossing, 1024 narrow
          name: index into names or -1; near: street a sidewalk follows / a crossing crosses, or -1
          incline: percent (0 unknown); steps: step count (0 unknown); osm: OSM way id (0 for links)
net.nodeFlags int[]                      flat pairs [nodeIdx, flags]; 1 = raised kerb/stile (blocks step-free), 2 = locked gate (blocks all)
mass      [[height_m, placeIdx|-1, campusFlag 0|1, outerRing, ...holeRings]]   City of Toronto 3D massing footprints
roads     [[class 0..4 (0 major, 4 service), nameIdx, line]]
areas     [[type 0 green|1 pitch|2 water|3 plaza|4 parking, ring]]
places    [{ id, name, type:'building'|'landmark'|'transit'|'venue', pt:[x,y], ent:int[] (entrance indexes),
             code?, addr?, rooms?:[{n,r,f}], wc?:[{n,d}], levels?, h?, hmax?, ring? }]
entrances [{ n: nodeIdx, pt:[x,y], name, src:'uoft'|'osm'|'none', access:'stepfree'|'steps'|'unknown', desc?, powered?, lift? }]
notices   [{ name, desc, pt:[x,y], path }]     official U of T closure notices (informational; pedestrian paths stay open)
```

`type:'building'` places are U of T buildings with a `code` (BA, RL, HH...). The venue is `id:'venue'`.
`rooms` are offices U of T publishes for the building (`r` room number, or `f` floor). `wc` are accessible washrooms
(`d` holds "Floor 2, Room 207" style text). Entrance `desc` is U of T's own written description of the door.

## ENGINE — `src/engine.js`

Pure ES module. Must run in Node (tests) and the browser. No DOM, no fetch.

```js
export const KIND, FLAG;                       // enums matching the dataset
export const PROFILES = [                      // order matters for the UI
  { id:'walk',     label:'Walking',      speed: 80 },   // metres per minute
  { id:'gentle',   label:'Fewer stairs', speed: 68 },
  { id:'stepfree', label:'Step-free',    speed: 60 },
];
export function createCampus(dataset)          // throws Error with a clear message on a malformed dataset
```

`campus` (everything synchronous except `audit`):

```js
campus.meta, campus.names, campus.notices
campus.places     // dataset places, each augmented with: index, lngLat:[lng,lat]
campus.entrances  // dataset entrances, each augmented with: index, lngLat, places:int[]
campus.toLngLat([x,y]) -> [lng,lat]
campus.decodeLine(flat) -> [[lng,lat],...]
campus.nodeLngLat(nodeIdx) -> [lng,lat]

campus.search(text, { limit = 8 } = {}) -> [{ placeIndex, title, subtitle, kind:'place'|'room'|'office',
                                              room?: { label, floor, floorLabel } }]
    // "BA", "bahen", "BA 1130", "ba1130", "robarts", office names from place.rooms. Best match first. [] for empty text.
campus.parseRoom(text) -> { code, room, floor, floorLabel } | null
    // U of T convention: 4 digits -> first digit is the floor; 5 digits -> first two; leading B -> basement.
campus.floorsOf(placeIndex) -> { levels:int, source:'osm'|'estimated'|'unknown', height:number|null }
    // 'estimated' = max(round(height / 4.6), place.fmax || 1). `fmax` is the highest floor U of T mentions for the building.

campus.route({ from, to, profile = 'walk', closedEdges, closedEntrances }) -> Route | Failure
    // from/to: placeIndex (number) or { lngLat:[lng,lat] } for a dropped pin. closedEdges/closedEntrances: iterable of indexes.
Failure = { ok:false, reason:'same'|'bad-input'|'no-stepfree-entrance'|'unreachable', message }
Route = { ok:true, profile, from, to,
          distance,                 // metres, real length (not cost)
          duration,                 // minutes at the profile speed, plus stair time
          coords: [[lng,lat],...],  // door to door
          edges: int[],             // edge indexes in travel order
          steps: [{ type:'depart'|'walk'|'cross'|'stairs'|'ramp'|'arrive', text, distance, coords, edges:[i,j] }],
                                    // edges:[i,j] = slice of route.edges. Text is plain English, no HTML.
          stairs: { flights, steps },             // steps = sum of known step counts
          entrance: { from: entranceIdx|null, to: entranceIdx|null },
          warnings: string[],       // e.g. unverified door, manual door, unpaved stretch
          flags: { unverifiedDoor, manualDoor, usesLift, roughMeters } }

campus.segmentOf(edgeIdx) -> int[]              // the stretch between junctions containing this edge (what a barrier closes)
campus.nearestEdge([lng,lat], maxMeters = 30) -> { edge, distance, lngLat } | null   // never returns link edges
campus.edgeLine(edgeIdx) -> [[lng,lat],[lng,lat]]
campus.edgeInfo(edgeIdx) -> { kind, kindLabel, name, length, flags, osmWay }
campus.stairWays() -> [{ id, edges:int[], lngLat, steps, length, ramp:boolean }]

campus.audit({ closedEdges, closedEntrances, onProgress } = {}) -> Promise<Audit>
    // All pairs of type:'building' places, walk vs step-free. Yields to the event loop; onProgress(done, total).
Audit = { buildings, journeys,      // all U of T buildings; journeys = n(n-1)/2
          buildingsWithDoor,        // buildings with a documented step-free entrance
          audited,                  // pairs where both buildings have one; everything below is over these
          reachable, unreachable,   // audited pairs with / without a step-free path
          detoured,                 // reachable pairs where step-free is at least 40 m longer than walking
          meanWalk, meanStepfree, meanExtra, totalExtra,       // over reachable pairs
          worst: [{ a, b, walk, stepfree, extra }],            // top 10 by extra, placeIndexes
          noStepFreeDoor: int[],    // buildings with no documented step-free entrance
          stairsOnly: int[],        // subset whose every documented entrance has stairs
          places: [{ placeIndex, meanExtra, detouredShare, reachable }],
          fixes: [{ id, type:'stairs', edges:int[], lngLat, label, steps, length,
                    savedMeters, journeys, maxSaving, newlyConnected, example:{ a, b, before, after } }],  // top 15
          elapsedMs }
```

Routing rules:

- Places route door to door: start at the best eligible entrance of `from`, end at the best of `to` (multi-source/multi-target).
- Entrance eligibility. walk/gentle: any entrance (gentle adds a 40 m penalty to `access:'steps'` doors).
  stepfree: only `access:'stepfree'`; a non-powered door costs +15 m and sets `flags.manualDoor`. If a place has no
  step-free door but has `unknown` ones, use those and set `flags.unverifiedDoor` + a warning. If it only has `steps`
  doors, return `no-stepfree-entrance`. `closedEntrances` are never used.
- Edges. walk: everything except locked-gate nodes; cost = length x (steps 1.5, street/service 1.25, others 1).
  gentle: steps cost length x 3 + 40 m per stair way. stepfree: forbid steps (unless flag 64), wheelchair=no, narrow,
  raised-kerb nodes, incline > 8; unpaved x1.6, rough x1.3, limited x1.5. Link edges (kind 10) always cost their length.
- Duration: distance / speed + 0.5 s per known step (assume 12 steps for unknown flights).
- Fix-first ranking: candidate = each stair way without a ramp. Saving is exact via
  `d'(A,B) = min(d(A,B), d(A,u) + L + d(v,B), d(A,v) + L + d(u,B))` using stored step-free distance arrays per building.

## MAP — `src/map3d.js`

```js
export async function createMap3D({ container, campus, dataset,
                                    onPlaceClick, onPathClick, onMapClick, onHighlightClick }) -> view
    // resolves once the style has loaded. Handlers are optional.
    // onPlaceClick(placeIndex, lngLat)   click on a named building or its label
    // onPathClick(edgeIdx, lngLat)       click near a path while report mode is on
    // onMapClick(lngLat)                 any other click
    // onHighlightClick(id)               click on a numbered highlight badge

view.map                                  // maplibregl.Map
view.setPadding({ top, right, bottom, left })      // screen area covered by panels; used by every camera move
view.setRoute(route | null, { ghost = null } = {}) // main route + optional dashed comparison route
view.fitRoute(route)
view.setMarkers({ from, to })             // each { lngLat, label } | null
view.flyToPlace(placeIndex)
view.focusPlace(placeIndex | null, { levels, active } = {})
    // hides that building's massing, draws it as stacked floor plates, `active` (1-based, 0 = basement) glows;
    // shows its entrance dots coloured by access. null restores.
view.setClosures([{ id, edges:int[], lngLat }])    // reported barriers: coral segments + cross markers
view.setHighlights([{ id, edges:int[], lngLat, rank }] | null)   // audit fixes: amber stairs + numbered badges
view.setReportMode(boolean)               // crosshair; hovering a path highlights campus.segmentOf(edge)
view.flyThrough(route) -> Promise<void>   // camera follows the route; resolves at the end or when stopped
view.stopFlyThrough()
view.resetView()
```

No base-map tiles and no glyph server: every layer is built from the dataset (background, areas, roads, paths,
massing as fill-extrusion, labels as canvas-rendered images in a symbol layer). Must work offline and from `file://`.

## UI — `index.html`, `src/app.js`, `src/styles.css`

`index.html` loads `vendor/maplibre-gl.css`, `src/styles.css`, `vendor/maplibre-gl.js` (classic script), then
`<script type="module" src="src/app.js">`. `app.js` fetches `data/uoft.json` unless `window.WAYFOUND_DATA` is already
set (the offline single-file build inlines it), then `createCampus`, then `createMap3D`.

## Visual language (shared by MAP and UI)

Dark, calm, high contrast. System font stack (`ui-sans-serif, -apple-system, "SF Pro Text", "Segoe UI", sans-serif`),
tabular numerals for metrics, nothing under 12px.

```
--bg #0b1016   --panel rgba(17,23,31,.94)   --panel-border rgba(255,255,255,.09)   --radius 14px
--text #e9eef3   --muted #9aa8b5   --faint #64717e
--route #5ef2a0 (step-free / primary)   --walk #8fb4ff (walking comparison)
--stairs #ffb454 (stairs, cautions)     --barrier #ff6b5e (closures, failures)

map: ground #0d1319, green #12251d, water #0f2a3c, plaza #151d26, roads #1c2631 (major #25313e),
     paths #3a4756, context buildings #1b242e, campus buildings #3a4b5f (hover/selected #55708f)
```

## Addendum: final shape (15 Nov, afternoon)

The interface is U of T only and minimal. Two more campuses are built and tested but have no visible switch.

- One dataset per campus in `data/`: `uoft.json` (default), `waterloo.json`, `mcmaster.json`, all in the schema
  above. The address hash `campus=<id>` selects one; the offline build embeds every file in `data/` as
  `window.WAYFOUND_DATA[<file name>]`.
- New `meta` fields in every dataset: `id`, `short`, `start` (place id used as the default From), `picks` (up to
  four place ids for quick-pick chips), `doorData` (`'official'` when doors come from the university's own data,
  `'osm'` when OpenStreetMap door tags are all there is) and optional `view` (`{center, zoom, pitch, bearing}`).
- Entrance `src` is `'uoft'` (U of T campus map description), `'uw'` (University of Waterloo open data, accessible
  entrance), `'osm'` or `'none'`.
- `campus.audit()` returns `doorPolicy`: `'verified'` (only doors known to be step-free count) unless
  `meta.doorData` is `'osm'`, when it is `'mapped'` (every door not known to have steps counts, so the audit
  measures the paths between buildings).
- `parseRoom(text, isCode)` accepts building codes of 2 to 5 characters (E7, QNC, RCH); `isCode` resolves the
  split when there is no space. A former code listed in `aka` still finds the building.
- A transit stop or landmark never raises the unverified-door warning; only buildings and the venue do.
- Map labels: code chips until zoom 17, full names closer in. The venue badge hides while a journey marker sits on
  the venue.
- Interface rule: the default state shows only what a journey needs. Directions, door details, floors, warnings,
  place details and the longer audit lists stay hidden until their button is pressed. The guided demo, the notice
  toast and copy-link were removed.
