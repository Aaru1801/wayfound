/**
 * Wayfound engine: door-to-door campus routing, search, and the access audit.
 * Pure ES module with no DOM or network access, so it runs in browsers and Node.
 * The dataset format and this module's API are specified in docs/CONTRACT.md.
 */

export const KIND = Object.freeze({
  footway: 0, sidewalk: 1, crossing: 2, path: 3, pedestrian: 4, steps: 5,
  cycleway: 6, service: 7, street: 8, corridor: 9, link: 10, elevator: 11,
});

export const FLAG = Object.freeze({
  NO: 1, LIMITED: 2, YES: 4, ROUGH: 8, UNPAVED: 16, SHELTERED: 32,
  RAMP: 64, LIT: 128, SIGNAL: 256, MARKED: 512, NARROW: 1024,
});

export const PROFILES = Object.freeze([
  Object.freeze({ id: 'walk', label: 'Walking', speed: 80 }),
  Object.freeze({ id: 'gentle', label: 'Fewer stairs', speed: 68 }),
  Object.freeze({ id: 'stepfree', label: 'Step-free', speed: 60 }),
]);

const KIND_LABELS = ['Footpath', 'Sidewalk', 'Crossing', 'Path', 'Pedestrian area', 'Stairs', 'Shared path',
  'Service lane', 'Street', 'Indoor passage', 'Door connector', 'Elevator'];
const NODE_KERB = 1;
const NODE_LOCKED = 2;
const GENTLE_STAIR_PENALTY = 40;
const GENTLE_DOOR_PENALTY = 40;
const MANUAL_DOOR_PENALTY = 15;
const DETOUR_THRESHOLD = 40;
const UNKNOWN_FLIGHT_STEPS = 12;
const SECONDS_PER_STEP = 0.5;
const MAX_INCLINE = 8;
const INDOOR_FACTOR = 1.3; // indoor passages can be locked after hours, so prefer outdoor paths when close
const PIN_SNAP_METRES = 250;
const GRID_CELL = 40;
const WAY_COLUMNS = ['kind', 'flags', 'name', 'near', 'incline', 'steps', 'osm'];

class MinHeap {
  constructor(capacity) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
    this.size = 0;
    this.topKey = 0;
  }

  push(key, val) {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2);
      const vals = new Int32Array(this.size * 2);
      keys.set(this.keys);
      vals.set(this.vals);
      this.keys = keys;
      this.vals = vals;
    }
    const { keys, vals } = this;
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      vals[i] = vals[parent];
      i = parent;
    }
    keys[i] = key;
    vals[i] = val;
  }

  /** Removes the smallest entry; its key is left in `topKey`. */
  pop() {
    const { keys, vals } = this;
    const top = vals[0];
    this.topKey = keys[0];
    const n = --this.size;
    if (n > 0) {
      const key = keys[n];
      const val = vals[n];
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= key) break;
        keys[i] = keys[child];
        vals[i] = vals[child];
        i = child;
      }
      keys[i] = key;
      vals[i] = val;
    }
    return top;
  }
}

function fail(message) {
  throw new Error(`Wayfound dataset: ${message}`);
}

function validate(dataset) {
  if (!dataset || typeof dataset !== 'object') fail('expected an object');
  const bbox = dataset.meta?.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) {
    fail('meta.bbox must be [west, south, east, north]');
  }
  const net = dataset.net;
  if (!Array.isArray(net?.nodes) || net.nodes.length % 2) fail('net.nodes must be a flat [x, y, ...] array');
  if (!Array.isArray(net.edges) || net.edges.length % 3) fail('net.edges must be flat [a, b, way] triples');
  for (const column of WAY_COLUMNS) {
    if (!Array.isArray(net.ways?.[column])) fail(`net.ways.${column} is missing`);
    if (net.ways[column].length !== net.ways.kind.length) fail(`net.ways.${column} has a different length than net.ways.kind`);
  }
  if (!Array.isArray(dataset.places) || !Array.isArray(dataset.entrances)) fail('places and entrances must be arrays');
  const nodeCount = net.nodes.length / 2;
  const wayCount = net.ways.kind.length;
  for (let i = 0; i < net.edges.length; i += 3) {
    const a = net.edges[i], b = net.edges[i + 1], way = net.edges[i + 2];
    if (!(a >= 0 && a < nodeCount && b >= 0 && b < nodeCount)) {
      fail(`edge ${i / 3} joins nodes ${a} and ${b}, but only ${nodeCount} nodes exist`);
    }
    if (!(way >= 0 && way < wayCount)) fail(`edge ${i / 3} references way ${way}, but only ${wayCount} ways exist`);
  }
  dataset.entrances.forEach((entrance, i) => {
    if (!(entrance.n >= 0 && entrance.n < nodeCount)) fail(`entrance ${i} references node ${entrance.n}`);
    if (!Array.isArray(entrance.pt)) fail(`entrance ${i} has no pt`);
  });
  dataset.places.forEach((place, i) => {
    if (!Array.isArray(place.pt)) fail(`place ${i} (${place.name}) has no pt`);
    for (const ei of place.ent ?? []) {
      if (!(ei >= 0 && ei < dataset.entrances.length)) fail(`place ${i} (${place.name}) references entrance ${ei}`);
    }
  });
}

