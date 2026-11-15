import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCampus, parseRoom, KIND, FLAG, PROFILES } from '../src/engine.js';

// ---------- synthetic campus ----------
//
//   D(15)-13 ---- 9 (landing)        C(14)
//                 |  stairs S2        |
//   8 ------------+------ 10 ---------+        8-11-12-10 is the step-free way round S2 (220 m)
//   |
//   5 --- M(20)                               1-4-5-2 is the step-free way round S1 (70 m)
//   4
//   0 ----------- 1 =S1= 2 ----------- 3 --crossing-- 22 -- station(23)
//   A(6)          Y(18)  Z(19)         B(7), X1(16)
//
// Lengths are in metres; S1 is 20 m (12 steps), S2 is 2 x 10 m (20 steps) with a landing.

const BBOX = [-79.4, 43.65, -79.39, 43.66];
const KX = 111320 * Math.cos(((BBOX[1] + BBOX[3]) / 2) * Math.PI / 180);
const KY = 110540;
const quant = ([x, y]) => [Math.round(x / KX * 1e6), Math.round(y / KY * 1e6)];
const lngLatAt = (x, y) => [BBOX[0] + x / KX, BBOX[1] + y / KY];

const NODES = [
  [0, 0], [100, 0], [120, 0], [220, 0], [100, 25], [120, 25], [0, -5], [220, -5], [120, 125], [120, 135],
  [120, 145], [220, 125], [220, 145], [60, 135], [120, 150], [60, 140], [220, 10], [0, 10], [100, -5], [120, -5],
  [125, 30], [-5, 0], [240, 0], [245, 0], [0, 40], [0, 90], [0, 95], [10, 65],
];
const WAYS = [
  { kind: KIND.sidewalk, near: 0, path: [0, 1] },                    // 0
  { kind: KIND.steps, steps: 12, path: [1, 2] },                     // 1  S1
  { kind: KIND.sidewalk, near: 0, path: [2, 3] },                    // 2
  { kind: KIND.footway, path: [1, 4, 5, 2] },                        // 3  way round S1
  { kind: KIND.footway, path: [5, 8] },                              // 4
  { kind: KIND.steps, steps: 20, path: [8, 9, 10] },                 // 5  S2
  { kind: KIND.footway, path: [8, 11, 12, 10] },                     // 6  way round S2
  { kind: KIND.footway, path: [9, 13] },                             // 7  side path off the landing
  { kind: KIND.crossing, near: 1, flags: FLAG.SIGNAL, path: [3, 22] }, // 8
  { kind: KIND.footway, path: [0, 24] },                             // 9
  { kind: KIND.corridor, path: [24, 25] },                           // 10 indoor shortcut, 50 m
  { kind: KIND.footway, path: [24, 27, 25] },                        // 11 outdoor way round it, ~53.9 m
];
const LINKS = [[6, 0], [7, 3], [14, 10], [15, 13], [16, 3], [17, 0], [18, 1], [19, 2], [20, 5], [21, 0], [23, 22], [26, 25]];
const official = (n, name, extra = {}) => ({ n, name, src: 'uoft', access: 'stepfree', powered: true, ...extra });
const ENTRANCES = [
  official(6, 'Main entrance to Alpha Hall', { desc: 'A level path leads to a powered door.' }), // 0
  official(7, 'Main Entrance to the Bahen Centre'),                                              // 1
  official(14, 'Main entrance to Convocation Hall'),                                             // 2
  official(15, 'Main entrance to Delta Library'),                                                // 3
  { n: 16, name: 'Front steps', src: 'osm', access: 'steps' },                                   // 4
  { n: 17, name: 'Accessible entrance', src: 'osm', access: 'stepfree' },                        // 5
  { n: 18, name: 'Main entrance to Yellow House', src: 'uoft', access: 'steps' },                // 6
  { n: 19, name: 'Entrance', src: 'osm', access: 'unknown' },                                    // 7
  { n: 20, name: 'Side door to Manual Lodge', src: 'uoft', access: 'stepfree' },                 // 8  manual door
  { n: 21, name: 'Beverley Street entrance (approximate position)', src: 'none', access: 'unknown' }, // 9
  { n: 23, name: 'Station entrance', src: 'osm', access: 'stepfree', lift: true },               // 10
  { n: 26, name: 'Main entrance', src: 'osm', access: 'stepfree' },                              // 11
];
const PLACES = [
  { id: 'AA', code: 'AA', name: 'Alpha Hall', type: 'building', at: [0, -10], ent: [0] },
  { id: 'BA', code: 'BA', name: 'Bahen Centre for Information Technology', type: 'building', at: [220, -10], ent: [1],
    addr: '40 St. George Street', aka: ['Bahen'], h: 38.4, fmax: 8,
    rooms: [{ n: 'Computer Science Help Desk', r: '2270', f: '' }, { n: 'Graduate Lounge', r: '', f: '5' }] },
  { id: 'CC', code: 'CC', name: 'Convocation Hall', type: 'building', at: [120, 160], ent: [2], levels: 3, h: 20 },
  { id: 'DD', code: 'DD', name: 'Delta Library', type: 'building', at: [60, 150], ent: [3], h: 9.2, fmax: 4,
    aka: ['Sig Samuel', 'Alpha Annex'] },
  { id: 'YH', code: 'YH', name: 'Yellow House', type: 'building', at: [100, -10], ent: [6] },   // stairs only
  { id: 'ZA', code: 'ZA', name: 'Zeta Annex', type: 'building', at: [125, -12], ent: [7] },     // unknown door only
  { id: 'osm1', name: 'Exchange Tower', type: 'landmark', at: [110, 5], ent: [4, 5] },
  { id: 'osm2', name: 'Manual Lodge', type: 'landmark', at: [130, 35], ent: [8] },
  { id: 'venue', name: "Polish Combatants' Hall (ONHacks venue)", type: 'venue', at: [-10, 0], ent: [9],
    addr: '206 Beverley Street' },
  { id: 'transit1', name: "Queen's Park Subway Station", type: 'transit', at: [250, 0], ent: [10] },
  { id: 'osm3', name: 'Indoor Atrium', type: 'landmark', at: [0, 100], ent: [11] },
];
const P = Object.fromEntries(PLACES.map((place, index) => [place.id, index]));

