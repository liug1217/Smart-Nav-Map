// 播報 3.0 核心(nav-voice.js)單元測試 — 全部是模擬測試，不是實機
const assert = require('node:assert/strict');
const test = require('node:test');
const NV = require('../nav-voice.js');

// ── 測試用路線：每個 step 的 maneuver 在 location；steps[i].distance = 第 i 個動作到第 i+1 個動作的距離 ──
function step(type, modifier, name, distance, extra) {
  return Object.assign({ maneuver: { type, modifier, location: [121 + Math.random() / 1000, 25] }, name: name || '', distance: distance || 0 }, extra || {});
}
function drive(ann, steps, index, fromM, toM, opts = {}) {
  const out = [];
  const stepM = opts.step || 10;
  for (let m = fromM; m >= toM; m -= stepM) {
    out.push(...ann.update({ routeVersion: opts.rv || 1, steps, index, meters: m, passed: false, speedKmh: opts.speed ?? 40, accuracy: 8 }));
  }
  return out;
}

// ═════════════ 轉彎 ═════════════
test('市區一般路口：遠距離預告 → 接近提醒 → 實際指令「請右轉」各一次', () => {
  const steps = [step('depart', '', '', 800), step('turn', 'right', '中山路', 500), step('arrive')];
  const ann = NV.createTurnAnnouncer();
  const said = drive(ann, steps, 1, 600, 0, { speed: 40 });
  assert.deepEqual(said.map(s => s.phase), ['far', 'near0', 'now']);
  assert.equal(said[0].text, '前方300公尺，請右轉進入中山路。');
  assert.equal(said[1].text, '前方100公尺，請右轉進入中山路。');
  assert.equal(said[2].text, '請右轉。'); // 實際指令：不加「前方」、不念距離
  assert.equal(said[2].priority, NV.PRI.CRITICAL);
});

test('實際指令在市區 20~30 公尺內、郊區 30~50 公尺內觸發', () => {
  const urban = NV.turnThresholds('urban', 40);
  assert.ok(urban.now >= 20 && urban.now <= 30, 'urban now ' + urban.now);
  const sub = NV.turnThresholds('suburban', 70);
  assert.ok(sub.now >= 30 && sub.now <= 50, 'suburban now ' + sub.now);
});

test('GPS 距離在門檻附近來回(220/195/205/185)不會重念同一個提醒', () => {
  const steps = [step('depart', '', '', 800), step('turn', 'left', '民生路', 500), step('arrive')];
  const ann = NV.createTurnAnnouncer();
  const said = [];
  [400, 260, 220, 195, 205, 185, 210, 190].forEach(m => said.push(...ann.update({ routeVersion: 1, steps, index: 1, meters: m, speedKmh: 60, accuracy: 10 })));
  const phases = said.map(s => s.phase);
  assert.equal(new Set(phases).size, phases.length, '沒有重複階段：' + phases);
});

test('已通過路口後 GPS 回跳，不會重念「請左轉」', () => {
  const steps = [step('depart', '', '', 800), step('turn', 'left', '', 500), step('arrive')];
  const ann = NV.createTurnAnnouncer();
  drive(ann, steps, 1, 300, 0, { speed: 40 });
  ann.update({ routeVersion: 1, steps, index: 1, meters: 0, passed: true, speedKmh: 40 });
  const again = [20, 15, 10, 25].flatMap(m => ann.update({ routeVersion: 1, steps, index: 1, meters: m, speedKmh: 40 }));
  assert.deepEqual(again, []);
});

test('開過頭(沒碰到實際指令距離就通過)不會補念', () => {
  const steps = [step('depart', '', '', 800), step('turn', 'right', '', 500), step('arrive')];
  const ann = NV.createTurnAnnouncer();
  ann.update({ routeVersion: 1, steps, index: 1, meters: 90, speedKmh: 50 });
  const late = ann.update({ routeVersion: 1, steps, index: 1, meters: 0, passed: true, speedKmh: 50 });
  assert.deepEqual(late, []);
});

