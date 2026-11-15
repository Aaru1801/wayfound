/**
 * Wayfound's illustrative Harbour Campus routing model.
 * Coordinates, distances, inclines and facilities are invented for the demo.
 * All links are bidirectional. Slopes are absolute percentages, not degrees.
 */
export const nodes = [
  { id: 'transit', label: 'Harbour transit stop', x: 150, y: 560, kind: 'place' },
  { id: 'student-centre', label: 'Student centre', x: 290, y: 320, kind: 'place' },
  { id: 'library', label: 'North library', x: 760, y: 180, kind: 'place' },
  { id: 'science-hall', label: 'Science hall', x: 780, y: 520, kind: 'place' },
  { id: 'garden', label: 'Community garden', x: 490, y: 600, kind: 'place' },
  { id: 'east-entrance', label: 'East entrance', x: 900, y: 390, kind: 'place' },
  { id: 'plaza', label: 'Central plaza', x: 480, y: 390, kind: 'junction' },
  { id: 'lift-base', label: 'Library lift entrance', x: 630, y: 290, kind: 'junction' },
  { id: 'library-landing', label: 'Library terrace', x: 760, y: 275, kind: 'junction' },
  { id: 'garden-gate', label: 'East garden gate', x: 870, y: 570, kind: 'junction' },
];

const edge = (id, from, to, meters, slope, label, extra = {}) => ({
  id, from, to, meters, slope, label,
  surface: 'paved', stairs: false, elevator: false,
  ...extra,
});

export const edges = [
  edge('transit-walk', 'transit', 'student-centre', 165, 2, 'Harbour walk'),
  edge('campus-walk', 'student-centre', 'plaza', 105, 1, 'Campus promenade'),
  edge('library-stairs', 'plaza', 'library', 150, 12, 'Library steps', { stairs: true }),
  edge('lift-approach', 'plaza', 'lift-base', 105, 2, 'West library approach'),
  edge('library-lift', 'lift-base', 'library-landing', 45, 0, 'Library lift', { elevator: true }),
  edge('library-entry', 'library-landing', 'library', 70, 1, 'Library terrace'),
  edge('garden-walk', 'transit', 'garden', 190, 1, 'South garden walk'),
  edge('garden-path', 'garden', 'garden-gate', 230, 2, 'Garden perimeter path'),
  edge('garden-ramp', 'garden-gate', 'library-landing', 220, 4.5, 'East garden ramp'),
  edge('science-garden', 'garden', 'science-hall', 180, 3, 'Science garden link'),
  edge('science-east', 'science-hall', 'east-entrance', 100, 1, 'Science avenue'),
  edge('east-gate', 'east-entrance', 'garden-gate', 120, 2, 'East entrance path'),
  edge('plaza-science', 'plaza', 'science-hall', 190, 2, 'Science promenade'),
  edge('courtyard-shortcut', 'transit', 'plaza', 240, 1, 'Gravel courtyard', { surface: 'gravel' }),
  edge('steep-hill', 'plaza', 'library-landing', 120, 9, 'Terrace hill'),
];

export const profiles = {
  wheelchair: { label: 'Wheelchair', speedMetersPerMinute: 60, maxSlope: 5, avoidRough: true, allowStairs: false },
  stroller: { label: 'Stroller', speedMetersPerMinute: 65, maxSlope: 8, avoidRough: true, allowStairs: false },
  walking: { label: 'Walking', speedMetersPerMinute: 80, maxSlope: 20, avoidRough: false, allowStairs: true },
};

const nodeById = new Map(nodes.map(node => [node.id, node]));

function optionsFor(options = {}) {
  const profileKey = options.profile ?? 'wheelchair';
  const profile = Object.hasOwn(profiles, profileKey) ? profiles[profileKey] : null;
  if (!profile) throw new TypeError('Unknown travel profile.');
  const maxSlope = options.maxSlope ?? profile.maxSlope;
  if (typeof maxSlope !== 'number' || !Number.isFinite(maxSlope) || maxSlope < 0) {
    throw new TypeError('Maximum slope must be a non-negative percentage.');
  }
  return {
    ...options,
    profile,
    maxSlope,
    avoidRough: options.avoidRough ?? profile.avoidRough,
    closedEdges: new Set(options.closedEdges ?? []),
  };
}

