import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCampus, parseRoom, KIND, FLAG, PROFILES } from '../src/engine.js';

// Every shipped campus must load, name its default journey, and route it in every profile.
const CAMPUS_IDS = ['waterloo', 'mcmaster', 'uoft'];
const loaded = new Map(CAMPUS_IDS.map(id => {
  const dataset = JSON.parse(readFileSync(new URL(`../data/${id}.json`, import.meta.url), 'utf8'));
  const campus = createCampus(dataset);
  return [id, { dataset, campus, byId: new Map(campus.places.map(place => [place.id, place])) }];
}));

for (const [id, { dataset, campus, byId }] of loaded) {
  test(`${id}: meta names the campus, its start and its quick picks`, () => {
    const { meta } = dataset;
    assert.equal(meta.id, id);
    assert.ok(meta.short && meta.campus);
    assert.ok(['official', 'osm'].includes(meta.doorData), `doorData is ${meta.doorData}`);
    assert.ok(byId.has(meta.start), `start ${meta.start} is not a place`);
    assert.ok(meta.picks.length >= 1 && meta.picks.length <= 4, `${meta.picks.length} picks`);
    for (const pick of meta.picks) assert.ok(byId.has(pick), `pick ${pick} is not a place`);
  });

  test(`${id}: the start reaches every pick in every profile, and step-free avoids stairs`, () => {
    const from = byId.get(dataset.meta.start).index;
    for (const pick of dataset.meta.picks) {
      for (const { id: profile } of PROFILES) {
        const route = campus.route({ from, to: byId.get(pick).index, profile });
        assert.ok(route.ok, `${pick} by ${profile}: ${route.reason}`);
        assert.ok(route.distance > 0 && route.coords.length >= 2);
        if (profile !== 'stepfree') continue;
        assert.equal(route.stairs.flights, 0);
        for (const e of route.edges) {
          const info = campus.edgeInfo(e);
          assert.ok(info.kind !== KIND.steps || (info.flags & FLAG.RAMP) !== 0, `${pick} step-free uses stair edge ${e}`);
        }
      }
    }
  });

  test(`${id}: the audit follows the campus door data`, async () => {
    const audit = await campus.audit();
    assert.equal(audit.doorPolicy, dataset.meta.doorData === 'osm' ? 'mapped' : 'verified');
    assert.ok(audit.audited > 0 && audit.reachable > 0);
    assert.ok(audit.fixes.length > 0);
  });
}

test('waterloo: official accessible entrances are step-free doors', () => {
  const { campus } = loaded.get('waterloo');
  const official = campus.entrances.filter(entrance => entrance.src === 'uw');
  assert.ok(official.length >= 40, `${official.length} official entrances`);
  assert.ok(official.every(entrance => entrance.access === 'stepfree'));
});

test('waterloo: a room number resolves to its building and floor', () => {
  const { campus } = loaded.get('waterloo');
  const [hit] = campus.search('MC 4020');
  assert.equal(hit.kind, 'room');
  assert.equal(campus.places[hit.placeIndex].code, 'MC');
  assert.equal(hit.room.floor, 4);
});

test('parseRoom reads building codes with digits and three letters', () => {
  assert.deepEqual(parseRoom('E7 4043'), { code: 'E7', room: '4043', floor: 4, floorLabel: 'Floor 4' });
  assert.deepEqual(parseRoom('rch 101'), { code: 'RCH', room: '101', floor: 1, floorLabel: 'Floor 1' });
  const known = code => ['QNC', 'E7'].includes(code);
  assert.equal(parseRoom('QNC1502', known).code, 'QNC');
  assert.equal(parseRoom('E74043', known).code, 'E7');
  assert.equal(parseRoom('QNC1502', () => false), null);
});