function buildDataset() {
  const columns = { kind: [], flags: [], name: [], near: [], incline: [], steps: [], osm: [] };
  const edges = [];
  WAYS.forEach((way, index) => {
    columns.kind.push(way.kind);
    columns.flags.push(way.flags ?? 0);
    columns.name.push(way.name ?? -1);
    columns.near.push(way.near ?? -1);
    columns.incline.push(way.incline ?? 0);
    columns.steps.push(way.steps ?? 0);
    columns.osm.push(1000 + index);
    for (let i = 1; i < way.path.length; i++) edges.push(way.path[i - 1], way.path[i], index);
  });
  for (const column of Object.keys(columns)) columns[column].push(column === 'kind' ? KIND.link : column === 'name' || column === 'near' ? -1 : 0);
  const linkWay = WAYS.length;
  for (const [door, node] of LINKS) edges.push(door, node, linkWay);
  return {
    meta: { campus: 'Test campus', bbox: BBOX, counts: {}, sources: [] },
    names: ['King Street', 'Queen Street'],
    net: { nodes: NODES.flatMap(quant), edges, ways: columns, nodeFlags: [] },
    mass: [], roads: [], areas: [], notices: [],
    places: PLACES.map(({ at, ...place }) => ({ ...place, pt: quant(at) })),
    entrances: ENTRANCES.map(entrance => ({ ...entrance, pt: quant(NODES[entrance.n]) })),
  };
}

const dataset = buildDataset();
const campus = createCampus(dataset);

