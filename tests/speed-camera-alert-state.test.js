const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', '智行地圖.html'), 'utf8');
const stateCode = html.match(/  const SPEED_CAM_WARN_KM[\s\S]*?\n  \/\/ 語音播報時平滑降低/)[0]
  .replace(/\n  \/\/ 語音播報時平滑降低[\s\S]*/, '');
const checkStart = html.indexOf('  function checkSpeedCameraVoice');
const checkEnd = html.indexOf('\n  // ===== 🧪 測試用:在瀏覽器主控台手動模擬', checkStart);
const checkCode = html.slice(checkStart, checkEnd);

function createHarness(features) {
  const events = [];
  const context = {
    window: { speedCameraData: { features } },
    isNavigating: true,
    calculateDistance: (_lat, lon, _camLat, camLon) => Math.abs(camLon - lon),
    speakQueue: items => events.push(['voice', items.join('，')]),
    playSpeedCameraDistanceBeep: () => events.push(['beep']),
    playSpeedCameraPassBeep: () => events.push(['pass']),
    console,
  };
  vm.createContext(context);
  vm.runInContext(`${stateCode}\n${checkCode}\nglobalThis.run = checkSpeedCameraVoice; globalThis.reset = resetSpeedCameraVoiceState;`, context);
  return { events, run: context.run, reset: context.reset };
}

function camera(id, distanceKm, limit = 100) {
  return { id, geometry: { coordinates: [distanceKm, 0] }, properties: { limit, addr: id } };
}

test('normal approach plays one full announcement, nine distance beeps, then one pass tone', () => {
  const h = createHarness([camera('A', 1)]);
  [0, 0.05, 0.11, 0.21, 0.31, 0.41, 0.51, 0.61, 0.71, 0.81, 0.91, 0.99].forEach(lon => h.run(0, lon, 80));
  h.run(0, 0.985, 80); // Remain in the 100m interval: no duplicate.
  h.run(0, 1, 80);
  assert.equal(h.events.filter(e => e[0] === 'voice').length, 1);
  assert.match(h.events[0][1], /1公里後有測速照相，限速100公里/);
  assert.equal(h.events.filter(e => e[0] === 'beep').length, 9);
  assert.equal(h.events.filter(e => e[0] === 'pass').length, 1);
});

test('GPS drift cannot replay a completed 900m stage', () => {
  const h = createHarness([camera('A', 1)]);
  [0, 0.08, 0.12, 0.07, 0.15].forEach(lon => h.run(0, lon, 80)); // 1000→920→880→930→850m
  assert.equal(h.events.filter(e => e[0] === 'beep').length, 1);
});

test('a large GPS jump uses one current beep and marks skipped farther stages complete', () => {
  const h = createHarness([camera('A', 1)]);
  h.run(0, 0, 80);
  h.run(0, 0.3, 80); // 1000→700m
  h.run(0, 0.31, 80);
  assert.equal(h.events.filter(e => e[0] === 'beep').length, 1);
  h.run(0, 0.41, 80); // 590m: next new stage
  assert.equal(h.events.filter(e => e[0] === 'beep').length, 2);
});

test('each camera has isolated state and a new navigation reset starts its sequence again', () => {
  const h = createHarness([camera('A', 1), camera('B', 11, 60)]);
  h.run(0, 0, 80);
  h.run(0, 10, 80);
  assert.equal(h.events.filter(e => e[0] === 'voice').length, 2);
  assert.match(h.events[1][1], /限速60公里/);
  h.reset();
  h.run(0, 0, 80);
  assert.equal(h.events.filter(e => e[0] === 'voice').length, 3);
});
