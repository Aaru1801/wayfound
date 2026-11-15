# Wayfound at Waterloo and McMaster

**One-line pitch** — Wayfound lets people edit a campus walking route, find a room’s building, and see how a closure could change step-free access.

## Presentation and live demo

**0:00–0:35 · The problem**

“Imagine you’re going from the bus stop to the library. You need a route without stairs. You get to the lift and find it out of service. Can you still make it to the library, and how far is the detour?”

“Wayfound focuses on the University of Waterloo and McMaster University. You can edit a walking route on the campus map, look up the building for a room, and use the university floor plan. In the step-free simulation, you can explore how a closure changes a trip.”

**0:35–2:20 · Live demo**

| Time | On screen | What to say |
| --- | --- | --- |
| 0:35–0:50 | Select **Waterloo** and click **Try the 60-second demo**. Point to the start, the library, and **Step-free**. | “These are places on Waterloo’s campus. The paths and distances are illustrative. The route uses the options available to this travel profile.” |
| 0:50–1:05 | Click **Break the lift**. Point to the changed route and distance. | “Closing the lift removes that connection from the model. The route recalculates through the ramp.” |
| 1:05–1:20 | Click **Close the ramp too**. | “With both connections closed, the model can’t find a route that meets the user’s needs.” |
| 1:20–1:45 | Click **See repair impact**, compare the cards, and restore a connection. | “The app tests each repair on its own. Here’s what reopening this connection brings back within reach.” |
| 1:45–2:20 | Close the dialog, select **McMaster**, and open **Maps & rooms**. Search for a room and choose **Route here**. Drag a pin, add a stop, then remove it. Point out how the route and distance change. | “This walk follows mapped paths, and the route redraws here as we edit it. The floor plan covers the indoor portion.” |

The Waterloo demo goes from University of Waterloo ION Station to Dana Porter Library, **420 m → 570 m → no compatible route**. The McMaster demo goes from McMaster GO Bus Terminal to Mills Memorial Library, **470 m → 810 m → no compatible route**. All distances are simulated.

**2:20–2:50 · How it works**

“The walking editor snaps pins to an OpenStreetMap network and finds a shortest path through the selected stops. The browser calculates each leg and redraws the route without a directions service. The simulation uses its own graph and filters connections by mobility settings and closure state. To compare repairs, we reopen one connection at a time and see which destinations become reachable.”

**2:50–3:30 · Where it could go**

“The demo shows what a closure could mean for a student, and gives facilities staff a way to see who might benefit from a repair. A real pilot would start on one surveyed route, with people who use mobility aids and with facilities staff. We’d check the paths and instructions together and connect them to up-to-date outage records. Every connection, route measurement, and outage in the simulation is illustrative.”

“OpenAI Codex assisted with research, planning, development, tests, and pitch preparation. The route calculations use an explicit graph algorithm.”

## Devpost description

### Inspiration

A lift outage can change whether a student can reach a library, even when the building still looks reachable on a map. We wanted to show how a route planner can react to access barriers and how the same model can help compare repairs.

### What it does

Wayfound is a browser prototype for the University of Waterloo and McMaster University. In **Maps & rooms**, drag the start and destination pins, add or remove stops, and see the outdoor walking route update in the app. A room result can set its building as the destination and link to the university’s indoor references. A Google map is available as an optional campus reference.

In the simulation, choose a campus, destination, and mobility profile, then close a connection. Wayfound recalculates the shortest compatible route or reports that no compatible path is available. The repair comparison shows which destinations become reachable when each connection reopens.

### How we built it

The outdoor editor uses Leaflet and a bundled OpenStreetMap path network. Pins snap to mapped paths, and the browser computes a shortest route for each leg. Each simulation uses a separate weighted graph of landmarks and modeled connections. The app filters edges by mobility constraints and closure state, then uses Dijkstra’s algorithm to calculate shortest distance. It computes repair impact by adding each unavailable edge back in isolation and comparing reachability. The browser handles calculations and local demo reports.

### Scope and next steps

The simulation uses real landmark names and illustrative connections, distances, slopes, travel times, and closures. The outdoor editor uses a snapshot of mapped walking paths, which may include stairs. Route here takes you to the room’s building. Campus room coverage varies, and Waterloo’s floor plans may require WatIAM. A pilot for verified step-free directions would start by surveying one route with users and facilities staff and testing its directions with people with different access needs. [OpenStreetMap data and license](https://www.openstreetmap.org/copyright)

See the universities’ map resources. [Waterloo campus map](https://uwaterloo.ca/map//), [Waterloo floor plans](https://uwaterloo.ca/plant-operations/floor-plans), [McMaster Discover map](https://discover.mcmaster.ca/map/), [McMaster Accessible Building Maps](https://www.mcmaster.ca/uts/maps/).

### AI disclosure

OpenAI Codex assisted with event and campus research, project planning, implementation, interface development, debugging, test creation and execution, and writing the pitch and submission copy. An explicit graph algorithm calculates routes. Update this disclosure to reflect any additional AI tools actually used.

## Before submitting

- Rehearse from a reset state. Read distances and reachability counts from the app.
- Include your source repo, updated project images, and an optional demo video. Each teammate must join using the email from their application. [ONHacks rules](https://onhacks.devpost.com/rules)
- Make sure the entry says **Submitted** by **November 15, 2026, at 5:00 p.m. Toronto time**. Judges use a five-minute pitch and give equal weight to Creativity, Technical, Pitch, and Impact. [ONHacks overview](https://onhacks.devpost.com/)
- Disclose the AI tools and how you used them. The Copilot prize requires actual Copilot use. [ONHacks AI policy](https://onhacks.devpost.com/resources)
