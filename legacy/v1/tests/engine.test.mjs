import test from 'node:test';
import assert from 'node:assert/strict';
import { campuses, profiles, createRouter } from '../dist/engine.mjs';

const expectations = {
  waterloo: { walk: 350, stepFree: 420, detour: 570, rough: 220 },
  mcmaster: { walk: 340, stepFree: 470, detour: 810, rough: 230 },
};

test('the campus catalog consists of Waterloo and McMaster', () => {
  assert.deepEqual(Object.keys(campuses), ['waterloo', 'mcmaster']);
});

for (const campus of Object.values(campuses)) {
  const { nodes, edges } = campus;
  const { findRoute, explainExclusions } = createRouter(campus);
  const trip = { from: campus.origin, to: campus.destination };
  const expected = expectations[campus.id];
  const bothClosed = ['library-lift', 'garden-ramp'];
  const check = (name, body) => test(`${campus.shortName}: ${name}`, body);

  check('graph references existing places and has unique positive links', () => {
    const ids = new Set(nodes.map(node => node.id));
    assert.equal(ids.size, nodes.length);
    assert.equal(new Set(edges.map(edge => edge.id)).size, edges.length);
    assert.ok(ids.has(trip.from) && ids.has(trip.to));
    for (const edge of edges) {
      assert.ok(ids.has(edge.from) && ids.has(edge.to));
      assert.ok(edge.meters > 0 && edge.slope >= 0);
    }
  });

  check('walking route uses stairs and gravel at the modeled shortest distance', () => {
    const route = findRoute({ ...trip, profile: 'walking' });
    assert.deepEqual(route.edgeIds, ['courtyard-shortcut', 'library-stairs']);
    assert.equal(route.distanceMeters, expected.walk);
    assert.equal(route.roughMeters, expected.rough);
    assert.equal(route.hasStairs, true);
    assert.equal(findRoute({ ...trip, profile: 'walking', avoidRough: true }).roughMeters, 0);
  });

  check('step-free route uses the lift and respects incline and surface preferences', () => {
    const route = findRoute(trip);
    assert.equal(route.distanceMeters, expected.stepFree);
    assert.ok(route.edgeIds.includes('library-lift'));
    assert.equal(route.hasStairs, false);
    assert.equal(route.maxSlope, 2);
    assert.equal(route.roughMeters, 0);
    const stroller = findRoute({ ...trip, profile: 'stroller' });
    assert.equal(stroller.distanceMeters, expected.stepFree);
    assert.equal(stroller.durationMinutes, Math.round((expected.stepFree / profiles.stroller.speedMetersPerMinute + 1) * 10) / 10);
  });

  check('lift closure sends the route to the ramp and honors the slope limit', () => {
    const closedEdges = ['library-lift'];
    const route = findRoute({ ...trip, closedEdges });
    assert.equal(route.distanceMeters, expected.detour);
    assert.ok(route.edgeIds.includes('garden-ramp'));
    assert.equal(route.hasElevator, false);
    assert.equal(route.maxSlope, 4.5);
    assert.equal(findRoute({ ...trip, closedEdges, maxSlope: 4 }), null);
  });

  check('both closures isolate only the step-free library route, and either repair restores it', () => {
    const reachable = nodes.filter(node => node.kind === 'place' && node.id !== trip.from)
      .filter(node => findRoute({ from: trip.from, to: node.id, closedEdges: bothClosed }));
    assert.deepEqual(reachable.map(node => node.id), nodes.filter(node => node.kind === 'place'
      && node.id !== trip.from && node.id !== trip.to).map(node => node.id));
    assert.equal(findRoute({ ...trip, closedEdges: bothClosed }), null);
    assert.ok(findRoute({ ...trip, profile: 'walking', closedEdges: bothClosed }));
    assert.equal(findRoute({ ...trip, closedEdges: ['garden-ramp'] }).distanceMeters, expected.stepFree);
    assert.equal(findRoute({ ...trip, closedEdges: ['library-lift'] }).distanceMeters, expected.detour);
  });

  check('same-place and disconnected routes return distinct results', () => {
    const closedEdges = edges.map(edge => edge.id);
    const same = findRoute({ from: trip.to, to: trip.to, closedEdges });
    assert.deepEqual(same.nodeIds, [trip.to]);
    assert.deepEqual(same.steps, []);
    assert.equal(same.distanceMeters, 0);
    assert.equal(findRoute({ ...trip, closedEdges }), null);
    assert.equal(findRoute({ ...trip, to: 'missing' }), null);
  });

  check('all default itineraries honor travel constraints and reconcile with their route totals', () => {
    for (const from of nodes) for (const to of nodes) for (const profile of Object.keys(profiles)) {
      const route = findRoute({ from: from.id, to: to.id, profile });
      assert.ok(route);
      assert.equal(route.nodeIds[0], from.id);
      assert.equal(route.nodeIds.at(-1), to.id);
      assert.equal(route.steps.reduce((sum, step) => sum + step.meters, 0), route.distanceMeters);
      assert.equal(route.edgeIds.length + 1, route.nodeIds.length);
      assert.ok(route.maxSlope <= profiles[profile].maxSlope);
      if (!profiles[profile].allowStairs) assert.equal(route.hasStairs, false);
    }
    const reverse = findRoute({ from: trip.to, to: trip.from });
    assert.deepEqual(reverse.edgeIds, findRoute(trip).edgeIds.toReversed());
  });

  check('excluded links and malformed profiles have explicit reasons', () => {
    const byId = new Map(explainExclusions({ ...trip, closedEdges: ['library-lift'] })
      .map(edge => [edge.edgeId, edge.reason]));
    assert.match(byId.get('library-lift'), /closed/i);
    assert.match(byId.get('library-stairs'), /step-free/i);
    assert.match(byId.get('steep-hill'), /9%.*5%/);
    assert.match(byId.get('courtyard-shortcut'), /unpaved/i);
    for (const profile of ['toString', 'constructor', '__proto__']) {
      assert.throws(() => findRoute({ ...trip, profile }), /Unknown travel profile/);
    }
    assert.throws(() => findRoute({ ...trip, maxSlope: -1 }), /non-negative/);
  });
}
