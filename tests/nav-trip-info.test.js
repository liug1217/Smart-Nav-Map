const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', '智行地圖.html'), 'utf8');
function slice(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'marker not found: ' + startMarker);
  return html.slice(start, end);
}
const tripCode = slice('  let _navTotals = null;', '\n  // GPS每次更新時呼叫');
const turnCode = slice('  function checkTurnByTurn', '\n  // ===== 🚨 偏航偵測與重新規劃');
const snapCode = slice('  const SNAP_ENTER_M', '\n  // 道路外(未吸附)時');

// 簡化的平面距離(公里):1 度經度 ≈ 111.32 km(赤道附近)
const calculateDistance = (lat1, lon1, lat2, lon2) =>
  Math.hypot((lon2 - lon1) * 111.32, (lat2 - lat1) * 110.54);

function createHarness() {
  const els = { info: { innerText: '' }, arrival: { innerText: '' } };
  const window = {};
  const context = {
    window, console, Date,
    document: {
      querySelector: sel => (sel === '.info' ? els.info : null),
      getElementById: id => (id === 'arrivalText' ? els.arrival : null),
      body: { classList: { remove() {} } },
    },
    calculateDistance,
    updateRect8Display() {}, checkOffRoute() {}, speakText() {}, stopNavigation() {},
    maneuverToChinese: () => '', buildImmediateNavVoice: () => '', buildNavVoice: () => '',
    getActiveThresholds: () => [500, 100], _setPanelState() {}, togglePoiLayers() {},
    NAV_TURN_VIEW_M: 200, NAV_TURN_HOLD_MS: 3000, localStorage: { getItem: () => 0 },
    setTimeout() {},
    // 畫面上是翻牌效果；測試只看寫進去的文字
    setFlipText(el, text) { if (el) el.innerText = String(text); },
  };
  vm.createContext(context);
  vm.runInContext(`
    let isNavigating = true, navSteps = [], currentStepIndex = 0, navStepVoiceState = {};
    let _navSession = 0, _navState = 'navigating', _lastNavAnnounceMs = 0, totalDistance = 0;
    let rect8 = null, speedPillNum = null, searchBarWrapEl = null;
    ${tripCode}
    ${turnCode}
    ${snapCode}
    globalThis.api = {
      start(steps, dist, dur, coords, first) {
        window.plannedRouteCoordinates = coords;
        navSteps = steps; currentStepIndex = first;
        _navTotals = { dist, dur };
        renderNavTripInfo(dist, dur);
      },
      gps(lat, lon, speed, now) { snapVehicleToRoute(lat, lon, speed, now); checkTurnByTurn(lat, lon); },
      stepIndex: () => currentStepIndex,
    };
  `, context);
  return { els, api: context.api };
}

// 沿赤道往東 33.6 km 的直線國道:出發 → 0.5 km 處匝道匯入(轉彎點) → 終點
const KM_PER_DEG = 111.32;
const lonAt = km => km / KM_PER_DEG;
function highwayRoute() {
  const coords = [];
  for (let km = 0; km <= 33.6 + 1e-9; km += 0.1) coords.push([lonAt(km), 0]);
  const steps = [
    { distance: 500, maneuver: { type: 'depart', location: [0, 0] } },
    { distance: 33100, maneuver: { type: 'merge', modifier: 'slight left', location: [lonAt(0.5), 0] } },
    { distance: 0, maneuver: { type: 'arrive', location: [lonAt(33.6), 0] } },
  ];
  return { coords, steps };
}

test('remaining distance/time keep counting down when a high-speed GPS fix skips the 15 m turn window', () => {
  const h = createHarness();
  const { coords, steps } = highwayRoute();
  h.api.start(steps, 33600, 32 * 60, coords, 1);
  assert.equal(h.els.info.innerText, '32分鐘 33.6公里');

  // 時速約 130 km/h:每秒 36 m,GPS 點落在轉彎點(500 m)前 20 m、後 16 m,永遠進不了 15 m 範圍
  let t = 0;
  for (let m = 480 - 36 * 13; m <= 13900; m += 36) h.api.gps(0, lonAt(m / 1000), 36, t += 1000);

  assert.equal(h.api.stepIndex(), 2, 'passed maneuver should advance to the next step');
  const [, min, km] = h.els.info.innerText.match(/(\d+)分鐘 ([\d.]+)公里/);
  assert.ok(Number(km) < 21, 'remaining km should drop after driving ~13 km, got ' + h.els.info.innerText);
  assert.ok(Number(min) < 21, 'remaining minutes should drop, got ' + h.els.info.innerText);
});

test('remaining distance follows the route position', () => {
  const h = createHarness();
  const { coords, steps } = highwayRoute();
  h.api.start(steps, 33600, 32 * 60, coords, 1);
  let t = 0;
  for (let km = 0; km <= 10; km += 0.03) h.api.gps(0, lonAt(km), 30, t += 1000);
  const km = Number(h.els.info.innerText.match(/([\d.]+)公里/)[1]);
  assert.ok(Math.abs(km - 23.6) <= 0.1, 'expected ~23.6 km left, got ' + h.els.info.innerText);
});