function normalise(text) {
  return String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

const ROOM_CODE = /^[A-Z][A-Z0-9]{1,4}$/;
const ROOM_NUMBER = /^([A-Z]{0,2})[\s-]*(\d{2,5})([A-Z]?)$/;

/**
 * Reads a room string such as "BA 1130", "E7 4043" or "RCH 101". Building codes are 2 to 5
 * characters. Without a space the split is ambiguous ("QNC1502"), so `isCode`, when given,
 * chooses the split whose code exists. The floor comes from the room-number convention only
 * (first digit, or first two of five); it is not looked up anywhere.
 */
export function parseRoom(text, isCode = null) {
  const input = String(text ?? '').trim().toUpperCase();
  const spaced = /^(\S+?)[\s-]+(.+)$/.exec(input);
  const splits = spaced ? [[spaced[1], spaced[2]]] : [2, 3, 4, 5].map(n => [input.slice(0, n), input.slice(n)]);
  for (const [code, rest] of splits) {
    const match = ROOM_CODE.test(code) && (!isCode || isCode(code)) ? ROOM_NUMBER.exec(rest) : null;
    if (!match) continue;
    const [, prefix, digits, suffix] = match;
    const room = `${prefix}${digits}${suffix}`;
    if (prefix === 'B' || prefix === 'SB') {
      return { code, room, floor: 0, floorLabel: prefix === 'SB' ? 'Sub-basement' : 'Basement' };
    }
    if (digits.length < 3) continue;
    if (prefix) return { code, room, floor: null, floorLabel: 'Floor not encoded in the room number' };
    const floor = Number(digits.length === 5 ? digits.slice(0, 2) : digits[0]);
    return { code, room, floor, floorLabel: floor === 0 ? 'Basement' : `Floor ${floor}` };
  }
  return null;
}

function failure(reason, message) {
  return { ok: false, reason, message };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

export function createCampus(dataset) {
  validate(dataset);
  const { meta, net } = dataset;
  const [west, south, , north] = meta.bbox;
  const kx = 111320 * Math.cos(((south + north) / 2) * Math.PI / 180);
  const ky = 110540;
  const names = dataset.names ?? [];
  const nodeCount = net.nodes.length / 2;
  const edgeCount = net.edges.length / 3;
  const wayCount = net.ways.kind.length;

  const toLngLat = pt => [west + pt[0] / 1e6, south + pt[1] / 1e6];
  const nodeLngLat = i => [west + net.nodes[2 * i] / 1e6, south + net.nodes[2 * i + 1] / 1e6];
  const toMetres = lngLat => [(lngLat[0] - west) * kx, (lngLat[1] - south) * ky];
  const decodeLine = flat => {
    const out = new Array(flat.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = [west + flat[2 * i] / 1e6, south + flat[2 * i + 1] / 1e6];
    return out;
  };

  // ----- graph -----
  const mx = new Float64Array(nodeCount);
  const my = new Float64Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    mx[i] = net.nodes[2 * i] * 1e-6 * kx;
    my[i] = net.nodes[2 * i + 1] * 1e-6 * ky;
  }
  const wKind = Int32Array.from(net.ways.kind);
  const wFlags = Int32Array.from(net.ways.flags);
  const wName = Int32Array.from(net.ways.name);
  const wNear = Int32Array.from(net.ways.near);
  const wIncline = Int32Array.from(net.ways.incline);
  const wSteps = Int32Array.from(net.ways.steps);
  const wOsm = Float64Array.from(net.ways.osm);

  const eA = new Int32Array(edgeCount);
  const eB = new Int32Array(edgeCount);
  const eWay = new Int32Array(edgeCount);
  const eLen = new Float64Array(edgeCount);
  const degree = new Int32Array(nodeCount);
  const wayLen = new Float64Array(wayCount);
  for (let e = 0; e < edgeCount; e++) {
    const a = net.edges[3 * e], b = net.edges[3 * e + 1];
    eA[e] = a;
    eB[e] = b;
    eWay[e] = net.edges[3 * e + 2];
    eLen[e] = Math.hypot(mx[a] - mx[b], my[a] - my[b]);
    wayLen[eWay[e]] += eLen[e];
    degree[a]++;
    degree[b]++;
  }
  const nodeFlag = new Uint8Array(nodeCount);
  const rawNodeFlags = net.nodeFlags ?? [];
  for (let i = 0; i + 1 < rawNodeFlags.length; i += 2) {
    if (rawNodeFlags[i] >= 0 && rawNodeFlags[i] < nodeCount) nodeFlag[rawNodeFlags[i]] = rawNodeFlags[i + 1];
  }

  const adjStart = new Int32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) adjStart[i + 1] = adjStart[i] + degree[i];
  const adjEdge = new Int32Array(edgeCount * 2);
  const adjNode = new Int32Array(edgeCount * 2);
  {
    const cursor = adjStart.slice(0, nodeCount);
    for (let e = 0; e < edgeCount; e++) {
      adjEdge[cursor[eA[e]]] = e;
      adjNode[cursor[eA[e]]++] = eB[e];
      adjEdge[cursor[eB[e]]] = e;
      adjNode[cursor[eB[e]]++] = eA[e];
    }
  }

  // ----- edge costs per profile (Infinity = not allowed) -----
  const costs = {
    walk: new Float64Array(edgeCount),
    gentle: new Float64Array(edgeCount),
    stepfree: new Float64Array(edgeCount),
  };
  // Step-free cost an edge would have if its stair way gained a wheelchair ramp (the audit's "fix").
  const rampCost = new Float64Array(edgeCount);
  for (let e = 0; e < edgeCount; e++) {
    const way = eWay[e], kind = wKind[way], flags = wFlags[way], len = eLen[e];
    if (kind === KIND.link) {
      costs.walk[e] = costs.gentle[e] = costs.stepfree[e] = rampCost[e] = len;
      continue;
    }
    const nodeBits = nodeFlag[eA[e]] | nodeFlag[eB[e]];
    const locked = (nodeBits & NODE_LOCKED) !== 0;
    const base = kind === KIND.street || kind === KIND.service ? 1.25 : kind === KIND.corridor ? INDOOR_FACTOR : 1;
    const isSteps = kind === KIND.steps;
    const hasRamp = isSteps && (flags & FLAG.RAMP) !== 0;
    costs.walk[e] = locked ? Infinity : len * (isSteps ? 1.5 : base);
    costs.gentle[e] = locked ? Infinity
      : isSteps && !hasRamp ? len * 3 + GENTLE_STAIR_PENALTY * (len / (wayLen[way] || 1))
        : len * base;
    let stepfree = len * base;
    if (flags & FLAG.UNPAVED) stepfree *= 1.6;
    if (flags & FLAG.ROUGH) stepfree *= 1.3;
    if (flags & FLAG.LIMITED) stepfree *= 1.5;
    const blocked = locked || (nodeBits & NODE_KERB) !== 0 || (flags & (FLAG.NO | FLAG.NARROW)) !== 0
      || wIncline[way] > MAX_INCLINE;
    rampCost[e] = blocked ? Infinity : stepfree;
    costs.stepfree[e] = blocked || (isSteps && !hasRamp) ? Infinity : stepfree;
  }

  const stairEdges = new Map(); // wayIdx -> edge indexes, in dataset order
  for (let e = 0; e < edgeCount; e++) {
    if (wKind[eWay[e]] !== KIND.steps) continue;
    if (!stairEdges.has(eWay[e])) stairEdges.set(eWay[e], []);
    stairEdges.get(eWay[e]).push(e);
  }

  // ----- places and entrances -----
  const entrances = dataset.entrances.map((entrance, index) => ({
    ...entrance, index, lngLat: toLngLat(entrance.pt), places: [],
  }));
  const places = dataset.places.map((place, index) => {
    for (const ei of place.ent ?? []) entrances[ei].places.push(index);
    return { ...place, ent: place.ent ?? [], index, lngLat: toLngLat(place.pt) };
  });
  const placeMetres = places.map(place => toMetres(place.lngLat));
  const buildingIndexes = places.filter(place => place.type === 'building').map(place => place.index);
  const codeIndex = new Map();
  for (const place of places) {
    if (place.code && !codeIndex.has(place.code.toUpperCase())) codeIndex.set(place.code.toUpperCase(), place.index);
    // A former code listed as an alternate name ("E7") still finds the building and its rooms.
    for (const alias of place.aka ?? []) {
      const code = String(alias).toUpperCase();
      if (ROOM_CODE.test(code) && !codeIndex.has(code)) codeIndex.set(code, place.index);
    }
  }

  function nearestBuilding(x, y, maxMetres, exclude = []) {
    let best = -1, bestDistance = maxMetres;
    for (const pi of buildingIndexes) {
      if (exclude.includes(pi)) continue;
      const d = Math.hypot(placeMetres[pi][0] - x, placeMetres[pi][1] - y);
      if (d < bestDistance) {
        best = pi;
        bestDistance = d;
      }
    }
    return best;
  }

  // ----- spatial index over walkable (non-link) edges -----
  const grid = new Map();
  const cellOf = v => Math.floor(v / GRID_CELL);
  const cellKey = (cx, cy) => (cx + 4096) * 16384 + (cy + 4096);
  for (let e = 0; e < edgeCount; e++) {
    if (wKind[eWay[e]] === KIND.link) continue;
    const a = eA[e], b = eB[e];
    const x0 = cellOf(Math.min(mx[a], mx[b])), x1 = cellOf(Math.max(mx[a], mx[b]));
    const y0 = cellOf(Math.min(my[a], my[b])), y1 = cellOf(Math.max(my[a], my[b]));
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = cellKey(cx, cy);
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(e);
      }
    }
  }

  function nearestEdge(lngLat, maxMeters = 30) {
    if (!Array.isArray(lngLat) || !lngLat.every(Number.isFinite)) return null;
    const [px, py] = toMetres(lngLat);
    let best = -1, bestDistance = maxMeters, bestT = 0;
    for (let cx = cellOf(px - maxMeters); cx <= cellOf(px + maxMeters); cx++) {
      for (let cy = cellOf(py - maxMeters); cy <= cellOf(py + maxMeters); cy++) {
        const bucket = grid.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const e of bucket) {
          const ax = mx[eA[e]], ay = my[eA[e]];
          const dx = mx[eB[e]] - ax, dy = my[eB[e]] - ay;
          const len2 = dx * dx + dy * dy;
          const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
          const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
          if (d < bestDistance || (d === bestDistance && best !== -1 && e < best)) {
            best = e;
            bestDistance = d;
            bestT = t;
          }
        }
      }
    }
    if (best < 0) return null;
    const x = mx[eA[best]] + bestT * (mx[eB[best]] - mx[eA[best]]);
    const y = my[eA[best]] + bestT * (my[eB[best]] - my[eA[best]]);
    return { edge: best, distance: bestDistance, lngLat: [west + x / kx, south + y / ky], t: bestT };
  }

  function checkEdge(edgeIdx) {
    if (!Number.isInteger(edgeIdx) || edgeIdx < 0 || edgeIdx >= edgeCount) {
      throw new RangeError(`edge index ${edgeIdx} is outside 0..${edgeCount - 1}`);
    }
  }

  function segmentOf(edgeIdx) {
    checkEdge(edgeIdx);
    const kind = wKind[eWay[edgeIdx]];
    const out = [edgeIdx];
    if (kind === KIND.link) return out;
    for (let node of [eA[edgeIdx], eB[edgeIdx]]) {
      let prev = edgeIdx;
      while (degree[node] === 2) {
        const k = adjStart[node];
        const next = adjEdge[k] === prev ? adjEdge[k + 1] : adjEdge[k];
        if (next === prev || wKind[eWay[next]] !== kind || out.includes(next)) break;
        out.push(next);
        node = eA[next] === node ? eB[next] : eA[next];
        prev = next;
      }
    }
    return out;
  }

  const edgeLine = edgeIdx => {
    checkEdge(edgeIdx);
    return [nodeLngLat(eA[edgeIdx]), nodeLngLat(eB[edgeIdx])];
  };

  function edgeInfo(edgeIdx) {
    checkEdge(edgeIdx);
    const way = eWay[edgeIdx];
    const label = wName[way] >= 0 ? names[wName[way]] : wNear[way] >= 0 ? names[wNear[way]] : '';
    return {
      kind: wKind[way], kindLabel: KIND_LABELS[wKind[way]] ?? 'Path', name: label ?? '',
      length: eLen[edgeIdx], flags: wFlags[way], osmWay: wOsm[way],
    };
  }

  const stairList = [...stairEdges].map(([way, edges]) => {
    const length = edges.reduce((sum, e) => sum + eLen[e], 0);
    let walked = 0;
    let middle = edges[0];
    for (const e of edges) {
      middle = e;
      walked += eLen[e];
      if (walked >= length / 2) break;
    }
    const x = (mx[eA[middle]] + mx[eB[middle]]) / 2, y = (my[eA[middle]] + my[eB[middle]]) / 2;
    return {
      id: way, edges, lngLat: [west + x / kx, south + y / ky], steps: wSteps[way], length,
      ramp: (wFlags[way] & FLAG.RAMP) !== 0, x, y,
    };
  });
  const stairWays = () => stairList.map(({ id, edges, lngLat, steps, length, ramp }) => (
    { id, edges: edges.slice(), lngLat: lngLat.slice(), steps, length, ramp }));

  // ----- shortest paths -----
  const heap = new MinHeap(edgeCount * 2 + 64);
  const routeDist = new Float64Array(nodeCount);
  const routePrev = new Int32Array(nodeCount);

  /**
   * Dijkstra from a set of {node, penalty} sources. Fills `dist` with costs; optionally
   * `prevEdge` for path recovery and `real` with the true length of each cheapest path.
   * With `targets` (Map node -> penalty) it stops once the best target total is certain.
   */
  function shortest({ cost, closed, sources, dist, prevEdge, real, targets, limit = Infinity }) {
    dist.fill(Infinity);
    if (prevEdge) prevEdge.fill(-1);
    heap.size = 0;
    for (const source of sources) {
      if (source.penalty < dist[source.node]) {
        dist[source.node] = source.penalty;
        if (real) real[source.node] = 0;
        heap.push(source.penalty, source.node);
      }
    }
    let best = Infinity, bestNode = -1;
    while (heap.size) {
      const u = heap.pop();
      const d = heap.topKey;
      if (d > dist[u]) continue;
      if (d >= best || d > limit) break;
      if (targets) {
        const penalty = targets.get(u);
        if (penalty !== undefined && d + penalty < best) {
          best = d + penalty;
          bestNode = u;
        }
      }
      for (let k = adjStart[u], end = adjStart[u + 1]; k < end; k++) {
        const e = adjEdge[k];
        const c = cost[e];
        if (c === Infinity || (closed && closed[e])) continue;
        const v = adjNode[k];
        const candidate = d + c;
        if (candidate < dist[v]) {
          dist[v] = candidate;
          if (prevEdge) prevEdge[v] = e;
          if (real) real[v] = real[u] + eLen[e];
          heap.push(candidate, v);
        }
      }
    }
    return { best, bestNode };
  }

  function edgeMask(closedEdges) {
    if (!closedEdges) return null;
    let mask = null;
    for (const e of closedEdges) {
      if (Number.isInteger(e) && e >= 0 && e < edgeCount) {
        mask ??= new Uint8Array(edgeCount);
        mask[e] = 1;
      }
    }
    return mask;
  }

  const isManualDoor = entrance => entrance.src === 'uoft' && !entrance.powered;

  /** Eligible doors for a place under a profile. `strict` refuses unverified doors (used by the audit). */
  function doorsOf(placeIndex, profile, closedDoors, strict = false) {
    const place = places[placeIndex];
    const open = place.ent.map(i => entrances[i]).filter(entrance => !closedDoors.has(entrance.index));
    if (!open.length) return { doors: [], reason: place.ent.length ? 'closed' : 'unmapped' };
    if (profile !== 'stepfree') {
      const doors = open.map(entrance => ({
        node: entrance.n, entrance,
        penalty: profile === 'gentle' && entrance.access === 'steps' ? GENTLE_DOOR_PENALTY : 0,
      }));
      return { doors };
    }
    const stepfree = open.filter(entrance => entrance.access === 'stepfree');
    if (stepfree.length) {
      return {
        doors: stepfree.map(entrance => (
          { node: entrance.n, entrance, penalty: isManualDoor(entrance) ? MANUAL_DOOR_PENALTY : 0 })),
      };
    }
    const unknown = strict ? [] : open.filter(entrance => entrance.access === 'unknown');
    if (unknown.length) {
      return { doors: unknown.map(entrance => ({ node: entrance.n, entrance, penalty: 0 })), unverified: true };
    }
    return { doors: [], reason: 'no-stepfree-entrance' };
  }

  function pinDoors(lngLat) {
    const hit = nearestEdge(lngLat, PIN_SNAP_METRES);
    if (!hit) return { doors: [], reason: 'far' };
    return { doors: [{ node: hit.t < 0.5 ? eA[hit.edge] : eB[hit.edge], entrance: null, penalty: 0 }] };
  }

  function endpoint(value) {
    if (Number.isInteger(value)) {
      return value >= 0 && value < places.length ? { place: places[value] }
        : { error: `place index ${value} is out of range` };
    }
    const lngLat = value?.lngLat;
    if (Array.isArray(lngLat) && lngLat.length === 2 && lngLat.every(Number.isFinite)) return { lngLat };
    return { error: 'expected a place index or { lngLat: [lng, lat] }' };
  }

  function doorFailure(end, reason) {
    const name = end.place?.name ?? 'That point';
    if (reason === 'no-stepfree-entrance') {
      return failure('no-stepfree-entrance', `${name} has no documented step-free entrance.`);
    }
    if (reason === 'closed') return failure('unreachable', `Every entrance to ${name} is marked closed.`);
    if (reason === 'far') return failure('bad-input', 'That point is too far from any mapped path.');
    return failure('unreachable', `${name} has no mapped entrance or nearby path.`);
  }

  // ----- directions -----
  const heading = (fromNode, toNode) => Math.atan2(mx[toNode] - mx[fromNode], my[toNode] - my[fromNode]) * 180 / Math.PI;

  /** Signed change of direction (degrees, right is positive) where path edge `i` begins. */
  function turnAt(pathNodes, pathEdges, i) {
    let back = i, ahead = i;
    for (let walked = 0; back > 0 && walked < 8;) walked += eLen[pathEdges[--back]];
    for (let walked = 0; ahead < pathEdges.length && walked < 8;) walked += eLen[pathEdges[ahead++]];
    if (back === i || ahead === i) return 0;
    const delta = heading(pathNodes[i], pathNodes[ahead]) - heading(pathNodes[back], pathNodes[i]);
    return ((delta + 540) % 360) - 180;
  }

  function turnPhrase(delta) {
    const side = delta > 0 ? 'right' : 'left';
    const size = Math.abs(delta);
    if (size <= 35) return '';
    return size <= 60 ? `Bear ${side}` : size <= 135 ? `Turn ${side}` : `Turn sharp ${side}`;
  }

  function runKey(way, profile) {
    const kind = wKind[way], flags = wFlags[way];
    switch (kind) {
      case KIND.steps: return (flags & FLAG.RAMP) && profile !== 'walk' ? 'ramp' : 'stairs';
      case KIND.crossing: return `cross|${wNear[way]}|${wName[way]}|${flags & (FLAG.SIGNAL | FLAG.MARKED)}`;
      case KIND.sidewalk: return `sidewalk|${wNear[way]}|${wName[way]}`;
      case KIND.street: return `street|${wName[way]}`;
      case KIND.service: return `service|${wName[way]}`;
      case KIND.cycleway: return `shared|${wName[way]}`;
      case KIND.corridor: return 'indoor';
      case KIND.elevator: return 'elevator';
      case KIND.pedestrian: return wName[way] >= 0 ? `named|${wName[way]}` : 'plaza';
      default: return wName[way] >= 0 ? `named|${wName[way]}` : 'path';
    }
  }

  const runType = key => (key === 'stairs' ? 'stairs' : key === 'ramp' ? 'ramp' : key.startsWith('cross|') ? 'cross' : 'walk');

  /** Returns { noun } for "follow"-style runs or { verb } for actions, in plain English. */
  function describeRun(run, pathNodes, avoidPlaces) {
    const way = run.way, flags = run.flags;
    const name = wName[way] >= 0 ? names[wName[way]] : null;
    const near = wNear[way] >= 0 ? names[wNear[way]] : null;
    switch (runType(run.key)) {
      case 'stairs': {
        const known = [...run.stairWays].reduce((sum, w) => sum + wSteps[w], 0);
        const detail = known ? ` (${known} steps)` : run.stairWays.size > 1 ? ` (${run.stairWays.size} flights)` : '';
        return { verb: `Take the stairs${detail}` };
      }
      case 'ramp': return { verb: 'Use the ramp beside the stairs' };
      case 'cross': {
        const how = flags & FLAG.SIGNAL ? ' at the signals' : flags & FLAG.MARKED ? ' at the marked crossing' : '';
        return { verb: `Cross ${near ?? name ?? 'the road'}${how}` };
      }
      default:
    }
    switch (wKind[way]) {
      case KIND.sidewalk: return { noun: near ? `the sidewalk along ${near}` : name ?? 'the sidewalk' };
      case KIND.street: return { noun: name ?? 'the street', follow: 'Walk along' };
      case KIND.service: return { noun: name ?? 'the service lane' };
      case KIND.cycleway: return { noun: name ? `the shared path (${name})` : 'the shared path' };
      case KIND.elevator: return { verb: 'Take the elevator' };
      default:
    }
    const middle = pathNodes[(run.start + run.end) >> 1];
    const landmarkNear = () => nearestBuilding(mx[middle], my[middle], 60, avoidPlaces);
    if (wKind[way] === KIND.corridor) {
      const landmark = landmarkNear();
      return { verb: `Go through the indoor passage${landmark >= 0 ? ` past ${places[landmark].name}` : ''}` };
    }
    if (name) return { noun: name };
    if (run.distance >= 40) {
      const landmark = landmarkNear();
      if (landmark >= 0) return { noun: `the path past ${places[landmark].name}` };
    }
    return { noun: run.key === 'plaza' ? 'the pedestrian area' : 'the path', follow: run.key === 'plaza' ? 'Cross' : 'Follow' };
  }

  function buildSteps(pathNodes, pathEdges, profile, from, to) {
    const total = pathEdges.length;
    const isLink = i => wKind[eWay[pathEdges[i]]] === KIND.link;
    let lead = 0;
    while (lead < total && isLink(lead)) lead++;
    let trail = 0;
    while (total - trail > lead && isLink(total - trail - 1)) trail++;

    const runs = [];
    for (let i = lead; i < total - trail; i++) {
      const way = eWay[pathEdges[i]];
      const key = runKey(way, profile);
      let run = runs[runs.length - 1];
      // Unnamed paths get a new step at a real corner; sidewalks and named ways only jog.
      const corner = Boolean(run) && run.key === key && key === 'path'
        && degree[pathNodes[i]] >= 3 && Math.abs(turnAt(pathNodes, pathEdges, i)) > 60;
      if (!run || run.key !== key || corner) {
        run = { key, way, start: i, end: i, distance: 0, flags: 0, stairWays: new Set(), corner };
        runs.push(run);
      }
      run.end = i + 1;
      run.distance += eLen[pathEdges[i]];
      run.flags |= wFlags[way];
      if (wKind[way] === KIND.steps) run.stairWays.add(way);
    }
    // Fold slivers (a few metres of connecting path) into the walk next to them.
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const sliver = run.key === 'path' || run.key === 'plaza' ? 15 : 8;
      if (runType(run.key) !== 'walk' || run.distance >= sliver) continue;
      const before = runs[i - 1], after = runs[i + 1];
      if (before && runType(before.key) === 'walk') {
        before.end = run.end;
        before.distance += run.distance;
      } else if (after && runType(after.key) === 'walk') {
        after.start = run.start;
        after.distance += run.distance;
      } else {
        continue;
      }
      runs.splice(i--, 1);
    }
    // Folding a sliver can leave the same street on both sides of it; say it once.
    for (let i = 1; i < runs.length; i++) {
      const before = runs[i - 1], run = runs[i];
      if (run.key !== before.key || run.corner || runType(run.key) !== 'walk') continue;
      before.end = run.end;
      before.distance += run.distance;
      runs.splice(i--, 1);
    }

    const coordsOf = (start, end) => pathNodes.slice(start, end + 1).map(nodeLngLat);
    const lengthOf = (start, end) => {
      let sum = 0;
      for (let i = start; i < end; i++) sum += eLen[pathEdges[i]];
      return sum;
    };
    const avoid = [from.place?.index, to.place?.index].filter(Number.isInteger);
    const steps = [{
      type: 'depart', text: departText(from), distance: lengthOf(0, lead), coords: coordsOf(0, lead), edges: [0, lead],
    }];
    runs.forEach((run, index) => {
      const spoken = describeRun(run, pathNodes, avoid);
      const turn = index === 0 && lead > 0 ? '' : turnPhrase(turnAt(pathNodes, pathEdges, run.start));
      let text;
      if (spoken.verb) {
        text = turn ? `${turn} and ${spoken.verb[0].toLowerCase()}${spoken.verb.slice(1)}` : spoken.verb;
      } else {
        text = turn ? `${turn} onto ${spoken.noun}` : `${spoken.follow ?? 'Follow'} ${spoken.noun}`;
      }
      const type = runType(run.key);
      const last = steps[steps.length - 1];
      if (type === 'walk' && last.type === 'walk' && last.text === text) {
        // Same instruction twice in a row (a corner too gentle to announce): keep one step.
        last.distance += run.distance;
        last.edges = [last.edges[0], run.end];
        last.coords = coordsOf(last.edges[0], run.end);
        return;
      }
      steps.push({ type, text, distance: run.distance, coords: coordsOf(run.start, run.end), edges: [run.start, run.end] });
    });
    steps.push({
      type: 'arrive', text: arriveText(to), distance: lengthOf(total - trail, total),
      coords: coordsOf(total - trail, total), edges: [total - trail, total],
    });
    return steps;
  }

  const GENERIC_DOOR_WORD = /^(Main|Entrance|Side|Rear|Back|Front|North|South|East|West|Accessible|Secondary|Station|Platform)\b/;
  /** "Main entrance" -> "main entrance", but street and building names keep their capitals. */
  const doorPhrase = name => (GENERIC_DOOR_WORD.test(name) ? name[0].toLowerCase() + name.slice(1) : name);
  /** A `src:'none'` door named "Nearest mapped path" is only a snap point, not a door. */
  const isSnapPoint = door => !door || (door.src === 'none' && (!door.name || door.name === 'Nearest mapped path'));

  function departText(end) {
    if (!end.place) return 'Start at the dropped pin';
    const door = end.door;
    if (isSnapPoint(door)) return `Start on the mapped path nearest ${end.place.name}`;
    if (door.src === 'uoft') return `Leave via ${door.name.replace(/\.$/, '')}`;
    return `Leave ${end.place.name} by the ${doorPhrase(door.name)}`;
  }

  function arriveText(end) {
    if (!end.place) return 'Arrive at the dropped pin';
    const door = end.door;
    if (isSnapPoint(door)) return `Arrive beside ${end.place.name} (its entrance is not mapped)`;
    if (door.src === 'uoft') return `Arrive at ${door.name.replace(/\.$/, '')}`;
    return `Arrive at ${end.place.name} by the ${doorPhrase(door.name)}`;
  }

  // ----- routing -----
  function route(request) {
    const { from, to, profile = 'walk', closedEdges, closedEntrances, _rampWays } = request ?? {};
    const speed = PROFILES.find(p => p.id === profile)?.speed;
    if (!speed) return failure('bad-input', `Unknown travel profile "${profile}".`);
    const start = endpoint(from), finish = endpoint(to);
    if (start.error) return failure('bad-input', `Start: ${start.error}.`);
    if (finish.error) return failure('bad-input', `Destination: ${finish.error}.`);
    if (start.place && start.place === finish.place) {
      return failure('same', 'Start and destination are the same place.');
    }
    const closedDoors = new Set(closedEntrances ?? []);
    const origin = start.place ? doorsOf(start.place.index, profile, closedDoors) : pinDoors(start.lngLat);
    if (!origin.doors.length) return doorFailure(start, origin.reason);
    const goal = finish.place ? doorsOf(finish.place.index, profile, closedDoors) : pinDoors(finish.lngLat);
    if (!goal.doors.length) return doorFailure(finish, goal.reason);

    let cost = costs[profile];
    if (_rampWays) {
      cost = cost.slice();
      for (const way of _rampWays) for (const e of stairEdges.get(way) ?? []) cost[e] = rampCost[e];
    }
    const targets = new Map();
    for (const door of goal.doors) {
      if (!(targets.get(door.node) <= door.penalty)) targets.set(door.node, door.penalty);
    }
    const { best, bestNode } = shortest({
      cost, closed: edgeMask(closedEdges), sources: origin.doors, dist: routeDist, prevEdge: routePrev, targets,
    });
    if (best === Infinity) {
      return failure('unreachable', profile === 'stepfree'
        ? 'No step-free route connects these places with the current barriers.'
        : 'No route connects these places with the current barriers.');
    }

    const pathEdges = [];
    const pathNodes = [bestNode];
    for (let node = bestNode; routePrev[node] !== -1;) {
      const e = routePrev[node];
      pathEdges.push(e);
      node = eA[e] === node ? eB[e] : eA[e];
      pathNodes.push(node);
    }
    pathEdges.reverse();
    pathNodes.reverse();
    if (!pathEdges.length) {
      return failure('same', 'Those two places share an entrance, so you are already there.');
    }
    const cheapestAt = (doors, node) => doors.filter(door => door.node === node)
      .sort((a, b) => a.penalty - b.penalty)[0]?.entrance ?? null;
    start.door = cheapestAt(origin.doors, pathNodes[0]);
    finish.door = cheapestAt(goal.doors, bestNode);

    let distance = 0, roughMeters = 0, limited = false, indoor = false;
    const flights = new Set();
    for (const e of pathEdges) {
      const way = eWay[e], flags = wFlags[way];
      distance += eLen[e];
      if (wKind[way] === KIND.corridor) indoor = true;
      if (flags & (FLAG.ROUGH | FLAG.UNPAVED)) roughMeters += eLen[e];
      if (flags & FLAG.LIMITED) limited = true;
      if (wKind[way] === KIND.steps && !((flags & FLAG.RAMP) && profile !== 'walk')) flights.add(way);
    }
    let stairCount = 0, stairSeconds = 0;
    for (const way of flights) {
      stairCount += wSteps[way];
      stairSeconds += (wSteps[way] || UNKNOWN_FLIGHT_STEPS) * SECONDS_PER_STEP;
    }

    const stepfree = profile === 'stepfree';
    const ends = [[start, origin], [finish, goal]];
    // A transit stop or landmark has no door to verify; only buildings and the venue do.
    const unverified = ([end, set]) => set.unverified === true
      && (end.place?.type === 'building' || end.place?.type === 'venue');
    const flags = {
      unverifiedDoor: stepfree && ends.some(unverified),
      manualDoor: stepfree && ends.some(([end]) => end.door !== null && end.door.access === 'stepfree' && isManualDoor(end.door)),
      usesLift: ends.some(([end]) => end.door?.lift === true),
      roughMeters,
    };
    const warnings = [];
    for (const [end, set] of ends) {
      if (!end.place || !end.door) continue;
      if (stepfree && unverified([end, set])) {
        warnings.push(`${end.place.name} has no documented step-free entrance, so this door's accessibility is unverified.`);
      } else if (stepfree && isManualDoor(end.door)) {
        warnings.push(`The step-free door at ${end.place.name} is manual, with no power operator.`);
      }
      if (end.door.lift) warnings.push(`The entrance at ${end.place.name} relies on a lift.`);
    }
    if (roughMeters >= 5) warnings.push(`About ${Math.round(roughMeters)} m of this route is unpaved or rough.`);
    if (stepfree && limited) warnings.push('Part of this route is tagged as limited for wheelchairs in OpenStreetMap.');
    if (indoor) warnings.push('Part of this route passes through a building; opening hours may apply.');

    return {
      ok: true, profile, from, to, distance,
      duration: distance / speed + stairSeconds / 60,
      coords: pathNodes.map(nodeLngLat),
      edges: pathEdges,
      steps: buildSteps(pathNodes, pathEdges, profile, start, finish),
      stairs: { flights: flights.size, steps: stairCount },
      entrance: { from: start.door?.index ?? null, to: finish.door?.index ?? null },
      warnings, flags,
    };
  }

  // ----- search -----
  const searchable = label => {
    const name = normalise(label);
    return { label, name, words: name.split(' ') };
  };
  const searchIndex = places.map(place => ({
    ...searchable(place.name),
    code: place.code ? place.code.toLowerCase() : '',
    aka: (place.aka ?? []).map(searchable).filter(alias => alias.name),
  }));
  const TYPE_BOOST = { venue: 9, building: 6, transit: 3, landmark: 0 };
  const ALIAS_DISCOUNT = 2; // an alternate name ranks just below the same match on the official name

  function placeSubtitle(place) {
    if (place.type === 'building') return [place.code, place.addr].filter(Boolean).join(' · ') || 'Building';
    if (place.type === 'venue') return place.addr ? `ONHacks venue · ${place.addr}` : 'ONHacks venue';
    if (place.type === 'transit') return 'Transit';
    return place.addr || 'Landmark';
  }

  const startsEveryToken = (entry, tokens) => tokens.every(token => entry.words.some(word => word.startsWith(token)));

  function nameScore(entry, query, tokens, boost) {
    if (entry.name === query) return 90 + boost;
    if (entry.name.startsWith(query)) return 80 + boost;
    if (startsEveryToken(entry, tokens)) return 68 + boost;
    if (tokens.every(token => entry.name.includes(token))) return 50 + boost;
    return 0;
  }

  /** Returns { score, alias }: alias is the alternate name that matched, when one beat the official name. */
  function scorePlace(place, entry, query, tokens) {
    if (entry.code && entry.code === query) return { score: 100, alias: null };
    if (place.type === 'venue' && startsEveryToken(entry, tokens)) return { score: 99, alias: null };
    const boost = TYPE_BOOST[place.type] ?? 0;
    let score = nameScore(entry, query, tokens, boost);
    if (score < 60 && entry.code && entry.code.startsWith(query)) score = 60;
    let alias = null;
    for (const other of entry.aka) {
      const aliasScore = nameScore(other, query, tokens, boost) - ALIAS_DISCOUNT;
      if (aliasScore > score) {
        score = aliasScore;
        alias = other.label;
      }
    }
    return { score, alias };
  }

  function roomResult(placeIndex, parsed, score) {
    const place = places[placeIndex];
    const label = `${place.code || parsed.code} ${parsed.room}`; // a former code typed by the user shows the current one
    return {
      score, placeIndex, kind: 'room', title: label, subtitle: `${place.name} · ${parsed.floorLabel}`,
      room: { label, floor: parsed.floor, floorLabel: parsed.floorLabel },
    };
  }

  function search(text, { limit = 8 } = {}) {
    const query = normalise(text);
    if (!query) return [];
    const tokens = query.split(' ');
    const results = [];

    const parsed = parseRoom(text, code => codeIndex.has(code));
    if (parsed) {
      results.push(roomResult(codeIndex.get(parsed.code), parsed, 120));
    } else {
      // "bahen 1130": a place name followed by a room number.
      const split = /^(.*[a-z])\s+([a-z]{0,2}\d{3,5}[a-z]?)$/.exec(query);
      const head = split && search(split[1], { limit: 1 })[0];
      const code = head?.kind === 'place' ? places[head.placeIndex].code : null;
      const named = code && parseRoom(`${code} ${split[2]}`);
      if (named) results.push(roomResult(head.placeIndex, named, 110));
    }

    places.forEach((place, index) => {
      const { score, alias } = scorePlace(place, searchIndex[index], query, tokens);
      if (score > 0) {
        const subtitle = alias ? `Also known as ${alias} · ${placeSubtitle(place)}` : placeSubtitle(place);
        results.push({ score, placeIndex: index, kind: 'place', title: place.name, subtitle });
      }
      for (const office of place.rooms ?? []) {
        const officeName = normalise(office.n);
        if (!officeName || !tokens.every(token => officeName.includes(token))) continue;
        const officeRoom = office.r && place.code ? parseRoom(`${place.code} ${office.r}`) : null;
        const where = office.r ? `Room ${office.r}` : office.f ? `Floor ${office.f}` : '';
        const room = officeRoom
          ? { label: `${officeRoom.code} ${officeRoom.room}`, floor: officeRoom.floor, floorLabel: officeRoom.floorLabel }
          : office.f ? { label: `Floor ${office.f}`, floor: Number(office.f), floorLabel: `Floor ${office.f}` }
            : undefined;
        results.push({
          score: officeName.startsWith(query) ? 58 : 46, placeIndex: index, kind: 'office', title: office.n,
          subtitle: [place.code, where, place.name].filter(Boolean).join(' · '), ...(room ? { room } : {}),
        });
      }
    });

    results.sort((a, b) => b.score - a.score || a.title.length - b.title.length || a.title.localeCompare(b.title));
    return results.slice(0, Math.max(0, limit)).map(({ score, ...result }) => result);
  }

  function floorsOf(placeIndex) {
    const place = places[placeIndex];
    if (!place) throw new RangeError(`place index ${placeIndex} is outside 0..${places.length - 1}`);
    const height = Number.isFinite(place.h) && place.h > 0 ? place.h : null;
    if (place.levels > 0) return { levels: place.levels, source: 'osm', height };
    // 4.6 m per storey fits the campus buildings whose level count is known; `fmax` is the
    // highest floor U of T's own listings mention, so the estimate never falls below it.
    const mentioned = place.fmax > 0 ? place.fmax : 0;
    if (height || mentioned) {
      return { levels: Math.max(1, height ? Math.round(height / 4.6) : 0, mentioned), source: 'estimated', height };
    }
    return { levels: 1, source: 'unknown', height: null };
  }

  // ----- access audit -----
  /**
   * Compares walking and step-free travel between every pair of campus buildings, then
   * ranks stair ways by how much step-free travel a ramp there would save.
   *
   * `doorPolicy` is 'verified' where the university documents its doors: only doors known to
   * be step-free count. Where the only door data is OpenStreetMap tags (`meta.doorData` is
   * 'osm') it is 'mapped': every door not known to have steps counts, so the audit measures
   * the paths between buildings rather than the doors.
   *
   * Summary distances are true path lengths. Fix savings are in the router's cost metres
   * (length with surface and street weights, plus door penalties), because that is the
   * quantity the single-edge identity is exact for; `example` holds true route lengths.
   */
  async function audit({ closedEdges, closedEntrances, onProgress } = {}) {
    const started = Date.now();
    const closedList = closedEdges ? [...closedEdges] : [];
    const closedDoorList = closedEntrances ? [...closedEntrances] : [];
    const closed = edgeMask(closedList);
    const closedDoors = new Set(closedDoorList);
    const order = buildingIndexes;
    const n = order.length;
    const doorPolicy = meta.doorData === 'osm' ? 'mapped' : 'verified';
    const walkDoors = order.map(pi => doorsOf(pi, 'walk', closedDoors).doors);
    const stepfreeDoors = order.map(pi => doorsOf(pi, 'stepfree', closedDoors, doorPolicy === 'verified').doors);
    const walk = new Float32Array(n * n).fill(Infinity);
    const stepfree = new Float32Array(n * n).fill(Infinity);
    const stepfreeCost = new Float32Array(n * n).fill(Infinity);
    const stepfreeFrom = new Array(n).fill(null); // cost from building i's doors to every node
    const dist = new Float64Array(nodeCount);
    const real = new Float64Array(nodeCount);

    const cheapestDoor = doors => {
      let bestCost = Infinity, bestNode = -1;
      for (const door of doors) {
        if (dist[door.node] + door.penalty < bestCost) {
          bestCost = dist[door.node] + door.penalty;
          bestNode = door.node;
        }
      }
      return { bestCost, bestNode };
    };

    for (let i = 0; i < n; i++) {
      if (walkDoors[i].length) {
        shortest({ cost: costs.walk, closed, sources: walkDoors[i], dist, real });
        for (let j = 0; j < n; j++) {
          const { bestNode } = cheapestDoor(walkDoors[j]);
          if (bestNode >= 0) walk[i * n + j] = real[bestNode];
        }
      }
      if (stepfreeDoors[i].length) {
        shortest({ cost: costs.stepfree, closed, sources: stepfreeDoors[i], dist, real });
        stepfreeFrom[i] = Float32Array.from(dist);
        for (let j = 0; j < n; j++) {
          const { bestCost, bestNode } = cheapestDoor(stepfreeDoors[j]);
          if (bestNode >= 0) {
            stepfreeCost[i * n + j] = bestCost;
            stepfree[i * n + j] = real[bestNode];
          }
        }
      }
      if ((i & 3) === 3 || i === n - 1) {
        onProgress?.(i + 1, n);
        await tick();
      }
    }

    // ----- summary -----
    // Only pairs where both buildings have a door the policy accepts are audited; the rest are
    // reported as buildings (noStepFreeDoor) rather than as failed journeys.
    const hasDoor = stepfreeDoors.map(doors => doors.length > 0);
    let audited = 0, reachable = 0, detoured = 0, sumWalk = 0, sumStepfree = 0, totalExtra = 0;
    const pairs = [];
    const perPlace = order.map(() => ({ extra: 0, reachable: 0, detoured: 0 }));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (!hasDoor[i] || !hasDoor[j]) continue;
        audited++;
        const w = walk[i * n + j], s = stepfree[i * n + j];
        if (s === Infinity) continue;
        const extra = Math.max(0, s - w);
        reachable++;
        sumWalk += w;
        sumStepfree += s;
        totalExtra += extra;
        for (const k of [i, j]) {
          perPlace[k].extra += extra;
          perPlace[k].reachable++;
          if (extra >= DETOUR_THRESHOLD) perPlace[k].detoured++;
        }
        if (extra >= DETOUR_THRESHOLD) detoured++;
        if (extra > 0) pairs.push({ a: order[i], b: order[j], walk: w, stepfree: s, extra });
      }
    }
    const journeys = n * (n - 1) / 2;
    pairs.sort((p, q) => q.extra - p.extra);

    // ----- fix-first ranking -----
    const scratch = new Float64Array(nodeCount);
    const ranked = [];
    for (const stair of stairList) {
      if (stair.ramp) continue;
      const added = stair.edges.filter(e => rampCost[e] !== Infinity && !(closed && closed[e]));
      if (!added.length) continue;
      const hub = [...new Set(added.flatMap(e => [eA[e], eB[e]]))];
      const k = hub.length;
      const slot = new Map(hub.map((node, i) => [node, i]));
      // Cheapest cost between the stair's own nodes once it is ramped.
      const between = new Float64Array(k * k).fill(Infinity);
      for (let i = 0; i < k; i++) between[i * k + i] = 0;
      let chain = 0;
      for (const e of added) {
        const i = slot.get(eA[e]), j = slot.get(eB[e]);
        chain += rampCost[e];
        if (rampCost[e] < between[i * k + j]) between[i * k + j] = between[j * k + i] = rampCost[e];
      }
      const close = () => {
        for (let via = 0; via < k; via++) {
          for (let i = 0; i < k; i++) {
            for (let j = 0; j < k; j++) {
              const through = between[i * k + via] + between[via * k + j];
              if (through < between[i * k + j]) between[i * k + j] = through;
            }
          }
        }
      };
      if (k > 2) {
        close();
        // Existing step-free links between the stair's nodes only matter if they beat the
        // ramped stair itself, so the search can stop at the stair's total cost.
        const limit = between.every(Number.isFinite) ? chain : Infinity;
        for (let i = 0; i < k; i++) {
          shortest({ cost: costs.stepfree, closed, sources: [{ node: hub[i], penalty: 0 }], dist: scratch, limit });
          for (let j = 0; j < k; j++) {
            const existing = scratch[hub[j]];
            if (existing <= limit && existing < between[i * k + j]) between[i * k + j] = between[j * k + i] = existing;
          }
        }
        close();
      }
      // toHub[i][x]: building i -> hub node x on the current network; viaHub adds the best hop across the stair.
      const toHub = new Float64Array(n * k).fill(Infinity);
      const viaHub = new Float64Array(n * k).fill(Infinity);
      for (let i = 0; i < n; i++) {
        if (!stepfreeFrom[i]) continue;
        for (let x = 0; x < k; x++) toHub[i * k + x] = stepfreeFrom[i][hub[x]];
        for (let y = 0; y < k; y++) {
          let bestVia = Infinity;
          for (let x = 0; x < k; x++) bestVia = Math.min(bestVia, toHub[i * k + x] + between[x * k + y]);
          viaHub[i * k + y] = bestVia;
        }
      }
      let savedMeters = 0, improved = 0, newlyConnected = 0, maxSaving = 0, example = null, firstNew = null;
      for (let i = 0; i < n; i++) {
        if (!stepfreeFrom[i]) continue;
        for (let j = i + 1; j < n; j++) {
          if (!stepfreeFrom[j]) continue;
          let after = Infinity;
          for (let y = 0; y < k; y++) after = Math.min(after, viaHub[i * k + y] + toHub[j * k + y]);
          const before = stepfreeCost[i * n + j];
          if (!(after < before - 0.01)) continue;
          if (before === Infinity) {
            newlyConnected++;
            firstNew ??= [i, j];
            continue;
          }
          savedMeters += before - after;
          if (before - after > 0.5) improved++;
          if (before - after > maxSaving) {
            maxSaving = before - after;
            example = [i, j];
          }
        }
      }
      if (savedMeters > 1 || newlyConnected > 0) {
        ranked.push({ stair, savedMeters, improved, newlyConnected, maxSaving, pair: example ?? firstNew });
      }
    }
    ranked.sort((p, q) => q.savedMeters - p.savedMeters || q.newlyConnected - p.newlyConnected || p.stair.id - q.stair.id);

    const fixes = ranked.slice(0, 15).map(({ stair, savedMeters, improved, newlyConnected, maxSaving, pair }) => {
      const nearby = nearestBuilding(stair.x, stair.y, Infinity);
      const street = wName[stair.id] >= 0 ? names[wName[stair.id]] : null;
      const where = street ? `on ${street}` : nearby >= 0 ? `near ${places[nearby].name}` : '';
      const label = `Stairs ${where}`.trim() + (stair.steps ? ` (${stair.steps} steps)` : '');
      let exampleRoutes = null;
      if (pair) {
        const query = { from: order[pair[0]], to: order[pair[1]], profile: 'stepfree', closedEdges: closedList, closedEntrances: closedDoorList };
        const before = route(query);
        const after = route({ ...query, _rampWays: [stair.id] });
        exampleRoutes = {
          a: query.from, b: query.to,
          before: before.ok ? before.distance : null, after: after.ok ? after.distance : null,
        };
      }
      return {
        id: stair.id, type: 'stairs', edges: stair.edges.slice(), lngLat: stair.lngLat.slice(), label,
        steps: stair.steps, length: stair.length, savedMeters, journeys: improved, maxSaving, newlyConnected,
        example: exampleRoutes,
      };
    });

    return {
      buildings: n, journeys, doorPolicy,
      buildingsWithDoor: hasDoor.filter(Boolean).length,
      audited, reachable, unreachable: audited - reachable, detoured,
      // These cover the reachable journeys only, so walking and step-free compare like for like.
      meanWalk: reachable ? sumWalk / reachable : 0,
      meanStepfree: reachable ? sumStepfree / reachable : 0,
      meanExtra: reachable ? totalExtra / reachable : 0,
      totalExtra,
      worst: pairs.slice(0, 10),
      noStepFreeDoor: order.filter((_, i) => !hasDoor[i]),
      stairsOnly: order.filter(pi => {
        const open = places[pi].ent.filter(ei => !closedDoors.has(ei));
        return open.length > 0 && open.every(ei => entrances[ei].access === 'steps');
      }),
      places: order.map((placeIndex, i) => ({
        placeIndex,
        meanExtra: perPlace[i].reachable ? perPlace[i].extra / perPlace[i].reachable : 0,
        detouredShare: perPlace[i].reachable ? perPlace[i].detoured / perPlace[i].reachable : 0,
        reachable: stepfreeDoors[i].length > 0,
      })),
      fixes,
      elapsedMs: Date.now() - started,
      // Row-major n x n matrices in `order`; Infinity where there is no route.
      matrix: { order: order.slice(), walk, stepfree, stepfreeCost },
    };
  }

  return {
    meta, names, notices: dataset.notices ?? [], places, entrances, nodeCount, edgeCount,
    toLngLat, decodeLine, nodeLngLat,
    search, parseRoom, floorsOf, route,
    segmentOf, nearestEdge, edgeLine, edgeInfo, stairWays, audit,
  };
}
