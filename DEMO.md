# Wayfound: the three-minute demo

## Before you present

- Run `npm start` and open http://127.0.0.1:4310 full screen.
- Keep `Wayfound.html` open in a second tab. It is the same app in one offline file, so venue Wi-Fi cannot break
  the demo.
- Look at each tab once before you start: the 3D map finishes loading only while its tab is visible.
- The start point is already Polish Combatants' Hall, the room you are standing in.

## Hook (15 seconds)

> We are standing in Polish Combatants' Hall, on the edge of U of T. Ask a map for the way to Hart House and it
> sends you to the main entrance, which U of T itself describes as "very heavy powered doors at the top of an
> exterior stairway". If you use a wheelchair, that route does not exist. The shortest route is not everyone's
> route, so we built the map that knows the difference, door by door.

## Live demo (about two minutes)

| Time | Do | Say |
| --- | --- | --- |
| 0:15 | In **To**, type `Hart House`. Leave **Walking** selected. | "Walking: 906 metres, ending at the main entrance, up a stair flight." |
| 0:30 | Switch to **Step-free**. Press **Door details**. | "Step-free ends at a different door: the Arbor Room entrance, a powered door at the bottom of a ramp. That is U of T's own sentence. We read all 346 entrance descriptions U of T publishes and turned them into routing rules." |
| 0:50 | Press **Fly the route**, then stop after a few seconds. | "This is the exact path, door to door, through the City of Toronto's 3D model of campus." |
| 1:05 | In **To**, type `MS 2158`. Press **Floors**. | "A room number in; the building, the right door and the floor out. Here the step-free route is 133 metres longer than walking." |
| 1:25 | Press **Report a barrier**, then click the green route on the map. Afterwards press **Clear barriers**, so the audit numbers below match. | "A path is blocked. Wayfound reroutes at once." |
| 1:45 | Press **Access audit**, then **Run audit**. | "One journey is an anecdote. This routes every pair of buildings twice, walking and step-free. 47% of step-free journeys are longer than walking." |
| 2:10 | Open the first row under **Fix first**. | "And this is the part nobody else has: every stairway on campus, ranked by how much step-free travel a ramp there would give back. It is exact, not an estimate. Number one is the stairs beside Hart House." |
| 2:35 | Close. | "It is all open data, it runs offline from one file, and the same pipeline already builds Waterloo and McMaster." |

The interface shows only the essentials. Directions, door details, floors and warnings each open from their own
button, so you choose what the judges see.

## Numbers you will see

These come from the bundled dataset (generated 2026-11-15) and the current engine. The screen is the source of truth.

| | |
| --- | --- |
| Venue to Hart House, walking | 906 m, one stair flight, main entrance |
| Venue to Hart House, step-free | 925 m, no stairs, Arbor Room accessible entrance |
| Venue to MS 2158 | 521 m walking, 654 m step-free, floor 2 |
| Step-free journeys audited | 5,253, between the 103 buildings with a documented step-free door |
| Longer than walking by 40 m or more | 2,460 of them (47%) |
| Average step-free detour | 55 m |
| Buildings with no documented step-free entrance | 67 of 170 |
| Top fix | the stairs beside Hart House: about 22.9 km of step-free travel saved across 802 journeys |

## Strongest technical point

The fix-first ranking is exact and cheap. Scoring a fix the obvious way means re-routing every pair of buildings
with that stairway made step-free, for every candidate. Wayfound stores one step-free shortest-path tree per
building instead. A fixed stairway is one new edge between its ends `u` and `v`, and a shortest path crosses a new
edge at most once, so the best distance from A to B after the fix is

```
min( d(A,B),  d(A,u) + L + d(v,B),  d(A,v) + L + d(u,B) )
```

All three terms are already stored, so each candidate costs one lookup per pair of buildings. The tests check the
ranking against a brute-force recomputation. In Chrome on this laptop the whole audit takes about 0.4 seconds.

## Five questions judges may ask

**Where does the data come from?** Public sources, merged offline. Building shapes and heights: City of Toronto
3D Massing. Paths, stairs and crossings: OpenStreetMap. Building names and the written description of every
entrance: U of T's campus map. Building codes: the Cobalt dataset. Nothing is fetched while the app runs.

**How do you know a door is step-free?** We do not guess from geometry. U of T writes a description for each
entrance and the pipeline classifies it with conservative rules: a ramp or level approach is step-free, stairs
without a ramp is stairs, anything unclear stays unverified and is labelled so. Of 346 documented entrances,
184 are step-free, 146 are stairs and 16 are unclear. The original sentence is one button away.

**Why is the ranking exact?** Adding one edge changes a shortest path only by routing through that edge once, so
the new distance is the minimum of the old one and the two ways through the edge. It is exact for a single fix
under our routing model. We do not claim that savings from several fixes add up.

**Does it work beyond U of T?** Yes. The same pipeline has built the University of Waterloo, using the
university's own open data (66 buildings, 65 accessible entrances), and McMaster from OpenStreetMap alone. Add
`#campus=waterloo` or `#campus=mcmaster` to the address to show them.

**What is real and what is inferred?** Real: building shapes, paths and stairs, U of T's door descriptions.
Inferred: each door's class (rules over U of T's text), the floor of a room (from its number), the last few metres
from a door to the nearest mapped path, and travel times (a fixed speed per profile). Barriers you report are
simulations stored in your browser.

## Limits to state plainly

- Outdoor routes only; no indoor routing and no floor plans.
- The router knows only what OpenStreetMap contributors have mapped.
- No live closures or elevator outages.
- A prototype, not a safety-critical navigation aid.