test('高速公路出口：約 1 公里預告、500 公尺提醒，實際指令在分流點前', () => {
  const steps = [step('depart', '', '國道一號', 5000), step('off ramp', 'slight right', '五股交流道', 3000), step('turn', 'left', '', 800), step('arrive')];
  const ann = NV.createTurnAnnouncer();
  const said = drive(ann, steps, 1, 1500, 0, { speed: 100, step: 20 });
  assert.deepEqual(said.map(s => s.phase), ['far', 'near0', 'now']);
  assert.match(said[0].text, /^前方1公里，請靠右下交流道，五股交流道。$/);
  assert.match(said[1].text, /^前方500公尺/);
  assert.equal(NV.turnContext(steps, 1, 100), 'exit');
});

test('複雜交流道：約 2 公里預告，1 公里與 500 公尺各提醒一次', () => {
  const steps = [step('depart', '', '國道三號', 6000), step('off ramp', 'slight right', '', 600), step('fork', 'slight left', '', 2000), step('arrive')];
  const ann = NV.createTurnAnnouncer();
  assert.equal(NV.turnContext(steps, 1, 100), 'complexInterchange');
  const said = drive(ann, steps, 1, 2600, 0, { speed: 100, step: 20 });
  assert.deepEqual(said.map(s => s.phase), ['far', 'near0', 'near1', 'now']);
  assert.match(said[0].text, /^前方2公里/);
  assert.match(said[1].text, /^前方1公里/);
  assert.match(said[2].text, /^前方500公尺/);
});

test('靠左、靠右指示', () => {
  const steps = [step('depart', '', '', 800), step('fork', 'slight left', '', 500), step('arrive')];
  const ann = NV.createTurnAnnouncer();
  const said = drive(ann, steps, 1, 400, 0, { speed: 40 });
  assert.equal(said[said.length - 1].text, '請靠左行駛。');
  const s2 = [step('depart', '', '', 800), step('turn', 'slight right', '', 500), step('arrive')];
  const a2 = NV.createTurnAnnouncer();
  assert.equal(drive(a2, s2, 1, 400, 0).pop().text, '請靠右行駛。');
});

test('連續轉彎：近距離時合併成「請右轉，接著左轉」，下一個路口到了仍念「請左轉」', () => {
  const steps = [step('depart', '', '', 800), step('turn', 'right', '', 80), step('turn', 'left', '', 500), step('arrive')];
  const ann = NV.createTurnAnnouncer();
  const first = drive(ann, steps, 1, 400, 0, { speed: 30 });
  assert.equal(first[first.length - 1].text, '請右轉，接著左轉。');
  const second = drive(ann, steps, 2, 80, 0, { speed: 30 });
  assert.deepEqual(second.map(s => s.text), ['請左轉。']); // 預告已合併念過，路口仍有實際指令
});

test('相距很遠的兩個轉彎不會合併', () => {
  const steps = [step('depart', '', '', 800), step('turn', 'right', '', 900), step('turn', 'left', '', 500), step('arrive')];
  const ann = NV.createTurnAnnouncer();
  const first = drive(ann, steps, 1, 400, 0, { speed: 40 });
  assert.ok(first.every(s => !/接著/.test(s.text)));
});

test('沒有路名時不念「進入」；有路名才念', () => {
  const steps = [step('depart', '', '', 800), step('turn', 'right', '', 500), step('arrive')];
  const ann = NV.createTurnAnnouncer();
  const said = drive(ann, steps, 1, 400, 0);
  assert.ok(said.every(s => !/進入/.test(s.text)));
  assert.ok(said.every(s => !/紅綠燈/.test(s.text))); // 沒有可靠的紅綠燈數量資料，一律不念
});

test('車速無效時用保守預設，不會因異常車速算出好幾公里外的提醒', () => {
  const urban = NV.turnThresholds('urban', null);
  assert.equal(urban.far, 300);
  const crazy = NV.turnThresholds('urban', 900); // 異常讀數
  assert.ok(crazy.far <= 600, 'far ' + crazy.far);
  const ex = NV.turnThresholds('exit', 900);
  assert.ok(ex.far <= 2000);
});