function edgeBetween(a, b, source = dataset) {
  const { edges } = source.net;
  for (let i = 0; i < edges.length; i += 3) {
    if ((edges[i] === a && edges[i + 1] === b) || (edges[i] === b && edges[i + 1] === a)) return i / 3;
  }
  throw new Error(`no edge between ${a} and ${b}`);
}

const near = (actual, expected, tolerance = 0.5) => assert.ok(
  Math.abs(actual - expected) <= tolerance, `expected ${expected} +/- ${tolerance}, got ${actual}`);
const usesStairs = route => route.edges.some(e => campus.edgeInfo(e).kind === KIND.steps);
const stepSum = route => route.steps.reduce((sum, step) => sum + step.distance, 0);
const go = (from, to, profile, extra = {}) => campus.route({ from: P[from] ?? from, to: P[to] ?? to, profile, ...extra });

/** Step-free cost saved if stair way `wayIdx` gained a ramp, by rebuilding the campus and re-auditing. */
async function bruteForceFix(source, before, wayIdx, options = {}) {
  const ramped = structuredClone(source);
  ramped.net.ways.flags[wayIdx] |= FLAG.RAMP;
  const after = await createCampus(ramped).audit(options);
  const n = before.matrix.order.length;
  let saved = 0, newlyConnected = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const was = before.matrix.stepfreeCost[i * n + j], now = after.matrix.stepfreeCost[i * n + j];
      if (was === Infinity) {
        if (now !== Infinity) newlyConnected++;
      } else {
        saved += was - now;
      }
    }
  }
  return { saved, newlyConnected };
}

// ---------- routing ----------

test('profiles are exported in UI order', () => {
  assert.deepEqual(PROFILES.map(p => p.id), ['walk', 'gentle', 'stepfree']);
  assert.ok(PROFILES.every(p => p.speed > 0 && p.label));
});

test('walking takes the stair shortcut', () => {
  const route = go('AA', 'BA', 'walk');
  assert.equal(route.ok, true);
  near(route.distance, 230);
  assert.equal(usesStairs(route), true);
  assert.deepEqual(route.stairs, { flights: 1, steps: 12 });
  near(route.duration, 230 / 80 + 12 * 0.5 / 60, 0.02);
  assert.deepEqual(route.entrance, { from: 0, to: 1 });
  assert.deepEqual(route.steps.map(step => step.type), ['depart', 'walk', 'stairs', 'walk', 'arrive']);
  assert.equal(route.steps[0].text, 'Leave via Main entrance to Alpha Hall');
  assert.equal(route.steps[1].text, 'Follow the sidewalk along King Street');
  assert.equal(route.steps[2].text, 'Take the stairs (12 steps)');
  assert.equal(route.steps.at(-1).text, 'Arrive at Main Entrance to the Bahen Centre');
  assert.equal(route.coords.length, route.edges.length + 1);
  assert.deepEqual(route.warnings, []);
});

test('step-free takes the ramp detour and never touches a stair edge', () => {
  const route = go('AA', 'BA', 'stepfree');
  assert.equal(route.ok, true);
  near(route.distance, 280);
  assert.equal(usesStairs(route), false);
  assert.deepEqual(route.stairs, { flights: 0, steps: 0 });
  near(route.duration, 280 / 60, 0.02);
  assert.ok(!route.steps.some(step => step.type === 'stairs'));
  assert.match(route.steps[2].text, /^Turn left onto the path/);
  assert.deepEqual(route.flags, { unverifiedDoor: false, manualDoor: false, usesLift: false, roughMeters: 0 });
});

test('fewer-stairs profile prefers a short detour over a flight', () => {
  const route = go('AA', 'BA', 'gentle');
  near(route.distance, 280);
  assert.equal(usesStairs(route), false);
  // Around S2 the detour is 220 m, so the same profile accepts those stairs.
  const long = go('AA', 'CC', 'gentle');
  near(long.distance, 275);
  assert.equal(long.stairs.flights, 1);
});

