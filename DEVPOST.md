# Devpost copy — paste section by section

**Project name:** Wayfound

**Tagline (short):** The shortest route is not everyone's route. Door-to-door step-free navigation for U of T on a 3D campus built from open data, plus an audit that shows which single fix would help the most people.

**Built with:** JavaScript, MapLibre GL JS, Python, City of Toronto Open Data, OpenStreetMap, HTML, CSS

**Try it out:** https://aaru1801.github.io/wayfound/

**Code:** https://github.com/Aaru1801/wayfound

**Screenshots:** `docs/screenshots/` (five images, in order)

---

## Inspiration

ONHacks is at Polish Combatants' Hall, on the edge of the University of Toronto. Any map app will tell you Hart House is a twelve-minute walk from here. None of them will tell you that its main entrance is, in U of T's own words, "very heavy powered doors at the top of an exterior stairway", or which other door has the ramp.

That sentence is public. U of T publishes a written accessibility description for 346 building entrances on this campus, pinned to a map, one marker at a time. Nobody routes on it. If you use a wheelchair, push a stroller, or are on crutches for a month, you read prose and plan in your head.

We wanted the route to already know.

## What it does

Wayfound is a door-to-door campus navigator for U of T St. George.

- **Routes to the right door, not the building.** Pick a profile (Walking, Fewer stairs, Step-free). Step-free routes avoid mapped stairs and raised kerbs and end at an entrance that U of T documents as step-free. One button shows the university's own description of that door, and whether it has a power operator.
- **A real 3D campus.** Every building is extruded from the City of Toronto's 3D Massing open data. There are no map tiles: the whole scene is drawn from open data and works offline.
- **Floors.** Type a room like `BA 1130` and Wayfound resolves the building and floor from U of T's room-numbering convention, slices the building into floor plates and lights up yours.
- **Barriers.** Tap any path to report a barrier. The route recalculates immediately and tells you what the detour costs.
- **Access audit.** One click compares walking and step-free routes for every pair of U of T buildings, then ranks which single staircase, if it had a ramp, would shorten the most step-free journeys.
- **Details on request.** The screen stays minimal: distance, time and the door. Directions, door details, floors, warnings, and each building's doors, accessible washrooms and recent U of T access notices open from their own buttons.

## How we built it

**Data pipeline (Python, standard library only).** One script merges four public sources into a single 1.4 MB file:

- City of Toronto Open Data, 3D Massing 2025: 3,667 building shapes with heights in our area.
- OpenStreetMap: an 11,000-node pedestrian graph with 210 stairways, crossings, kerbs and surfaces.
- U of T's campus map: 170 buildings, 346 entrance descriptions, 67 accessible washrooms.
- U of T Building Access Notices: 410 elevator and entrance notices, matched to buildings.

Entrance descriptions are prose, so the pipeline classifies each door as step-free, stairs or unverified with conservative rules. A door described as a "level path" that also mentions steps is marked unverified, not step-free.

**Routing engine (JavaScript, no dependencies).** Dijkstra over typed arrays with multi-source, multi-target search, so a trip starts at the best eligible door of one building and ends at the best eligible door of the other. Each profile has its own edge rules.

**The audit.** Ranking fixes naively means re-running every route for every candidate staircase. Instead we store the step-free distance from every building to every node once. Opening staircase (u, v) of length L changes a journey to `min(d(A,B), d(A,u) + L + d(v,B), d(A,v) + L + d(u,B))`, which is exact and costs one lookup. All 14,365 journeys and every candidate fix finish in under a second in the browser.

**3D map (MapLibre GL JS).** A style with no tile sources. Buildings are fill-extrusions from the massing data, labels are rendered to canvas so no font server is needed, and the camera can fly the route.

## Challenges we ran into

- The public OpenStreetMap query servers were saturated during the event, so we switched to tiled downloads from the main API and merged them.
- The City's "WGS84" shapefile is actually in Web Mercator. We wrote a small shapefile reader and reprojected it.
- Door facts are locked in sentences like "5 steps up to powered doors; an outdoor ramp is located to the left of the stairs". Getting that right without over-claiming took several passes.
- Ranking fixes exactly without recomputing 14,000 routes per candidate.

## Accomplishments that we're proud of

- It is real. Every building, path, door description and notice comes from a public source, and the app says which.
- The audit produces a finding: on today's data, the single most valuable fix on campus is the staircase beside Hart House.
- It runs offline from one HTML file, which matters at a hackathon venue.
- It stays out of the way. The screen shows the route, the distance and the door; directions, door details, floors and warnings each open from their own button.

## What we learned

Accessibility data mostly exists already. It is scattered across a city portal, a volunteer map and a university website, in three formats, and the hard part is joining it honestly.

## What's next for Wayfound

- More campuses in the interface. The same pipeline already builds the University of Waterloo, using the university's own open data (66 buildings, 65 accessible entrances), and McMaster from OpenStreetMap alone. Both datasets ship with the project and pass the same tests; they are reachable with `#campus=waterloo` and `#campus=mcmaster`.
- Live elevator outages feeding the router, not only shown as history.
- Indoor routing where institutions can share floor plans.
- Giving facilities teams the audit, so capital fixes go where they shorten the most journeys.

## Honest limits

Outdoor pedestrian network only. Floors come from the room-number convention and building height, not floor plans. OpenStreetMap paths can be incomplete. Door facts are U of T's descriptions as of the build date. Not a safety-critical navigation aid.

## AI disclosure

Built with AI coding assistance (Claude Code). Routing and the audit are deterministic graph algorithms; there is no AI model in the running app.
