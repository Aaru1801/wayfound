import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutdoorPlanner } from '../dist/outdoor-routing.mjs';
import { outdoorNetworks } from '../dist/outdoor-network.mjs';
import { outdoorAnchors } from '../dist/outdoor-anchors.mjs';

const walk = createOutdoorPlanner(outdoorNetworks);
for (const [campus, landmarks] of Object.entries(outdoorAnchors)) {
  test(`${campus}: each building pin routes to transit on the bundled network`, () => {
    for (const [id, point] of Object.entries(landmarks)) {
      const route = walk(campus, [landmarks.transit, point]);
      assert.ok(route, id);
      assert.equal(route.distanceMeters > 0, id !== 'transit');
      assert.equal(route.maxSnapMeters, 0);
      assert.deepEqual(route.coordinates[0], landmarks.transit);
      assert.deepEqual(route.coordinates.at(-1), point);
    }
  });

  test(`${campus}: intermediate stops change the route and are kept in order`, () => {
    const {transit, library, 'student-centre': centre} = landmarks;
    const direct = walk(campus, [transit, library]);
    const via = walk(campus, [transit, centre, library]);
    assert.ok(via.distanceMeters > direct.distanceMeters);
    assert.ok(via.coordinates.some(point => point[0] === centre[0] && point[1] === centre[1]));
    assert.deepEqual(via.coordinates.at(-1), library);
    assert.equal(walk(campus, [[0, 0], library]), null);
  });
}

test('two pins snapped to one segment travel only the partial segment', () => {
  const plan = createOutdoorPlanner({ campus: { nodes: [[43, -80], [43.001, -80]], ways: [[0, 1]], stepWayIndices: [0] } });
  const route = plan('campus', [[43.00025, -80.0001], [43.00075, -80]]);
  assert.equal(route.distanceMeters, 56);
  assert.equal(route.maxSnapMeters, 8);
  assert.equal(route.hasMappedSteps, true);
  assert.ok(route.coordinates.every(point => point[1] === -80));
});