test('step distances add up to the route distance and slice the edge list', () => {
  for (const profile of ['walk', 'gentle', 'stepfree']) {
    for (const [from, to] of [['AA', 'BA'], ['AA', 'CC'], ['BA', 'CC'], ['venue', 'transit1'], ['osm2', 'AA']]) {
      const route = go(from, to, profile);
      assert.equal(route.ok, true, `${from}->${to} ${profile}: ${route.message}`);
      near(stepSum(route), route.distance, 1e-6);
      assert.equal(route.steps[0].edges[0], 0);
      assert.equal(route.steps.at(-1).edges[1], route.edges.length);
      route.steps.slice(1).forEach((step, i) => assert.equal(step.edges[0], route.steps[i].edges[1]));
      for (const step of route.steps) assert.equal(step.coords.length, step.edges[1] - step.edges[0] + 1);
    }
  }
});

test('closing a segment reroutes, and can cut the only step-free link', () => {
  const stairs = campus.segmentOf(edgeBetween(1, 2));
  const rerouted = go('AA', 'BA', 'walk', { closedEdges: stairs });
  near(rerouted.distance, 280);
  assert.equal(usesStairs(rerouted), false);

  const detour = campus.segmentOf(edgeBetween(1, 4));
  const blocked = go('AA', 'BA', 'stepfree', { closedEdges: new Set(detour) });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'unreachable');
  assert.match(blocked.message, /step-free/i);
  assert.equal(go('AA', 'BA', 'walk', { closedEdges: detour }).ok, true);
});

test('segmentOf returns the stretch between junctions', () => {
  assert.deepEqual(campus.segmentOf(edgeBetween(1, 4)).sort((a, b) => a - b),
    [edgeBetween(1, 4), edgeBetween(4, 5)].sort((a, b) => a - b));
  assert.deepEqual(campus.segmentOf(edgeBetween(11, 12)).sort((a, b) => a - b),
    [edgeBetween(8, 11), edgeBetween(11, 12), edgeBetween(12, 10)].sort((a, b) => a - b));
  assert.deepEqual(campus.segmentOf(edgeBetween(1, 2)), [edgeBetween(1, 2)]);
  assert.deepEqual(campus.segmentOf(edgeBetween(6, 0)), [edgeBetween(6, 0)]);
  assert.throws(() => campus.segmentOf(9999), RangeError);
});

test('a place with only stair doors has no step-free route', () => {
  const route = go('AA', 'YH', 'stepfree');
  assert.deepEqual([route.ok, route.reason], [false, 'no-stepfree-entrance']);
  assert.match(route.message, /Yellow House/);
  near(go('AA', 'YH', 'walk').distance, 110);
});

test('unknown-only doors are used with an unverified flag', () => {
  const route = go('AA', 'ZA', 'stepfree');
  assert.equal(route.ok, true);
  near(route.distance, 180);
  assert.equal(route.flags.unverifiedDoor, true);
  assert.ok(route.warnings.some(text => /Zeta Annex.*unverified/.test(text)));
  assert.equal(go('AA', 'ZA', 'walk').flags.unverifiedDoor, false);
});

test('a manual step-free door is flagged', () => {
  const route = go('AA', 'osm2', 'stepfree');
  near(route.distance, 5 + 100 + 45 + Math.hypot(5, 5));
  assert.equal(route.flags.manualDoor, true);
  assert.ok(route.warnings.some(text => /manual/.test(text)));
  assert.equal(go('AA', 'BA', 'stepfree').flags.manualDoor, false);
});

test('doors are chosen per profile and closed entrances are skipped', () => {
  const walk = go('BA', 'osm1', 'walk');
  near(walk.distance, 15);
  assert.equal(walk.entrance.to, 4);
  const stepfree = go('BA', 'osm1', 'stepfree');
  near(stepfree.distance, 285);
  assert.equal(stepfree.entrance.to, 5);
  assert.equal(go('BA', 'osm1', 'gentle').entrance.to, 4);

  const closedFront = go('BA', 'osm1', 'walk', { closedEntrances: [4] });
  near(closedFront.distance, 235);
  assert.equal(closedFront.entrance.to, 5);
  const allClosed = go('BA', 'osm1', 'walk', { closedEntrances: new Set([4, 5]) });
  assert.deepEqual([allClosed.ok, allClosed.reason], [false, 'unreachable']);
  assert.match(allClosed.message, /closed/);
});

