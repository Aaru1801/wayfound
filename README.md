# Wayfound

Step-free, door-to-door campus routing on a 3D map built from open data.

Type a room such as `BA 1130`. Wayfound routes along real mapped paths to a real door, tells you the floor, and
shows what the step-free route costs compared with walking. Its access audit then ranks which stair flight the
campus should fix first.

This build covers the **University of Toronto, St. George campus**. The interface shows only what a journey needs;
directions, door details, floors and warnings open from their own buttons.

**Live demo:** https://aaru1801.github.io/wayfound/ (the offline single file is
[Wayfound.html](https://aaru1801.github.io/wayfound/Wayfound.html)). Built at ONHacks 2026.

![Step-free route to Hart House](docs/screenshots/01-step-free-route.png)

## Run

```sh
npm start                # http://127.0.0.1:4310
npm test                 # 40 engine and dataset tests
npm run build:offline    # writes Wayfound.html: one file, opens by double-click, no network
```

There is nothing to install. `npm start` needs Python 3 (a static file server); the tests and the offline build need
Node 20 or newer. No API keys, accounts or environment variables.

## What it is built from

| | Source |
| --- | --- |
| 3D buildings | City of Toronto Open Data, 3D Massing (3,667 shapes around campus) |
| Paths, stairs, crossings | OpenStreetMap (12,961 walkable segments, 210 mapped stairways) |
| Doors | 346 entrance descriptions from U of T's campus map, classified by rule: 184 step-free, 146 stairs, 16 unclear |
| Building codes and addresses | Cobalt U of T datasets |

Nothing is fetched while the app runs. The campus is one JSON file, `data/uoft.json`.

The same pipeline also builds the University of Waterloo (with the university's own open data: 66 buildings and
65 accessible entrances) and McMaster University (OpenStreetMap only). Both datasets are in `data/` and are covered
by the tests, but the interface does not show a campus switch; open them with `#campus=waterloo` or
`#campus=mcmaster` in the address.
