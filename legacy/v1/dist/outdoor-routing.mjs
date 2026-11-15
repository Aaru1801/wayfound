const METERS_PER_DEGREE = 111195;
const MAX_PIN_SNAP_METERS = 85;

function outdoorChart(latitude) {
  const longitudeScale = METERS_PER_DEGREE * Math.cos(latitude * Math.PI / 180);
  return ([lat, lng]) => [lng * longitudeScale, lat * METERS_PER_DEGREE];
}

function outdoorDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function outdoorGraph(network) {
  const { nodes, ways } = network;
  const project = outdoorChart(nodes[0][0]);
  const projected = nodes.map(project);
  const links = nodes.map(() => []);
  const segments = [];
  const stepWays = new Set(network.stepWayIndices ?? []);
  ways.forEach((way, index) => {
    for (let i = 1; i < way.length; i++) {
      const a = way[i - 1], b = way[i];
      const length = outdoorDistance(projected[a], projected[b]);
      if (length <= 0) continue;
      const segment = { a, b, length, steps: stepWays.has(index) };
      segments.push(segment);
      links[a].push({ to: b, ...segment });
      links[b].push({ to: a, ...segment });
    }
  });

  function snap(point) {
    if (!Array.isArray(point) || point.length !== 2 || point.some(v => !Number.isFinite(v))) return null;
    const [x, y] = project(point);
    let best = null;
    for (const segment of segments) {
      const { a, b, length } = segment;
      const [ax, ay] = projected[a], [bx, by] = projected[b];
      const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / (length * length)));
      const distance = Math.hypot(x - (ax + (bx - ax) * t), y - (ay + (by - ay) * t));
      if (distance > MAX_PIN_SNAP_METERS || (best && distance >= best.distance)) continue;
      best = {
        segment, t, distance,
        coordinates: nodes[a].map((v, i) => v + (nodes[b][i] - v) * t),
      };
    }
    return best;
  }

  function shortestLeg(from, to) {
    const a = from.segment, b = to.segment;
    let bestLength = a === b ? Math.abs(from.t - to.t) * a.length : Infinity;
    let end = null;
    const distances = new Float64Array(nodes.length).fill(Infinity);
    const prior = Array(nodes.length).fill(null);
    const heap = new OutdoorMinHeap();
    const initial = new Map([[a.a, from.t * a.length], [a.b, (1 - from.t) * a.length]]);
    const goal = new Map([[b.a, to.t * b.length], [b.b, (1 - to.t) * b.length]]);
    for (const [node, length] of initial) {
      distances[node] = length;
      heap.push({ node, length });
    }
    while (heap.size) {
      const { node, length } = heap.pop();
      if (length >= bestLength) break;
      if (length !== distances[node]) continue;
      const tail = goal.get(node);
      if (tail !== undefined && length + tail < bestLength) {
        bestLength = length + tail;
        end = node;
      }
      for (const link of links[node]) {
        const next = length + link.length;
        if (next < distances[link.to]) {
          distances[link.to] = next;
          prior[link.to] = { node, steps: link.steps };
          heap.push({ node: link.to, length: next });
        }
      }
    }
    if (!Number.isFinite(bestLength)) return null;
    if (end === null) return {
      coordinates: [from.coordinates, to.coordinates],
      distanceMeters: bestLength,
      hasMappedSteps: a.steps && bestLength > 0.01,
    };
    const route = [to.coordinates];
    let hasMappedSteps = b.steps && goal.get(end) > 0.01;
    let cursor = end;
    while (prior[cursor]) {
      route.push(nodes[cursor]);
      hasMappedSteps ||= prior[cursor].steps;
      cursor = prior[cursor].node;
    }
    hasMappedSteps ||= a.steps && initial.get(cursor) > 0.01;
    route.push(nodes[cursor], from.coordinates);
    return { coordinates: route.reverse(), distanceMeters: bestLength, hasMappedSteps };
  }

  return points => {
    if (!Array.isArray(points) || points.length < 2 || points.length > 12) return null;
    const snaps = points.map(snap);
    if (snaps.some(point => !point)) return null;
    const coordinates = [];
    let distanceMeters = 0;
    let hasMappedSteps = false;
    for (let i = 1; i < snaps.length; i++) {
      const leg = shortestLeg(snaps[i - 1], snaps[i]);
      if (!leg) return null;
      coordinates.push(...leg.coordinates.slice(i === 1 ? 0 : 1));
      distanceMeters += leg.distanceMeters;
      hasMappedSteps ||= leg.hasMappedSteps;
    }
    return {
      coordinates, distanceMeters: Math.round(distanceMeters), hasMappedSteps,
      maxSnapMeters: Math.round(Math.max(...snaps.map(point => point.distance))),
    };
  };
}

class OutdoorMinHeap {
  items = [];
  get size() { return this.items.length; }

  push(value) {
    const heap = this.items;
    let index = heap.length;
    heap.push(value);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent].length <= value.length) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = value;
  }

  pop() {
    const heap = this.items;
    const result = heap[0];
    const tail = heap.pop();
    if (!heap.length) return result;
    let index = 0;
    while (index * 2 + 1 < heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < heap.length && heap[child + 1].length < heap[child].length) child++;
      if (heap[child].length >= tail.length) break;
      heap[index] = heap[child];
      index = child;
    }
    heap[index] = tail;
    return result;
  }
}

/** Snap stops onto mapped pedestrian links and route along those links in order. */
export function createOutdoorPlanner(networks) {
  const campusRouters = new Map();
  return (campusId, points) => {
    if (!Object.hasOwn(networks, campusId)) return null;
    if (!campusRouters.has(campusId)) campusRouters.set(campusId, outdoorGraph(networks[campusId]));
    return campusRouters.get(campusId)(points);
  };
}