test('crossings, lifts and named snap doors read well', () => {
  const route = go('BA', 'transit1', 'walk');
  near(route.distance, 30);
  assert.equal(route.steps[1].type, 'cross');
  assert.equal(route.steps[1].text, 'Cross Queen Street at the signals');
  assert.equal(route.flags.usesLift, true);
  assert.ok(route.warnings.some(text => /lift/.test(text)));
  assert.equal(route.steps.at(-1).text, "Arrive at Queen's Park Subway Station by the station entrance");

  const fromVenue = go('venue', 'AA', 'walk');
  assert.equal(fromVenue.steps[0].text,
    "Leave Polish Combatants' Hall (ONHacks venue) by the Beverley Street entrance (approximate position)");
});

test('indoor passages cost more and carry an opening-hours warning', () => {
  const outdoor = go('AA', 'osm3', 'walk');
  near(outdoor.distance, 5 + 40 + 2 * Math.hypot(10, 25) + 5);
  assert.ok(!outdoor.warnings.some(text => /building/.test(text)));

  const closedEdges = campus.segmentOf(edgeBetween(24, 27));
  for (const profile of ['walk', 'gentle', 'stepfree']) {
    const indoor = go('AA', 'osm3', profile, { closedEdges });
    near(indoor.distance, 100);
    assert.ok(indoor.warnings.includes('Part of this route passes through a building; opening hours may apply.'));
    assert.ok(indoor.steps.some(step => step.text.includes('Go through the indoor passage')), profile);
  }
});

test('dropped pins snap to the network', () => {
  const route = campus.route({ from: { lngLat: lngLatAt(30, 3) }, to: P.BA, profile: 'walk' });
  assert.equal(route.ok, true);
  near(route.distance, 225);
  assert.equal(route.entrance.from, null);
  assert.equal(route.steps[0].text, 'Start at the dropped pin');
  const far = campus.route({ from: { lngLat: lngLatAt(5000, 5000) }, to: P.BA });
  assert.deepEqual([far.ok, far.reason], [false, 'bad-input']);
});

test('route never throws on bad input', () => {
  assert.equal(go('AA', 'AA', 'walk').reason, 'same');
  assert.equal(go('AA', 'BA', 'fly').reason, 'bad-input');
  assert.equal(campus.route({ from: 999, to: P.BA }).reason, 'bad-input');
  assert.equal(campus.route({ from: null, to: P.BA }).reason, 'bad-input');
  assert.equal(campus.route({ from: P.AA, to: { lngLat: ['x', 2] } }).reason, 'bad-input');
  assert.equal(campus.route().reason, 'bad-input');
  assert.equal(campus.route({ from: P.AA, to: P.BA }).profile, 'walk');
});

// ---------- geometry helpers ----------

test('nearestEdge, edgeLine, edgeInfo and stairWays', () => {
  const hit = campus.nearestEdge(lngLatAt(50, 3));
  assert.equal(hit.edge, edgeBetween(0, 1));
  near(hit.distance, 3, 0.2);
  // A point on a door connector still resolves to a walkable edge, never the connector.
  assert.notEqual(campus.edgeInfo(campus.nearestEdge(lngLatAt(0, -2.5)).edge).kind, KIND.link);
  assert.equal(campus.nearestEdge(lngLatAt(900, 900)), null);
  assert.equal(campus.nearestEdge(null), null);

  const info = campus.edgeInfo(edgeBetween(0, 1));
  assert.deepEqual([info.kind, info.kindLabel, info.name, info.osmWay], [KIND.sidewalk, 'Sidewalk', 'King Street', 1000]);
  near(info.length, 100, 0.2);
  const [a, b] = campus.edgeLine(edgeBetween(0, 1));
  near((b[0] - a[0]) * KX, 100, 0.2);

  const stairs = campus.stairWays();
  assert.deepEqual(stairs.map(s => s.id), [1, 5]);
  assert.deepEqual([stairs[1].edges.length, stairs[1].steps, stairs[1].ramp], [2, 20, false]);
  near(stairs[1].length, 20, 0.2);
});