function exclusionReason(link, options) {
  if (options.closedEdges.has(link.id)) return 'Reported closed';
  if (link.stairs && !options.profile.allowStairs) return 'Stairs do not match your step-free profile';
  if (link.slope > options.maxSlope) return `${link.slope}% incline exceeds your ${options.maxSlope}% limit`;
  if (options.avoidRough && link.surface !== 'paved') return 'Unpaved surface excluded by your preferences';
  return null;
}

/** Explain constraints across the demo network; this is not a route-specific risk assessment. */
export function explainExclusions(options = {}) {
  const normalized = optionsFor(options);
  return edges.flatMap(link => {
    const reason = exclusionReason(link, normalized);
    return reason ? [{ edgeId: link.id, label: link.label, reason }] : [];
  });
}

function instructionFor(link, nextNode) {
  if (link.elevator) return `Take the Library lift toward ${nextNode.label.toLowerCase()}.`;
  if (link.stairs) return `Take the library steps toward ${nextNode.label.toLowerCase()}.`;
  if (link.id === 'garden-ramp') return `Follow the East garden ramp (${link.slope}% incline) toward ${nextNode.label.toLowerCase()}.`;
  return `Follow ${link.label.toLowerCase()} for ${link.meters} m toward ${nextNode.label.toLowerCase()}.`;
}

/**
 * Find the shortest-distance route after removing incompatible or closed links.
 * Dijkstra with deterministic tie handling; O(V² + E) for this small graph.
 * Returns null when no allowed route exists, never silently relaxes constraints.
 * Time is an estimate from profile speed + a 1-minute lift allowance.
 */
export function findRoute(options = {}) {
  const normalized = optionsFor(options);
  const { from, to } = normalized;
  if (!nodeById.has(from) || !nodeById.has(to)) return null;

  const adjacency = new Map(nodes.map(node => [node.id, []]));
  for (const link of edges) {
    if (exclusionReason(link, normalized)) continue;
    adjacency.get(link.from).push({ node: link.to, link });
    adjacency.get(link.to).push({ node: link.from, link });
  }

  const distances = new Map(nodes.map(node => [node.id, Infinity]));
  const previous = new Map();
  const remaining = new Set(nodes.map(node => node.id));
  distances.set(from, 0);
  while (remaining.size) {
    let current = null;
    let best = Infinity;
    for (const id of remaining) {
      if (distances.get(id) < best) { current = id; best = distances.get(id); }
    }
    if (current === null) break;
    if (current === to) break;
    remaining.delete(current);
    for (const neighbor of adjacency.get(current)) {
      if (!remaining.has(neighbor.node)) continue;
      const candidate = best + neighbor.link.meters;
      if (candidate < distances.get(neighbor.node)) {
        distances.set(neighbor.node, candidate);
        previous.set(neighbor.node, { node: current, link: neighbor.link });
      }
    }
  }
  if (!Number.isFinite(distances.get(to))) return null;

  const nodeIds = [to];
  const pathEdges = [];
  let cursor = to;
  while (cursor !== from) {
    const prior = previous.get(cursor);
    pathEdges.unshift(prior.link);
    nodeIds.unshift(prior.node);
    cursor = prior.node;
  }
  const distanceMeters = distances.get(to);
  const liftMinutes = pathEdges.filter(link => link.elevator).length;
  return {
    nodeIds,
    edgeIds: pathEdges.map(link => link.id),
    distanceMeters,
    durationMinutes: Math.round((distanceMeters / normalized.profile.speedMetersPerMinute + liftMinutes) * 10) / 10,
    maxSlope: Math.max(0, ...pathEdges.map(link => link.slope)),
    steps: pathEdges.map((link, index) => ({
      edgeId: link.id,
      from: nodeIds[index],
      to: nodeIds[index + 1],
      label: link.label,
      meters: link.meters,
      instruction: instructionFor(link, nodeById.get(nodeIds[index + 1])),
    })),
    hasElevator: pathEdges.some(link => link.elevator),
    hasStairs: pathEdges.some(link => link.stairs),
    roughMeters: pathEdges.filter(link => link.surface !== 'paved').reduce((sum, link) => sum + link.meters, 0),
  };
}
