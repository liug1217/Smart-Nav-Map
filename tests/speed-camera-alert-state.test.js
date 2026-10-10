const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', '智行地圖.html'), 'utf8')
  .replace(/\r\n/g, '\n'); // Windows 取出的檔案是 CRLF，下面用 \n 切程式碼
const stateCode = html.match(/  const SPEED_CAM_WARN_KM[\s\S]*?\n  \/\/ 語音播報時平滑降低/)[0]
  .replace(/\n  \/\/ 語音播報時平滑降低[\s\S]*/, '');
// 選照相機(沿路距離、方向、鎖定)＋播報入口
const checkStart = html.indexOf('  // ── 測速照相：選哪一支');
const checkEnd = html.indexOf('\n  // ===== 🧪 測試用:在瀏覽器主控台手動模擬', checkStart);
const checkCode = html.slice(checkStart, checkEnd);
const projStart = html.indexOf('  function projectOnRoute(');
const projCode = html.slice(projStart, html.indexOf('\n  }\n', projStart) + 4);

// 測試世界：一條往北的直路，照相機在第 N 公里；run(_, km, 車速) = 車子開到第 km 公里
const LAT0 = 25, LNG = 121, KM_DEG = 1000 / 110540;
const latAt = km => LAT0 + km * KM_DEG;

