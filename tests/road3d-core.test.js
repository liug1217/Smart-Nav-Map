// 3D 道路資料核心計算(tools/road3d-core.js)的測試：用簡單的假道路檢查每個步驟
const test = require('node:test');
const assert = require('node:assert');
const C = require('../tools/road3d-core');

// 沿經線往北的一條路：lat 從 lat0 開始，每點間隔 dLat
const line = (lon, lat0, dLat, n) => Array.from({ length: n }, (_, i) => ({ lon, lat: lat0 + dLat * i }));
const way = (id, nodes, pts, tags) => ({ type: 'way', id, nodes, geometry: pts, tags: Object.assign({ highway: 'motorway', oneway: 'yes' }, tags) });

test('parseWays：隧道不收、oneway=-1 反轉成行車方向、沒標車道數用一般值', () => {
  const ws = C.parseWays([
    way(1, [1, 2], line(121, 25, 0.001, 2), {}),
    way(2, [3, 4], line(121, 25, 0.001, 2), { tunnel: 'yes' }),
    way(3, [5, 6], line(121, 25, 0.001, 2), { highway: 'trunk', oneway: '-1', lanes: '2' }),
    way(4, [7, 8], line(121, 25, 0.001, 2), { highway: 'motorway_link' }),
  ]);
  assert.deepStrictEqual(ws.map((w) => w.id), [1, 3, 4]);
  assert.strictEqual(ws[0].lanes, 3);
  assert.deepStrictEqual(ws[1].nodes, [6, 5]);
  assert.strictEqual(ws[1].lanes, 2);
  assert.strictEqual(ws[2].link, true);
  assert.strictEqual(ws[2].lanes, 1);
});

test('buildChains：首尾相接的路接成一條；分岔時主線接主線、匝道自己一條', () => {
  const ws = C.parseWays([
    way(1, [1, 2, 3], line(121, 25, 0.001, 3), {}),
    way(2, [3, 4, 5], line(121, 25.002, 0.001, 3), {}),
    // 從節點 3 往東北分出去的匝道
    way(3, [3, 9], [{ lon: 121, lat: 25.002 }, { lon: 121.001, lat: 25.003 }], { highway: 'motorway_link' }),
  ]);
  const chains = C.buildChains(ws);
  const ids = chains.map((c) => c.ways.map((w) => w.id).join('+')).sort();
  assert.deepStrictEqual(ids, ['1+2', '3']);
  const main = chains.find((c) => c.ways.length === 2);
  assert.deepStrictEqual(main.nodes, [1, 2, 3, 4, 5]);   // 接點不重複
});

test('smoothChain：曲線穿過每個原本的點，間距約 3 公尺', () => {
  const ws = C.parseWays([way(1, [1, 2, 3], [{ lon: 121, lat: 25 }, { lon: 121, lat: 25.001 }, { lon: 121.001, lat: 25.002 }], {})]);
  const ch = C.buildChains(ws)[0];
  const sm = C.smoothChain(ch);
  const nodes = sm.filter((o) => o.node != null).map((o) => o.node);
  assert.deepStrictEqual(nodes, [1, 2, 3]);
  C.prepChain(ch);
  for (let i = 1; i < ch.v.length; i++) assert.ok(ch.v[i].S - ch.v[i - 1].S < 3.5, '點間距 ' + (ch.v[i].S - ch.v[i - 1].S));
});

test('dilate：整座橋滿高度，引道照坡度降到地面', () => {
  const v = Array.from({ length: 101 }, (_, i) => ({ S: i * 10 }));   // 1 公里，每 10 公尺一點
  const target = v.map((o) => (o.S >= 400 && o.S <= 600 ? 1.2 : 0));
  const h = C.dilate(v, target, 0.012);
  assert.strictEqual(h[50], 1.2);               // 橋中間
  assert.strictEqual(h[40], 1.2);               // 橋頭
  assert.ok(Math.abs(h[35] - 0.6) < 1e-9);      // 橋頭前 50 公尺：降一半
  assert.strictEqual(h[20], 0);                 // 前 200 公尺已經在地面
});