test('createCampus rejects malformed datasets with a clear message', () => {
  assert.throws(() => createCampus({}), /Wayfound dataset: meta\.bbox/);
  const broken = buildDataset();
  broken.net.edges[0] = 9999;
  assert.throws(() => createCampus(broken), /edge 0 joins nodes 9999/);
  const badDoor = buildDataset();
  badDoor.places[0].ent = [500];
  assert.throws(() => createCampus(badDoor), /Alpha Hall.*entrance 500/);
});

test('places and entrances are augmented', () => {
  const place = campus.places[P.BA];
  assert.equal(place.index, P.BA);
  near((place.lngLat[0] - BBOX[0]) * KX, 220, 0.2);
  assert.deepEqual(campus.entrances[1].places, [P.BA]);
  assert.equal(campus.entrances[1].index, 1);
  assert.deepEqual(campus.toLngLat(dataset.places[P.BA].pt), place.lngLat);
  assert.equal(campus.decodeLine([0, 0, 1000, 2000]).length, 2);
});

// ---------- rooms, floors, search ----------

test('parseRoom follows the U of T room-number convention', () => {
  assert.deepEqual(parseRoom('BA1130'), { code: 'BA', room: '1130', floor: 1, floorLabel: 'Floor 1' });
  assert.deepEqual(campus.parseRoom('RL 14081'), { code: 'RL', room: '14081', floor: 14, floorLabel: 'Floor 14' });
  assert.deepEqual(parseRoom('SS B150'), { code: 'SS', room: 'B150', floor: 0, floorLabel: 'Basement' });
  assert.deepEqual(parseRoom(' ba-2270a '), { code: 'BA', room: '2270A', floor: 2, floorLabel: 'Floor 2' });
  assert.equal(parseRoom('MP 102').floor, 1);
  assert.equal(parseRoom('LW P322').floor, null);
  for (const garbage of ['hello', '', null, undefined, 'BA', '12', 'BA 12', 'B 150', 'robarts library', '1130']) {
    assert.equal(parseRoom(garbage), null, String(garbage));
  }
});

test('floorsOf prefers mapped levels, then height and the highest floor U of T mentions', () => {
  assert.deepEqual(campus.floorsOf(P.CC), { levels: 3, source: 'osm', height: 20 });
  assert.deepEqual(campus.floorsOf(P.BA), { levels: 8, source: 'estimated', height: 38.4 }); // round(38.4 / 4.6)
  assert.deepEqual(campus.floorsOf(P.DD), { levels: 4, source: 'estimated', height: 9.2 });  // fmax beats 2
  assert.deepEqual(campus.floorsOf(P.AA), { levels: 1, source: 'unknown', height: null });
});

test('search ranks codes, rooms, the venue, names, aliases and offices', () => {
  assert.equal(campus.search('ba')[0].placeIndex, P.BA);
  for (const text of ['BA 1130', 'ba1130', 'bahen 1130']) {
    const [top] = campus.search(text);
    assert.deepEqual([top.kind, top.placeIndex, top.title, top.room.floor], ['room', P.BA, 'BA 1130', 1], text);
    assert.match(top.subtitle, /Bahen Centre.*Floor 1/);
  }
  assert.deepEqual(campus.search('hall').map(r => r.placeIndex), [P.venue, P.AA, P.CC]);
  assert.equal(campus.search('venue')[0].placeIndex, P.venue);
  assert.equal(campus.search('convocation')[0].title, 'Convocation Hall');
  assert.equal(campus.search("queens park")[0].placeIndex, P.transit1);

  const alias = campus.search('sig sam')[0];
  assert.deepEqual([alias.placeIndex, alias.title], [P.DD, 'Delta Library']);
  assert.match(alias.subtitle, /Also known as Sig Samuel/);
  // The same match on an official name outranks an alias.
  assert.deepEqual(campus.search('alpha').map(r => r.placeIndex), [P.AA, P.DD]);

  const office = campus.search('help desk')[0];
  assert.deepEqual([office.kind, office.placeIndex, office.title, office.room.floor],
    ['office', P.BA, 'Computer Science Help Desk', 2]);
  assert.equal(campus.search('graduate lounge')[0].room.floor, 5);

  assert.deepEqual(campus.search(''), []);
  assert.deepEqual(campus.search('   '), []);
  assert.deepEqual(campus.search('qqqq'), []);
  assert.equal(campus.search('a', { limit: 2 }).length, 2);
});