function createHarness(features) {
  const events = [];
  const preloaded = [];
  function playSpeedCameraPassBeep() { return Promise.resolve(); }
  const context = {
    window: {
      NavVoice: require('../nav-voice.js'), // 播報 3.0：執法分類、優先順序
      speedCameraData: { features }, NavTTS: { preload: t => preloaded.push(...t) },
      // 沒導航模式：前方的路 = 從車子往北的直線
      _roadPathAhead: (lng, lat, _b, maxM) => [[lng, lat], [lng, lat + maxM / 110540]],
    },
    isNavigating: true,
    _snapState: { snapped: false }, _routeGeom: null,
    calculateDistance: (la1, _lo1, la2) => Math.abs(la2 - la1) / KM_DEG,
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
  vm.runInContext(`${stateCode}\n${projCode}\n${checkCode}\nglobalThis.check = checkSpeedCameraVoice; globalThis.reset = clearSpeedCameraVoiceState;`, context);
  const run = (_lat, km, speed) => {
    context.window._vehicleTarget = { lat: latAt(km), lng: LNG, bearing: 0 };
    context.check(latAt(km), LNG, speed);
  };
  return { events, preloaded, run, reset: context.reset, texts: () => events.map(e => e.text) };
}

function camera(id, distanceKm, limit = 100, dir) {
  return { id, geometry: { coordinates: [LNG, latAt(distanceKm)] }, properties: { limit, addr: id, dir } };
}

// 以 20 公尺為一步從照相機前 fromM 公尺開到照相機後(照相機在第 1 公里)
function driveThrough(h, fromM, toM, speed, stepM = 20) {
  for (let m = fromM; m >= toM; m -= stepM) h.run(0, 1 - m / 1000, speed);
}

test('full approach: intro, every 100m multiple once, then chime + 您已通過 once', () => {
  const h = createHarness([camera('A', 1, 60)]);
  driveThrough(h, 1100, -100, 50);
  assert.deepEqual(h.texts(), [
    '1公里後有固定測速照相，限速60公里。|當前速度50公里',
    '900公尺', '800公尺', '700公尺', '600公尺', '500公尺', '400公尺', '300公尺', '200公尺', '100公尺',
    '<chime>|您已通過',
  ]);
  // 通過後在附近漂移不會再播
  [0.99, 1.01, 0.995, 1.0].forEach(lon => h.run(0, lon, 50));
  assert.equal(h.events.length, 11);
});

test('section speed cameras (區間測速) are announced as 區間測速照相', () => {
  const h = createHarness([camera('Z', 1, 70, '南北雙向(區間測速)')]);
  h.run(0, 0.02, 60);
  assert.deepEqual(h.texts(), ['1公里後有區間測速照相，限速70公里。|當前速度60公里']);
});

test('never announces non-multiples of 100 such as 960/850/750', () => {
  const h = createHarness([camera('A', 1)]);
  for (let m = 1000; m >= 0; m -= 7) h.run(0, 1 - m / 1000, 80);
  const distances = h.texts().filter(t => /^\d+公尺$/.test(t)).map(t => parseInt(t, 10));
  assert.deepEqual(distances, [900, 800, 700, 600, 500, 400, 300, 200, 100]);
});

test('over the limit: 您已超速 is added to the intro only, not repeated on every distance', () => {
  const h = createHarness([camera('A', 1, 60)]);
  h.run(0, 0.02, 75); // 980m
  h.run(0, 0.11, 75); // 890m
  h.run(0, 0.21, 75); // 790m
  assert.deepEqual(h.texts(), ['1公里後有固定測速照相，限速60公里。|當前速度75公里|您已超速', '900公尺', '800公尺']);
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
  h.run(0, 0.57, 40); // 430m → 最接近的整百是 400
  h.run(0, 0.58, 40);
  h.run(0, 0.61, 40); // 390m：400 已經在首次提醒念過，不重念
  h.run(0, 0.71, 40); // 290m
  assert.deepEqual(h.texts(), ['400公尺後有固定測速照相，限速50公里。|當前速度40公里', '300公尺']);
});

test('pass is detected when GPS skips over the 30m circle at speed', () => {
  const h = createHarness([camera('A', 1)]);
  [0, 0.5, 0.95, 1.04, 1.1].forEach(lon => h.run(0, lon, 100)); // 1000, 500, 50, 40(past), 100(past)
  assert.equal(h.texts().filter(t => t === '<chime>|您已通過').length, 1);
});

test('distance and pass announcements share a key so a stale distance is replaced', () => {
  const h = createHarness([camera('A', 1)]);
  driveThrough(h, 1000, -40, 20);
  const pass = h.events.find(e => e.text === '<chime>|您已通過');
  const hundred = h.events.find(e => e.text === '100公尺');
  assert.equal(pass.opts.key, hundred.opts.key);
  assert.ok(hundred.opts.maxAgeMs > 0);
  assert.notEqual(h.events[0].opts.key, hundred.opts.key); // 首次提醒不會被距離播報取代
});

test('intro text is preloaded before entering 1km', () => {
  const h = createHarness([camera('A', 1.5, 70)]);
  h.run(0, 0, 60); // 1500m
  assert.deepEqual(h.preloaded, ['1公里後有固定測速照相，限速70公里。']);
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

// ── 使用者回報的 bug：完整提醒、距離提醒、超速提醒互相獨立觸發 ─────────────────
test('reported sequence: speeding from 300m gives intro+您已超速, then only 200/100, then chime+您已通過', () => {
  const h = createHarness([camera('A', 1, 100)]);
  driveThrough(h, 300, -60, 120, 10); // 一路超速(120 > 100)開過照相機
  assert.deepEqual(h.texts(), [
    '300公尺後有固定測速照相，限速100公里。|當前速度120公里|您已超速',
    '200公尺',
    '100公尺',
    '<chime>|您已通過',
  ]);
  assert.equal(h.texts().filter(t => t.includes('您已超速')).length, 1);
});

test('starting to speed after the intro: the countdown still says only the distance', () => {
  const h = createHarness([camera('A', 1, 60)]);
  h.run(0, 0.02, 50);  // 980m 沒超速
  h.run(0, 0.31, 80);  // 690m 開始超速
  h.run(0, 0.41, 85);  // 590m 還是超速
  h.run(0, 0.51, 90);  // 490m
  assert.deepEqual(h.texts(), ['1公里後有固定測速照相，限速60公里。|當前速度50公里', '700公尺', '600公尺', '500公尺']);
});

test('never says the bare word 通過, and GPS drift after passing does not replay 您已通過', () => {
  const h = createHarness([camera('A', 1, 60)]);
  driveThrough(h, 400, -40, 50, 10);
  for (let i = 0; i < 20; i++) h.run(0, 1 + (i % 2 ? 0.005 : -0.005), 5); // 在照相機附近來回漂移
  assert.equal(h.texts().filter(t => t === '<chime>|您已通過').length, 1);
  assert.equal(h.texts().filter(t => /(^|\|)通過$/.test(t)).length, 0);
});

test('only whole hundreds are ever spoken as distances, each at most once', () => {
  const h = createHarness([camera('A', 1)]);
  for (let m = 1000; m >= 0; m -= 3) h.run(0, 1 - m / 1000, 90);
  const d = h.texts().filter(t => /^\d+公尺$/.test(t));
  assert.deepEqual(d, ['900公尺', '800公尺', '700公尺', '600公尺', '500公尺', '400公尺', '300公尺', '200公尺', '100公尺']);
  assert.equal(new Set(d).size, d.length);
});

// ── 選對照相機：只播「沿目前道路、同方向、前方」的那一支，鎖定後不跳來跳去 ─────────────
const offsetEast = (cam, m) => { cam.geometry.coordinates[0] += m / (111320 * Math.cos(25 * Math.PI / 180)); return cam; };
const distances = h => h.texts().map(t => /^(\d+)公尺/.exec(t)).filter(Boolean).map(m => +m[1]);

test('two cameras close together: finish the nearer one first, distances never jump back (no 300→400→200)', () => {
  const h = createHarness([camera('A', 1, 60), camera('B', 1.35, 70)]);
  for (let m = 0; m <= 1500; m += 20) h.run(0, m / 1000, 50);
  const t = h.texts();
  const passA = t.indexOf('<chime>|您已通過');
  const before = distances({ texts: () => t.slice(0, passA) });
  assert.deepEqual(before, [900, 800, 700, 600, 500, 400, 300, 200, 100]); // 只有 A，嚴格遞減
  assert.match(t[0], /限速60公里/);
  assert.ok(t.slice(passA + 1).some(x => /限速70公里/.test(x))); // 通過 A 之後才換 B
});

test('a camera on a parallel road 80 m away is never announced, even though it is close in a straight line', () => {
  const h = createHarness([offsetEast(camera('side', 1, 40), 80)]);
  driveThrough(h, 1100, -100, 50);
  assert.deepEqual(h.texts(), []);
});

test('opposite-direction camera is ignored; same-direction one is announced', () => {
  const opp = createHarness([camera('opp', 1, 60, '北向南')]); // 我們往北開
  driveThrough(opp, 1100, -100, 50);
  assert.deepEqual(opp.texts(), []);
  const same = createHarness([camera('same', 1, 60, '南向北')]);
  driveThrough(same, 1100, -100, 50);
  assert.equal(same.texts()[0], '1公里後有固定測速照相，限速60公里。|當前速度50公里');
});

test('locked camera is kept while a side-road camera comes within 50 m straight-line', () => {
  const h = createHarness([camera('A', 1, 60), offsetEast(camera('side', 0.6, 30), 45)]);
  driveThrough(h, 1100, -100, 50);
  assert.ok(h.texts().every(t => !/限速30/.test(t)));
  assert.deepEqual(distances(h), [900, 800, 700, 600, 500, 400, 300, 200, 100]);
});

test('direction field parsing', () => {
  const ctx = vm.createContext({ Map, RegExp });
  const start = html.indexOf('  const CAM_COMPASS');
  const end = html.indexOf('  function camDirOk', start);
  vm.runInContext(html.slice(start, end) + '\nglobalThis.p = parseCamDir;', ctx);
  const p = d => { const r = ctx.p(d); return r && Array.from(r); };
  assert.deepEqual(p('北向南'), [180]);
  assert.deepEqual(p('西南向東北'), [45]);
  assert.deepEqual(p('往南'), [180]);
  assert.deepEqual(p('南下車道'), [180]);
  assert.deepEqual(p('北上方向'), [0]);
  assert.deepEqual(p('東向'), [90]);
  assert.deepEqual(p('東往西(區間測速)'), [270]);
  assert.equal(p('南北雙向'), null);
  assert.equal(p('雙向'), null);
  assert.equal(p('東西向'), null);
  assert.equal(p('南向60北向70'), null); // 兩個相反方向 = 雙向
  assert.equal(p('往大溪方向'), null);   // 地名看不出方向 → 都算
});

test('direction data that contradicts the road (e.g. 往南 on an east-west road) is ignored, so the camera still speaks', () => {
  // 我們往北開；照相機資料寫「往東」，跟這條南北向的路不同向 → 方向資料不可信，照樣播
  const h = createHarness([camera('bad', 1, 50, '往東')]);
  driveThrough(h, 1100, -100, 40);
  assert.equal(h.texts()[0], '1公里後有固定測速照相，限速50公里。|當前速度40公里');
  // 但方向跟道路同向、只是相反(真正的對向車道)時還是不播
  const opp = createHarness([camera('opp', 1, 50, '往南')]);
  driveThrough(opp, 1100, -100, 40);
  assert.deepEqual(opp.texts(), []);
});

test('current speed is always spoken after the intro; over the limit adds 您已超速 after it', () => {
  const under = createHarness([camera('A', 1, 100)]);
  under.run(0, 0.02, 95);
  assert.deepEqual(under.texts(), ['1公里後有固定測速照相，限速100公里。|當前速度95公里']);
  const exact = createHarness([camera('B', 1, 100)]);
  exact.run(0, 0.02, 100); // 剛好等於速限：不算超速
  assert.deepEqual(exact.texts(), ['1公里後有固定測速照相，限速100公里。|當前速度100公里']);
  const over = createHarness([camera('C', 1, 100)]);
  over.run(0, 0.02, 112.4);
  assert.deepEqual(over.texts(), ['1公里後有固定測速照相，限速100公里。|當前速度112公里|您已超速']);
});

// ── 播報 3.0 ─────────────────────────────────────────────────────────────
test('播報 3.0：當前速度無效時不念速度也不判斷超速(不念虛構數字)', () => {
  const h = createHarness([camera('A', 1, 60)]);
  h.run(0, -0.5, 50);  // 1.5 公里外：速度正常，找到前方道路與照相機
  h.run(0, 0.02, null); // 980 公尺：速度資料無效
  assert.deepEqual(h.texts(), ['1公里後有固定測速照相，限速60公里。']);
});

test('播報 3.0：區間測速的點不說「您已通過」，改說請保持速限', () => {
  const h = createHarness([camera('Z', 1, 70, '南北雙向(區間測速)')]);
  driveThrough(h, 300, -60, 60, 10);
  assert.equal(h.texts().filter(t => /您已通過/.test(t)).length, 0);
  assert.ok(h.texts().includes('<chime>|區間測速路段，請保持速限'));
});

test('播報 3.0：區間測速寫在地址欄、科技執法、兼闖紅燈都分得出來', () => {
  const sec = createHarness([Object.assign(camera('S', 1, 40), { properties: { limit: 40, addr: '臺9戊線3.94K至9.92K區間測速', dir: '雙向測速科技執法' } })]);
  sec.run(0, 0.02, 30);
  assert.match(sec.texts()[0], /^1公里後有區間測速照相，限速40公里。/);
  const tech = createHarness([Object.assign(camera('T', 1, 90), { properties: { limit: 90, addr: '國道五號南向16.9公里(雪山隧道科技執法)' } })]);
  tech.run(0, 0.02, 80);
  assert.match(tech.texts()[0], /^1公里後有科技執法測速照相，限速90公里。/);
  const red = createHarness([camera('R', 1, 50, '南北雙向兼闖紅燈')]);
  red.run(0, 0.02, 40);
  assert.match(red.texts()[0], /^1公里後有固定測速照相兼闖紅燈照相，限速50公里。/);
});

test('播報 3.0：測速播報帶執法優先順序與事件代號(同一提醒不會被佇列重播)', () => {
  const h = createHarness([camera('A', 1, 60)]);
  driveThrough(h, 1000, 800, 50);
  assert.ok(h.events.every(e => e.opts.priority === 2));
  const ids = h.events.map(e => e.opts.eventId);
  assert.equal(new Set(ids).size, ids.length);
});

test('播報 3.0：倒數距離被打斷不重播(retries 0)；首次提醒可以重播一次', () => {
  const h = createHarness([camera('A', 1, 60)]);
  driveThrough(h, 1000, 800, 50);
  const stage = h.events.find(e => e.text === '900公尺');
  assert.equal(stage.opts.retries, 0);
  assert.notEqual(h.events[0].opts.retries, 0);
});