test('重新規劃路線：舊路線的轉彎事件取消，新路線重新開始', () => {
  const steps = [step('depart', '', '', 800), step('turn', 'right', '', 500), step('arrive')];
  const ann = NV.createTurnAnnouncer();
  drive(ann, steps, 1, 320, 290, { rv: 1 });
  ann.setRoute(2);
  const said = drive(ann, steps, 1, 320, 290, { rv: 2 });
  assert.equal(said.length, 1); // 新路線版本是新的事件
  assert.equal(ann.state(1, steps, 1), null);
});

test('開始導航的第一句念實際距離，比它遠的階段不再念', () => {
  const steps = [step('depart', '', '', 250), step('turn', 'left', '忠孝東路', 500), step('arrive')];
  const ann = NV.createTurnAnnouncer();
  const first = ann.intro({ routeVersion: 1, steps, index: 1, meters: 250, speedKmh: null });
  assert.equal(first, '前方300公尺，請左轉進入忠孝東路。');
  const rest = drive(ann, steps, 1, 240, 0, { speed: 40 });
  assert.deepEqual(rest.map(s => s.phase), ['near0', 'now']);
  assert.equal(rest[1].text, '請左轉。');
});

test('沿同一條路直走/改路名不播報', () => {
  const steps = [step('depart', '', '', 800), step('new name', 'straight', '忠孝東路四段', 500), step('arrive')];
  const ann = NV.createTurnAnnouncer();
  assert.deepEqual(drive(ann, steps, 1, 600, 0), []);
});

test('距離念法不會出現 150、437 這種數字', () => {
  [150, 437, 860, 1240, 1760, 55].forEach(m => assert.match(NV.distText(m), /^(\d+00公尺|\d0公尺|\d+(\.5)?公里)$/));
  assert.equal(NV.distText(150), '200公尺');
});

// ═════════════ 執法分類 ═════════════
test('執法類型：固定、區間、闖紅燈、科技執法、移動式分開', () => {
  assert.equal(NV.classifyEnforcement({ limit: 60, dir: '南向北' }).label, '固定式測速照相');
  assert.equal(NV.classifyEnforcement({ limit: 70, dir: '南北雙向(區間測速)' }).kind, 'section');
  // 區間測速寫在地址欄(資料實際有這種)
  assert.equal(NV.classifyEnforcement({ limit: 40, addr: '臺9戊線3.94K至9.92K區間測速', dir: '雙向測速科技執法' }).label, '區間測速照相');
  assert.equal(NV.classifyEnforcement({ limit: 50, dir: '南北雙向兼闖紅燈' }).label, '固定式測速照相兼闖紅燈照相');
  assert.equal(NV.classifyEnforcement({ limit: 90, addr: '國道五號南向16.9公里(雪山隧道科技執法)' }).label, '科技執法測速照相');
  assert.equal(NV.classifyEnforcement({ limit: 80, kind: 'mobile' }).label, '移動式測速');
  assert.equal(NV.classifyEnforcement({ limit: 0 }).limit, null);
  assert.equal(NV.classifyEnforcement({ limit: 999 }).limit, null);
});

// ═════════════ 速度驗證 ═════════════
test('速度：正常 GPS 速度直接用(公尺/秒 × 3.6)', () => {
  const v = NV.createSpeedValidator();
  const r = v.update({ lat: 25, lon: 121, t: 1000, speedMs: 25, acc: 5 });
  assert.equal(Math.round(r.kmh), 90);
  assert.equal(r.valid, true);
});

test('速度：一秒內從 50 跳到 150 是跳點(不採用、不截斷)，連續兩筆都 150 才接受', () => {
  const v = NV.createSpeedValidator();
  v.update({ lat: 25, lon: 121, t: 1000, speedMs: 50 / 3.6, acc: 5 });
  const spike = v.update({ lat: 25, lon: 121, t: 2000, speedMs: 150 / 3.6, acc: 5 });
  assert.equal(Math.round(spike.kmh), 50); // 沿用上一筆有效值
  assert.match(v.lastRejected().reason, /跳點/);
  const back = v.update({ lat: 25, lon: 121, t: 3000, speedMs: 52 / 3.6, acc: 5 });
  assert.equal(Math.round(back.kmh), 52);
});