// ---------- audit ----------

test('audit summarises walking against step-free travel', async () => {
  const progress = [];
  const audit = await campus.audit({ onProgress: (done, total) => progress.push([done, total]) });
  assert.deepEqual(progress.at(-1), [6, 6]);
  assert.deepEqual([audit.buildings, audit.journeys, audit.buildingsWithDoor], [6, 15, 4]);
  assert.deepEqual([audit.audited, audit.reachable, audit.unreachable, audit.detoured], [6, 3, 3, 3]);
  near(audit.meanWalk, (230 + 275 + 255) / 3);
  near(audit.meanStepfree, (280 + 475 + 455) / 3);
  near(audit.meanExtra, 150);
  near(audit.totalExtra, 450);
  assert.deepEqual(audit.noStepFreeDoor, [P.YH, P.ZA]);
  assert.deepEqual(audit.stairsOnly, [P.YH]);
  assert.deepEqual(audit.worst.map(pair => [pair.a, pair.b]).sort(), [[P.AA, P.BA], [P.AA, P.CC], [P.BA, P.CC]].sort());
  near(audit.worst[0].extra, 200);
  near(audit.worst.at(-1).extra, 50);

  const alpha = audit.places.find(entry => entry.placeIndex === P.AA);
  near(alpha.meanExtra, 125);
  assert.deepEqual([alpha.detouredShare, alpha.reachable], [1, true]);
  assert.equal(audit.places.find(entry => entry.placeIndex === P.YH).reachable, false);
  assert.ok(audit.elapsedMs >= 0);
});

test('fix-first ranking matches a brute-force recomputation', async () => {
  const audit = await campus.audit();
  assert.deepEqual(audit.fixes.map(fix => fix.id), [5, 1]);

  const [landing, shortcut] = audit.fixes;
  near(landing.savedMeters, 400);
  assert.deepEqual([landing.type, landing.journeys, landing.newlyConnected, landing.steps], ['stairs', 2, 3, 20]);
  near(landing.maxSaving, 200);
  assert.equal(landing.label, 'Stairs near Convocation Hall (20 steps)');
  assert.deepEqual([landing.example.a, landing.example.b], [P.AA, P.CC]);
  near(landing.example.before, 475);
  near(landing.example.after, 275);
  assert.deepEqual(landing.edges.slice().sort(), campus.stairWays()[1].edges.slice().sort());

  near(shortcut.savedMeters, 50);
  assert.deepEqual([shortcut.journeys, shortcut.newlyConnected], [1, 0]);

  for (const fix of audit.fixes) {
    const brute = await bruteForceFix(dataset, audit, fix.id);
    near(fix.savedMeters, brute.saved, 0.05);
    assert.equal(fix.newlyConnected, brute.newlyConnected, fix.label);
  }
});

