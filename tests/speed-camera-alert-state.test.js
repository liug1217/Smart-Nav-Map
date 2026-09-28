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
  const preloaded = [];
  function playSpeedCameraPassBeep() { return Promise.resolve(); }
  const context = {
    window: { speedCameraData: { features }, NavTTS: { preload: t => preloaded.push(...t) } },
    isNavigating: true,
    calculateDistance: (_lat, lon, _camLat, camLon) => Math.abs(camLon - lon),
    speakQueue: (items, opts) => events.push({
      text: items.filter(Boolean).map(i => (i === playSpeedCameraPassBeep ? '<chime>' : i)).join('|'),
      opts: opts || {},
    }),
    playSpeedCameraPassBeep,
    localStorage: { getItem: () => '0', setItem: () => {} },
    console,
  };
  context.NavTTS = context.window.NavTTS;
  vm.createContext(context);
  vm.runInContext(`${stateCode}\n${checkCode}\nglobalThis.run = checkSpeedCameraVoice; globalThis.reset = clearSpeedCameraVoiceState;`, context);
  return { events, preloaded, run: context.run, reset: context.reset, texts: () => events.map(e => e.text) };
}

function camera(id, distanceKm, limit = 100) {
  return { id, geometry: { coordinates: [distanceKm, 0] }, properties: { limit, addr: id } };
}

// 以 20 公尺為一步從 1100 公尺開到照相機後 100 公尺(距離 = |camLon - lon| 公里)
function driveThrough(h, fromM, toM, speed, stepM = 20) {
  for (let m = fromM; m >= toM; m -= stepM) h.run(0, 1 - m / 1000, speed);
}

test('full approach: intro, every 100m multiple once, then chime + 通過 once', () => {
  const h = createHarness([camera('A', 1, 60)]);
  driveThrough(h, 1100, -100, 50);
  assert.deepEqual(h.texts(), [
    '1公里後有測速照相，固定式，限速60公里。',
    '900公尺', '800公尺', '700公尺', '600公尺', '500公尺', '400公尺', '300公尺', '200公尺', '100公尺',
    '<chime>|通過',
  ]);
  // 通過後在附近漂移不會再播
  [0.99, 1.01, 0.995, 1.0].forEach(lon => h.run(0, lon, 50));
  assert.equal(h.events.length, 11);
});

test('never announces non-multiples of 100 such as 960/850/750', () => {
  const h = createHarness([camera('A', 1)]);
  for (let m = 1000; m >= 0; m -= 7) h.run(0, 1 - m / 1000, 80);
  const distances = h.texts().filter(t => /^\d+公尺$/.test(t)).map(t => parseInt(t, 10));
  assert.deepEqual(distances, [900, 800, 700, 600, 500, 400, 300, 200, 100]);
});

test('over the limit adds 您已超速 to intro and distance announcements', () => {
  const h = createHarness([camera('A', 1, 60)]);
  h.run(0, 0.02, 75); // 980m
  h.run(0, 0.11, 75); // 890m
  assert.deepEqual(h.texts(), ['1公里後有測速照相，固定式，限速60公里。|您已超速', '900公尺|您已超速']);
});

test('GPS drift cannot replay a completed 900m stage', () => {
  const h = createHarness([camera('A', 1)]);
  [0, 0.08, 0.12, 0.07, 0.15].forEach(lon => h.run(0, lon, 80)); // 1000→920→880→930→850m
  assert.deepEqual(h.texts().slice(1), ['900公尺']);
});

test('a large GPS jump announces only the current 100m stage', () => {
  const h = createHarness([camera('A', 1)]);
  h.run(0, 0, 80);
  h.run(0, 0.3, 80); // 1000→700m
  h.run(0, 0.31, 80);
  h.run(0, 0.41, 80); // 590m
  assert.deepEqual(h.texts().slice(1), ['700公尺', '600公尺']);
});

test('navigation starting near a camera announces the current stage, not 1公里', () => {
  const h = createHarness([camera('A', 1, 50)]);
  h.run(0, 0.57, 40); // 430m
  h.run(0, 0.58, 40);
  h.run(0, 0.61, 40); // 390m
  assert.deepEqual(h.texts(), ['500公尺後有測速照相，固定式，限速50公里。', '400公尺']);
});

test('pass is detected when GPS skips over the 30m circle at speed', () => {
  const h = createHarness([camera('A', 1)]);
  [0, 0.5, 0.95, 1.04, 1.1].forEach(lon => h.run(0, lon, 100)); // 1000, 500, 50, 40(past), 100(past)
  assert.equal(h.texts().filter(t => t === '<chime>|通過').length, 1);
});

test('distance and pass announcements share a key so a stale distance is replaced', () => {
  const h = createHarness([camera('A', 1)]);
  driveThrough(h, 1000, -40, 20);
  const pass = h.events.find(e => e.text === '<chime>|通過');
  const hundred = h.events.find(e => e.text === '100公尺');
  assert.equal(pass.opts.key, hundred.opts.key);
  assert.ok(hundred.opts.maxAgeMs > 0);
  assert.notEqual(h.events[0].opts.key, hundred.opts.key); // 首次提醒不會被距離播報取代
});

test('intro text is preloaded before entering 1km', () => {
  const h = createHarness([camera('A', 1.5, 70)]);
  h.run(0, 0, 60); // 1500m
  assert.deepEqual(h.preloaded, ['1公里後有測速照相，固定式，限速70公里。']);
  assert.equal(h.events.length, 0);
});

test('each camera has isolated state and a new navigation reset starts its sequence again', () => {
  const h = createHarness([camera('A', 1), camera('B', 11, 60)]);
  h.run(0, 0, 80);
  h.run(0, 10, 80);
  assert.equal(h.events.length, 2);
  assert.match(h.events[1].text, /限速60公里/);
  h.reset();
  h.run(0, 0, 80);
  assert.equal(h.events.length, 3);
});