test('速度：真的加速(連續兩筆一致)會被接受', () => {
  const v = NV.createSpeedValidator();
  v.update({ lat: 25, lon: 121, t: 1000, speedMs: 20 / 3.6 });
  v.update({ lat: 25, lon: 121, t: 2000, speedMs: 80 / 3.6 });
  const r = v.update({ lat: 25, lon: 121, t: 3000, speedMs: 82 / 3.6 });
  assert.equal(Math.round(r.kmh), 82);
});

test('速度：沒有 GPS 速度時用位移補；補不出來就無效', () => {
  const v = NV.createSpeedValidator();
  const a = v.update({ lat: 25, lon: 121, t: 0, speedMs: null, acc: 5 });
  assert.equal(a.valid, false);
  const b = v.update({ lat: 25 + 0.0002712, lon: 121, t: 3000, speedMs: null, acc: 5 }); // 約 30 公尺 / 3 秒 = 36 km/h
  assert.equal(b.valid, true);
  assert.ok(Math.abs(b.kmh - 36) < 2, String(b.kmh));
});

test('速度：負數、NaN、超過 250 都是無效；超過 5 秒沒更新算過期', () => {
  const v = NV.createSpeedValidator();
  assert.equal(v.update({ lat: 25, lon: 121, t: 0, speedMs: -1 }).valid, false);
  assert.equal(v.update({ lat: 25, lon: 121, t: 100, speedMs: NaN }).valid, false);
  assert.equal(v.update({ lat: 25, lon: 121, t: 200, speedMs: 300 / 3.6 }).valid, false);
  v.update({ lat: 25, lon: 121, t: 1000, speedMs: 10 });
  assert.equal(v.get(7000).valid, false);
});

// ═════════════ 語音佇列 ═════════════
function fakePlayer() {
  const played = [];
  let resolveCurrent = null;
  return {
    played,
    play: item => new Promise(res => { played.push(typeof item === 'function' ? '<fn>' : item); resolveCurrent = () => res({ ok: true }); }),
    stop: () => { if (resolveCurrent) resolveCurrent(); },
    finish: () => { const r = resolveCurrent; resolveCurrent = null; if (r) r(); return new Promise(r2 => setImmediate(r2)); }
  };
}

test('佇列：同時排入時，轉彎優先於測速，測速優先於一般資訊', async () => {
  const p = fakePlayer();
  let t = 0;
  const q = NV.createVoiceQueue({ play: p.play, stop: p.stop, now: () => t });
  q.speak('一般資訊', { priority: NV.PRI.INFO, key: 'a' });           // 立刻開始播
  q.speak('測速', { priority: NV.PRI.ENFORCE, key: 'b' });
  q.speak('轉彎預告', { priority: NV.PRI.TURN, key: 'c' });
  await p.finish(); await p.finish(); await p.finish();
  assert.deepEqual(p.played, ['一般資訊', '轉彎預告', '測速']);
});

test('佇列：實際轉彎指令可打斷正在播的測速，被打斷的測速稍後重播一次', async () => {
  const p = fakePlayer();
  let t = 0;
  const q = NV.createVoiceQueue({ play: p.play, stop: p.stop, now: () => t });
  q.speak('1公里後有固定式測速照相', { priority: NV.PRI.ENFORCE, key: 'cam', maxAgeMs: 20000 });
  q.speak('請右轉。', { priority: NV.PRI.CRITICAL, key: 'turn' });
  await new Promise(r => setImmediate(r));
  await p.finish(); await p.finish();
  assert.deepEqual(p.played, ['1公里後有固定式測速照相', '請右轉。', '1公里後有固定式測速照相']);
  const statuses = q.logs().map(l => l.status);
  assert.ok(statuses.includes('interrupted'));
});