test('sections：車道數變少時路寬漸變(90 公尺縮一個車道)，不會一刀切', () => {
  const ws = C.parseWays([
    way(1, [1, 2], line(121, 25, 0.004, 2), { lanes: '4' }),
    way(2, [2, 3], line(121, 25.004, 0.004, 2), { lanes: '3' }),
  ]);
  const ch = C.buildChains(ws)[0];
  C.prepChain(ch); C.sections(ch);
  const v = ch.v, widths = v.map((o) => o.b - o.a);
  for (let i = 1; i < v.length; i++) {
    const slope = Math.abs(widths[i] - widths[i - 1]) / (v[i].S - v[i - 1].S);
    assert.ok(slope <= 3.75 / 90 + 1e-6, '斜率太大 ' + slope);
  }
  assert.ok(Math.abs(widths[0] - 4 * 3.75) < 1e-6);
  assert.ok(Math.abs(widths[v.length - 1] - 3 * 3.75) < 1e-6);
});

test('medians：兩個方向間隔太遠 / 太近時，分隔島拉回 1～3 公尺', () => {
  for (const sepM of [30, 16]) {   // 中心線相隔 30 公尺(太遠)、16 公尺(太近：路寬各 15.25)
    const dLon = sepM / (111320 * Math.cos(25 * Math.PI / 180));
    const ws = C.parseWays([
      way(1, [1, 2], line(121, 25, 0.01, 2), {}),                                              // 往北
      way(2, [3, 4], line(121 - dLon, 25.01, -0.01, 2), {}),                                   // 往南，在西邊(北上的左邊)
    ]);
    const chains = C.buildChains(ws);
    chains.forEach(C.prepChain); C.heights(chains); chains.forEach(C.sections); C.medians(chains);
    const [a, b] = chains, mid = a.v[Math.floor(a.v.length / 2)];
    // 對面最近的點
    let best = Infinity;
    for (const o of b.v) best = Math.min(best, Math.hypot(o.P[0] - mid.P[0], o.P[1] - mid.P[1]) * mid.k);
    const gap = best + mid.eL + b.v[0].eL;
    assert.ok(gap >= 1.0 - 0.05 && gap <= 3.0 + 0.05, `中心線相隔 ${sepM} 公尺 → 分隔島 ${gap.toFixed(2)} 公尺`);
  }
});

test('marksYield：主線優先、車道多的優先、再一樣固定一條', () => {
  const main = { link: false, lanes: 3, id: 1 }, link = { link: true, lanes: 1, id: 2 }, link2 = { link: true, lanes: 2, id: 3 };
  assert.strictEqual(C.marksYield(link, main), true);
  assert.strictEqual(C.marksYield(main, link), false);
  assert.strictEqual(C.marksYield(link, link2), true);
  assert.strictEqual(C.marksYield(link2, link), false);
  const x = { link: true, lanes: 1, id: 5 }, y = { link: true, lanes: 1, id: 6 };
  assert.notStrictEqual(C.marksYield(x, y), C.marksYield(y, x));   // 一模一樣時只有一條讓
});

test('makeCover：護欄落在同高度別條路面上不畫；高一層的路不算(本來就會擋住)', () => {
  const ws = C.parseWays([
    way(1, [1, 2], line(121, 25, 0.004, 2), {}),
    way(2, [3, 4], [{ lon: 120.998, lat: 25.002 }, { lon: 121.002, lat: 25.002 }], { highway: 'trunk' }),   // 東西向橫過
  ]);
  const chains = C.buildChains(ws);
  chains.forEach(C.prepChain); C.heights(chains); chains.forEach(C.sections);
  const covered = C.makeCover(chains);
  const ns = chains.find((c) => c.ways[0].id === 1), ew = chains.find((c) => c.ways[0].id === 2);
  const cross = C.merc(121, 25.002);
  assert.strictEqual(covered(cross, 0.4, ew, 'rail'), true);    // 東西向的護欄在南北向路面上
  assert.strictEqual(covered(cross, 3, ew, 'rail'), false);     // 高度差很多(不同層)不算
  const far = C.merc(120.999, 25.002);
  assert.strictEqual(covered(far, 0.4, ew, 'rail'), false);     // 路面外
});