test('audit honours reported barriers', async () => {
  const closedEdges = campus.segmentOf(edgeBetween(1, 4));
  const audit = await campus.audit({ closedEdges });
  assert.deepEqual([audit.audited, audit.reachable, audit.unreachable], [6, 1, 5]);
  const byId = Object.fromEntries(audit.fixes.map(fix => [fix.id, fix]));
  near(byId[5].savedMeters, 200);
  assert.deepEqual([byId[5].newlyConnected, byId[1].newlyConnected], [2, 2]);
  for (const fix of audit.fixes) {
    const brute = await bruteForceFix(dataset, audit, fix.id, { closedEdges });
    near(fix.savedMeters, brute.saved, 0.05);
    assert.equal(fix.newlyConnected, brute.newlyConnected, fix.label);
  }
  const doorsClosed = await campus.audit({ closedEntrances: [0] });
  assert.deepEqual(doorsClosed.noStepFreeDoor, [P.AA, P.YH, P.ZA]);
});

// ---------- invariants on the real campus build (any size) ----------

const realDataset = JSON.parse(readFileSync(new URL('../data/uoft.json', import.meta.url), 'utf8'));
const real = createCampus(realDataset);
const realBuildings = real.places.filter(place => place.type === 'building');

test('real dataset decodes with usable places', () => {
  assert.ok(real.nodeCount > 100 && real.edgeCount > 100);
  assert.ok(realBuildings.length >= 2);
  for (const place of real.places) {
    assert.ok(place.ent.length > 0, `${place.name} has no entrance`);
    assert.ok(place.lngLat.every(Number.isFinite));
  }
  assert.ok(real.places.some(place => place.id === 'venue'));
});

test('real routes are symmetric and their steps add up', () => {
  const step = Math.max(1, Math.floor(realBuildings.length / 7));
  let compared = 0;
  for (let i = 0; i + step < realBuildings.length; i += step) {
    const a = realBuildings[i].index, b = realBuildings[i + step].index;
    for (const profile of ['walk', 'gentle', 'stepfree']) {
      const there = real.route({ from: a, to: b, profile });
      const back = real.route({ from: b, to: a, profile });
      assert.equal(there.ok, back.ok, `${realBuildings[i].name} ${profile}`);
      if (!there.ok) continue;
      near(there.distance, back.distance, 1);
      near(stepSum(there), there.distance, 1e-6);
      compared++;
    }
  }
  assert.ok(compared > 0);
});

test('real step-free routes never use stairs without a ramp', () => {
  const withDoor = realBuildings.filter(place => place.ent.some(ei => real.entrances[ei].access === 'stepfree'));
  assert.ok(withDoor.length >= 2);
  const step = Math.max(1, Math.floor(withDoor.length / 9));
  let checked = 0;
  for (let i = 0; i < withDoor.length; i += step) {
    for (let j = i + step; j < withDoor.length; j += step) {
      const route = real.route({ from: withDoor[i].index, to: withDoor[j].index, profile: 'stepfree' });
      if (!route.ok) continue;
      checked++;
      for (const e of route.edges) {
        const info = real.edgeInfo(e);
        assert.ok(info.kind !== KIND.steps || (info.flags & FLAG.RAMP) !== 0,
          `${withDoor[i].name} -> ${withDoor[j].name} uses stair edge ${e}`);
      }
      assert.equal(route.stairs.flights, 0);
    }
  }
  assert.ok(checked > 0);
});

test('real audit completes and its top fixes match brute force', async () => {
  const audit = await real.audit();
  const n = realBuildings.length;
  assert.deepEqual([audit.buildings, audit.journeys], [n, n * (n - 1) / 2]);
  assert.equal(audit.reachable + audit.unreachable, audit.audited);
  assert.equal(audit.buildingsWithDoor + audit.noStepFreeDoor.length, n);
  assert.ok(audit.detoured <= audit.reachable);
  assert.ok(audit.stairsOnly.every(pi => audit.noStepFreeDoor.includes(pi)));
  for (const fix of audit.fixes.slice(0, 2)) {
    const brute = await bruteForceFix(realDataset, audit, fix.id);
    near(fix.savedMeters, brute.saved, Math.max(1, brute.saved * 0.002));
    assert.equal(fix.newlyConnected, brute.newlyConnected, fix.label);
  }
});
