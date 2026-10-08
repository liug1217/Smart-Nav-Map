const assert = require('node:assert/strict');
const test = require('node:test');
const { addSpeed, freeFlowSpeed } = require('../lib/traffic/baseline');
const { computeState } = require('../lib/traffic/aggregator');

function learn(speeds) {
  let h = null;
  for (const s of speeds) h = addSpeed(h, s);
  return h;
}
// 近期樣本：member 格式 {sessionId}:{ts}:{speedKmh}
const samples = (speeds, sessions = ['sessA1234']) =>
  speeds.map((s, i) => `${sessions[i % sessions.length]}:${1000 + i}:${s}`);

test('learns ~100 km/h free-flow on a freeway and ~30 on a city street', () => {
  const freeway = learn(Array.from({ length: 200 }, (_, i) => 85 + (i % 30)));  // 85~114
  const street  = learn(Array.from({ length: 200 }, (_, i) => 18 + (i % 16)));  // 18~33
  assert.ok(Math.abs(freeFlowSpeed(freeway) - 108) <= 6, 'freeway ' + freeFlowSpeed(freeway));
  assert.ok(Math.abs(freeFlowSpeed(street) - 31) <= 5, 'street ' + freeFlowSpeed(street));
});

test('not enough history → no learned free-flow yet', () => {
  assert.equal(freeFlowSpeed(learn([60, 70, 80])), null);
  assert.equal(freeFlowSpeed(null), null);
});

test('50 km/h on a freeway that normally runs 100 is congestion, not free flow', () => {
  const st = computeState(samples([50, 52, 48]), 100);
  assert.equal(st.level.level, 'slow');
  assert.equal(st.baselineSource, 'learned');
});

test('28 km/h on a street that normally runs 30 is free flow and shown green', () => {
  const st = computeState(samples([28, 27, 29]), 30);
  assert.equal(st.level.level, 'free');
  assert.equal(st.level.color, '#16E098');
});

test('before a road has history: normal street speed is not falsely marked as a jam', () => {
  assert.equal(computeState(samples([25, 28, 26]), null).level.level, 'free');
  assert.equal(computeState(samples([15, 14, 16]), null).level.level, 'slow');
  assert.equal(computeState(samples([7, 8, 6]), null).level.level, 'congested');
});

test('a single driver with many samples cannot outweigh others (median of per-driver medians)', () => {
  const s = [
    ...samples([10, 10, 10, 10, 10, 10, 10, 10], ['slowpoke1']),
    ...samples([95], ['driverB12']),
    ...samples([100], ['driverC12']),
  ];
  assert.equal(computeState(s, 100).level.level, 'free');
});

// ── 還沒學到實際車速時：速限 > 道路等級推估 ──────────────────────────────────
const { encodeRoadInfo, resolveBaseline } = require('../lib/traffic/baseline');

test('first time a freeway is driven: 40 km/h already counts as congestion (class baseline 100)', () => {
  const base = resolveBaseline(null, encodeRoadInfo('motorway', false, null));
  assert.deepEqual(base, { kmh: 100, source: 'class' });
  const st = computeState(samples([40, 42, 38]), base.kmh, base.source);
  assert.equal(st.level.level, 'slow');
  assert.equal(st.baselineSource, 'class');
});

test('first time an alley is driven: 25 km/h is free flow (class baseline 30)', () => {
  const base = resolveBaseline(null, encodeRoadInfo('service', false, null));
  assert.equal(computeState(samples([25, 24, 26]), base.kmh, base.source).level.level, 'free');
});

test('speed limit beats the class guess, but only when it is plausible for that road type', () => {
  assert.deepEqual(resolveBaseline(null, encodeRoadInfo('trunk', false, 90)), { kmh: 90, source: 'limit' });
  // 巷弄拿到 100 的速限(多半是旁邊國道的測速照相)→ 不採用，改用等級推估
  assert.deepEqual(resolveBaseline(null, encodeRoadInfo('service', false, 100)), { kmh: 30, source: 'class' });
});

test('ramps use a lower baseline than the freeway itself', () => {
  assert.deepEqual(resolveBaseline(null, encodeRoadInfo('motorway', true, null)), { kmh: 50, source: 'class' });
});

test('learned real speed always wins over limit and class', () => {
  const learned = learn(Array.from({ length: 200 }, (_, i) => 60 + (i % 10)));
  assert.equal(resolveBaseline(learned, encodeRoadInfo('motorway', false, 100)).source, 'learned');
});

test('unknown / bogus road class is not stored and falls back to absolute thresholds', () => {
  assert.equal(encodeRoadInfo('path', false, 30), null);
  assert.equal(encodeRoadInfo(undefined, false, null), null);
  assert.deepEqual(resolveBaseline(null, null), { kmh: null, source: 'none' });
});