test('佇列：轉彎提醒不會打斷正在播的另一句轉彎提醒', async () => {
  const p = fakePlayer();
  const q = NV.createVoiceQueue({ play: p.play, stop: p.stop, now: () => 0 });
  q.speak('前方300公尺，請右轉。', { priority: NV.PRI.TURN, key: 'x' });
  q.speak('請左轉。', { priority: NV.PRI.CRITICAL, key: 'y' });
  await new Promise(r => setImmediate(r));
  assert.equal(q.logs().filter(l => l.status === 'interrupted').length, 0);
});

test('佇列：排隊過期的不播；同一個 eventId 播完不會再排入', async () => {
  const p = fakePlayer();
  let t = 0;
  const q = NV.createVoiceQueue({ play: p.play, stop: p.stop, now: () => t });
  q.speak('第一句', { key: 'a' });
  q.speak('300公尺', { key: 'cam', maxAgeMs: 3000, priority: NV.PRI.ENFORCE });
  t = 5000;
  await p.finish();
  assert.deepEqual(p.played, ['第一句']);
  assert.ok(q.logs().some(l => l.status === 'expired'));
  q.speak('請右轉。', { eventId: 'E1', key: 't' });
  await p.finish();
  assert.equal(q.speak('請右轉。', { eventId: 'E1', key: 't' }), null);
  assert.equal(p.played.filter(x => x === '請右轉。').length, 1);
});

test('佇列：播放失敗有限重試(最多 1 次)，不會無限重試', async () => {
  let calls = 0;
  const q = NV.createVoiceQueue({ play: () => { calls++; return Promise.resolve({ ok: false, reason: 'not-allowed' }); }, now: () => 0 });
  q.speak('您已通過', { priority: NV.PRI.ENFORCE, key: 'cam' });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls, 2);
  assert.ok(q.logs().some(l => l.status === 'failed'));
});

test('佇列：取消舊路線的轉彎提醒', async () => {
  const p = fakePlayer();
  const q = NV.createVoiceQueue({ play: p.play, stop: p.stop, now: () => 0 });
  q.speak('一般', { key: 'z' });
  q.speak('前方300公尺，請右轉。', { key: 'turn', routeVersion: 1, priority: NV.PRI.TURN });
  q.cancelWhere(e => e.routeVersion != null && e.routeVersion !== 2, '路線已重新規劃');
  await p.finish();
  assert.deepEqual(p.played, ['一般']);
});

test('提示音 WAV 格式正確', () => {
  const buf = NV.chimeWav();
  const s = String.fromCharCode(...new Uint8Array(buf.slice(0, 4)));
  assert.equal(s, 'RIFF');
  assert.ok(buf.byteLength > 20000);
});

test('佇列：提示音失敗時「您已通過」仍然會念，紀錄裡寫明提示音失敗原因', async () => {
  const spoken = [];
  const q = NV.createVoiceQueue({
    play: item => typeof item === 'function' ? item() : (spoken.push(item), Promise.resolve({ ok: true })),
    now: () => 0
  });
  q.speak([() => Promise.resolve({ ok: false, reason: 'NotAllowedError' }), '您已通過'], { priority: NV.PRI.ENFORCE, key: 'cam' });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(spoken, ['您已通過']);
  const done = q.logs().find(l => l.status === 'completed');
  assert.match(done.reason, /提示音失敗：NotAllowedError/);
});

test('到達目的地只在接近時預告一次(實際到達另由導航完成流程念)', () => {
  const steps = [step('depart', '', '', 800), step('arrive', '', '', 0)];
  const ann = NV.createTurnAnnouncer();
  const said = drive(ann, steps, 1, 600, 0, { speed: 40 });
  assert.deepEqual(said.map(s => s.text), ['前方100公尺到達目的地。']);
});

test('「繼續」類只有真的轉彎/迴轉才念，道路自然微彎(continue + slight)不念', () => {
  const steps = [step('depart', '', '', 800), step('continue', 'slight right', '市府路', 400), step('arrive')];
  assert.deepEqual(drive(NV.createTurnAnnouncer(), steps, 1, 400, 0), []);
  const s2 = [step('depart', '', '', 800), step('continue', 'uturn', '', 400), step('arrive')];
  assert.equal(drive(NV.createTurnAnnouncer(), s2, 1, 400, 0).pop().text, '請迴轉。');
});
