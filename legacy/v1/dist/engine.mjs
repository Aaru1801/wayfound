import { waterloo } from './waterloo.mjs';
import { mcmaster } from './mcmaster.mjs';

export const campuses = { waterloo, mcmaster };

export const profiles = {
  wheelchair: { label: 'Step-free', speedMetersPerMinute: 60, maxSlope: 5, avoidRough: true, allowStairs: false },
  stroller: { label: 'Stroller', speedMetersPerMinute: 65, maxSlope: 8, avoidRough: true, allowStairs: false },
  walking: { label: 'Walking', speedMetersPerMinute: 80, maxSlope: 20, avoidRough: false, allowStairs: true },
};

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

function instructionFor(link, nextNode) {
  if (link.elevator) return `Take ${link.label} toward ${nextNode.label}.`;
  if (link.stairs) return `Use ${link.label} toward ${nextNode.label}.`;
  if (link.id === 'garden-ramp') return `Follow ${link.label} (${link.slope}% incline) toward ${nextNode.label}.`;
  return `Follow ${link.label} for ${link.meters} m toward ${nextNode.label}.`;
}

/** Bind a campus graph to the shared route planner. */
export function createRouter(campus) {
  const { nodes, edges } = campus;
  const nodeById = new Map(nodes.map(node => [node.id, node]));

  /** Explain constraints across the demo network; this is not a route-specific risk assessment. */
  function explainExclusions(options = {}) {
    const normalized = optionsFor(options);
    return edges.flatMap(link => {
      const reason = exclusionReason(link, normalized);
      return reason ? [{ edgeId: link.id, label: link.label, reason }] : [];
    });
  }

  /**
   * Find the shortest-distance route after removing incompatible or closed links.
   * Dijkstra with deterministic tie handling; O(V² + E) for this small graph.
   * Returns null when no allowed route exists, never silently relaxes constraints.
   * Time is an estimate from profile speed + a 1-minute lift allowance.
   */
  function findRoute(options = {}) {
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

  return { findRoute, explainExclusions };
}
