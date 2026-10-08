const assert = require('node:assert/strict');
const test = require('node:test');
const { cutIntoCells, parseWkt, LEVEL_BY_OFFICIAL } = require('../lib/traffic/freeway');
const { ghDecode } = require('../lib/traffic/geohash');

test('WKT LINESTRING and MULTILINESTRING are parsed into [lng, lat] lines', () => {
  assert.deepEqual(parseWkt('LINESTRING(121.1 25.1,121.2 25.2)'), [[[121.1, 25.1], [121.2, 25.2]]]);
  const multi = parseWkt('MULTILINESTRING((121.1 25.1,121.2 25.2),(121.3 25.3,121.4 25.4))');
  assert.equal(multi.length, 2);
  assert.deepEqual(multi[1][0], [121.3, 25.3]);
});

test('a 2 km southbound freeway line is cut into ~150 m geohash cells, all heading S, continuous', () => {
  const line = [[121.5, 25.10], [121.5, 25.082]]; // 往南約 2 公里
  const cells = cutIntoCells(line);
  assert.ok(cells.length >= 10 && cells.length <= 20, 'cells: ' + cells.length);
  cells.forEach(c => {
    assert.equal(c.dir, 'S');
    assert.ok(c.coords.length >= 2);
    const b = ghDecode(c.gh);
    assert.ok(Math.abs(b.lat - c.coords[1][1]) < 0.002, 'cell matches its coordinates');
  });
  // 每一格的起點 = 前一格的終點：線是連續的，不會斷
  for (let i = 1; i < cells.length; i++) assert.deepEqual(cells[i].coords[0], cells[i - 1].coords[cells[i - 1].coords.length - 1]);
});

test('official congestion levels map to our five levels; 0 (no data) is not shown', () => {
  assert.equal(LEVEL_BY_OFFICIAL[1], 'free');
  assert.equal(LEVEL_BY_OFFICIAL[2], 'moderate');
  assert.equal(LEVEL_BY_OFFICIAL[3], 'slow');
  assert.equal(LEVEL_BY_OFFICIAL[4], 'congested');
  assert.equal(LEVEL_BY_OFFICIAL[5], 'severe');
  assert.equal(LEVEL_BY_OFFICIAL[0], undefined);
});
