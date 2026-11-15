# Wayfound

Wayfound is a browser prototype for mobility-aware routing at the **University of Waterloo** and **McMaster University**. It combines an editable outdoor walking map, room references, and a separate step-free closure simulation.

## Maps & rooms

Select a campus in **Maps & rooms**. Choose landmarks from the start and destination menus, drag either pin, or add a stop on the map. Move or remove stops to adjust the journey. The route and distance update in the app.

Room results link to university references. Choose **Route here** to set the room’s building as the outdoor destination. Use the floor plan for the indoor portion where available. The **Google Maps reference** is an optional campus map.

- **Waterloo** provides an [interactive campus map](https://uwaterloo.ca/map//) and [Plant Operations floor plans](https://uwaterloo.ca/plant-operations/floor-plans). Floor plans may require a [WatIAM sign-in](https://uwaterloo.ca/accessibility/getting-around).
- **McMaster** provides the [Discover campus map](https://discover.mcmaster.ca/map/) and [Accessible Building Maps](https://www.mcmaster.ca/uts/maps/) for indoor room and floor references.

## Try the simulated route

1. Select either campus and click **Try the 60-second demo**.
2. Review the Step-free route from the default starting point to the library.
3. Click **Break the lift** and follow the detour on the map.
4. Click **Close the ramp too** to see the no-compatible-route result.
5. Click **See repair impact**, then restore a connection and check the route again.
6. Switch campuses to try the other route network.

| Campus | Demo journey | Step-free model | Lift closed |
| --- | --- | ---: | ---: |
| University of Waterloo | ION Station → Dana Porter Library | 420 m | 570 m |
| McMaster University | GO Bus Terminal → Mills Memorial Library | 470 m | 810 m |

Closing the lift and ramp makes the demo library unreachable for the default step-free profile. Each campus stores its simulated closures separately. Share links include the selected campus and route preferences.

## Run and test

Open `dist/offline.html` directly in a browser. The bundled path network supports route edits and calculations offline. Background map tiles, the Google Maps reference, and university floor-plan pages need internet access. The hosted version is owner-private.

- Run `npm start` with Python 3, then open `http://127.0.0.1:4173`.
- Run `npm test` with Node.js 20+ for the routing tests.
- Run `npm run build` after editing source to regenerate the offline HTML.

`dist/` can be served by any static web host. The prototype uses plain HTML, CSS, JavaScript modules, SVG, and a bundled copy of Leaflet.

## How it works

The outdoor editor snaps each pin to the bundled OpenStreetMap path network and calculates a shortest walk for each leg in stop order. Leaflet draws the editable pins, paths, and optional background tiles.

The closure simulation uses a separate graph with modeled distance, slope, surface, and accessibility attributes. It filters edges using the selected constraints and closures, then uses Dijkstra’s algorithm to find the shortest compatible distance. Its travel time estimates use profile speed and an allowance for each lift.

Repair impact recalculates reachability with one closed connection restored at a time. Barrier reports are simulated and stay in the browser. They expire after one hour and persist in local storage when available.

## Data and scope

The closure simulation uses real campus landmarks. Its routes, distances, travel times, slopes, lift and ramp placements, and outages are illustrative. A real step-free routing pilot would start with one surveyed route and involve people with different access needs and facilities staff.

Outdoor walking uses a snapshot of mapped paths. It can include stairs, and conditions or access may have changed. Room results lead to the building, with indoor details available from the university.

- Outdoor path and pin data are © OpenStreetMap contributors and available under the [Open Database License (ODbL)](https://www.openstreetmap.org/copyright). The dataset is in `dist/outdoor-network.mjs`. Refresh it with `python3 scripts/refresh-outdoor-data.py`. The script accepts `--source-dir` to reuse existing OpenStreetMap extracts.
- Leaflet is distributed under the BSD 2-Clause License in `dist/vendor/leaflet/LICENSE`.

## AI disclosure

OpenAI Codex assisted with event and campus research, planning, implementation, interface work, debugging, tests, and presentation copy. Route calculations use an explicit graph algorithm. Update this disclosure if the final project uses additional AI tools.

## ONHacks submission

`ONHACKS-PITCH.md` contains the presentation, live walkthrough, and Devpost copy. The official submission deadline is **November 15, 2026, at 5:00 p.m. Toronto time**. The participating team must complete submission and confirm its entry is marked **Submitted**. [Event overview](https://onhacks.devpost.com/) · [Rules](https://onhacks.devpost.com/rules) · [AI policy](https://onhacks.devpost.com/resources)
