// 第 2 版 3D 道路引擎：幾何基礎(tools/road3d2/geom.js)
const test = require('node:test');
const assert = require('node:assert');
const G = require('../tools/road3d2/geom');

// 以 (lon0, lat0) 為圓心、半徑 R 公尺的圓弧上取 n 點(Mercator)
function arc(R, deg0, deg1, n) {
  const c = G.merc(121, 25), k = G.kAtY(c[1]), out = [];
  for (let i = 0; i < n; i++) {
    const a = (deg0 + (deg1 - deg0) * i / (n - 1)) * Math.PI / 180;
    out.push([c[0] + Math.cos(a) * R / k, c[1] + Math.sin(a) * R / k]);
  }
  return { pts: out, c, k };
}

test('resample：等弧長取點，間距 2 公尺上下、原始節點一定是取樣點', () => {
  const { pts } = arc(500, 0, 30, 7);   // 半徑 500 公尺、30 度：每段約 43.6 公尺
  const g = G.resample(pts);
  for (let i = 1; i < g.P.length; i++) {
    const d = g.S[i] - g.S[i - 1];
    assert.ok(d > 1.9 && d < 2.1, '間距 ' + d);
  }
  g.nodeAt.forEach((j, i) => { assert.deepStrictEqual(g.P[j], pts[i]); });
  // 總長 ≈ 圓弧長 2πR × 30/360
  assert.ok(Math.abs(g.S[g.S.length - 1] - 2 * Math.PI * 500 / 12) < 0.5);
});

test('切線、法向量：圓弧上切線垂直於半徑，法向量水平且不翻面(頭尾第一段沒有前後點可參考，不算)', () => {
  const { pts, c } = arc(300, 0, 90, 10);
  const g = G.resample(pts);
  for (let i = g.nodeAt[1]; i <= g.nodeAt[8]; i++) {
    const r = [g.P[i][0] - c[0], g.P[i][1] - c[1]], rl = Math.hypot(r[0], r[1]);
    const dot = (r[0] * g.T[i][0] + r[1] * g.T[i][1]) / rl;
    assert.ok(Math.abs(dot) < 0.01, '切線不垂直半徑 ' + dot);
    // 逆時針走：右手法向量朝外(遠離圓心)，整段都一樣不翻
    const n = G.normalOf(g.T[i]);
    assert.ok((n[0] * r[0] + n[1] * r[1]) / rl > 0.99);
  }
});

test('radii：圓弧的曲率半徑估得準(最多偏小 20%，不會偏大)', () => {
  const { pts } = arc(200, 0, 60, 12);
  const g = G.resample(pts), R = G.radii(g, 10);
  for (let i = g.nodeAt[1]; i <= g.nodeAt[10]; i++) assert.ok(R[i] > 160 && R[i] < 202, '半徑 ' + R[i]);
});

test('relaxCurvature：太急的折角會被平滑到半徑夠大，固定點不動', () => {
  const c = G.merc(121, 25), k = G.kAtY(c[1]);
  // 直角折線(100 公尺 + 100 公尺)
  const pts = [[c[0], c[1]], [c[0] + 100 / k, c[1]], [c[0] + 100 / k, c[1] + 100 / k]];
  const g = G.resample(pts);
  const fixedIdx = new Set([0, g.P.length - 1]);
  const r = G.relaxCurvature(g, () => 15, (i) => fixedIdx.has(i), 200);
  assert.ok(r.ok, '沒通過，最差比例 ' + r.worst);
  assert.deepStrictEqual(g.P[0], pts[0]);
});

test('rollingMedian：單一個歪掉的點不會影響結果', () => {
  const S = Array.from({ length: 101 }, (_, i) => i * 2), v = S.map(() => 3);
  v[50] = 30;
  const m = G.rollingMedian(S, v, 100);
  assert.ok(m.every((x) => x === 3));
});

// ── 高度 ──
const N = require('../tools/road3d2/network');
const H = require('../tools/road3d2/heights');
const way = (id, nodes, pts, tags) => ({ type: 'way', id, nodes, geometry: pts.map((p) => ({ lon: p[0], lat: p[1] })), tags: Object.assign({ highway: 'motorway', oneway: 'yes' }, tags) });
const setup = (els) => { const chains = N.buildChains(N.parseWays(els)); chains.forEach(N.prepChain); return chains; };

test('高度：橋 6 公尺滿高度，引道 4% 坡度降回地面', () => {
  // 南北向 3 公里：中間 1 公里是橋
  const els = [
    way(1, [1, 2], [[121, 25], [121, 25.009]], {}),
    way(2, [2, 3], [[121, 25.009], [121, 25.018]], { bridge: 'yes', layer: '1' }),
    way(3, [3, 4], [[121, 25.018], [121, 25.027]], {}),
  ];
  const chains = setup(els);
  H.computeHeights(chains);
  const ch = chains[0], S = ch.g.S, z = ch.z;
  const at = (s) => { let i = 0; while (i < S.length - 1 && S[i + 1] < s) i++; return z[i]; };
  assert.ok(Math.abs(at(1500) - 6) < 1e-6, '橋中間 ' + at(1500));
  assert.ok(at(500) === 0, '離橋 500 公尺已經在地面');
  for (let i = 1; i < z.length; i++) assert.ok(Math.abs(z[i] - z[i - 1]) / (S[i] - S[i - 1]) <= 0.0401, '坡度太陡');
});

test('高度：上下交叉一定有 4.5 公尺淨空(差 5.3)，連兩條都標 layer 1 的橋也一樣', () => {
  const els = [
    way(1, [1, 2], [[121, 24.99], [121, 25.01]], { bridge: 'yes', layer: '1' }),                       // 南北向
    way(2, [3, 4], [[120.99, 25], [121.01, 25]], { highway: 'trunk', bridge: 'yes', layer: '1' }),      // 東西向，也是 layer 1
  ];
  const chains = setup(els);
  const r = H.computeHeights(chains);
  const cl = H.clearances(r.crossings);
  assert.strictEqual(cl.length, 1);
  assert.strictEqual(cl[0].kind, 'guessed');
  assert.ok(cl[0].dz >= 5.3 - 1e-6, '淨空不夠 ' + cl[0].dz);
});

test('高度：平面路口(兩條都不是橋)不要求淨空', () => {
  const els = [
    way(1, [1, 2], [[121, 24.99], [121, 25.01]], { highway: 'trunk', oneway: 'no' }),
    way(2, [3, 4], [[120.99, 25], [121.01, 25]], { highway: 'trunk', oneway: 'no' }),
  ];
  const chains = setup(els);
  const r = H.computeHeights(chains);
  assert.strictEqual(H.clearances(r.crossings)[0].kind, 'atgrade');
  assert.ok(chains.every((c) => c.z.every((x) => x === 0)));
});

// ── 中央分隔島 ──
const K = require('../tools/road3d2/corridor');
// 往北、往南兩條主線：西邊那條(往南)經度偏移 offM(lat) 公尺(可以讓間距沿路變化)
function pairRoads(offFn, len = 0.03, n = 31) {
  const k = 111320 * Math.cos(25 * Math.PI / 180);
  const north = [], south = [];
  for (let i = 0; i < n; i++) { const lat = 25 + len * i / (n - 1); north.push([121, lat]); }
  for (let i = n - 1; i >= 0; i--) { const lat = 25 + len * i / (n - 1); south.push([121 - offFn(lat) / k, lat]); }
  const chains = setup([way(1, [...Array(n).keys()].map((x) => x + 1), north, {}), way(2, [...Array(n).keys()].map((x) => x + 100), south, {})]);
  H.computeHeights(chains); chains.forEach(K.sections);
  const runs = K.corridors(chains);
  return { chains, runs };
}
// 實際分隔島寬度(兩邊路面內緣距離)：在第一條路的第 i 點量
function actualGap(chains, i) {
  const [A, B] = chains, p = A.g.P[i], pr = G.project(B.g, p);
  return pr.dist - K.halfW(A, i) - K.halfW(B, Math.min(B.g.P.length - 1, pr.i));
}

test('分隔島：原始間距亂抖，結果還是穩定的固定寬度', () => {
  // 中心線間距 18 公尺(路寬各 15.25 → 原始分隔島 2.75)，每個原始點加上 ±0.6 公尺的亂抖(OSM 點位誤差大約這樣)
  let seed = 1; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const { chains, runs } = pairRoads(() => 18 + (rnd() - 0.5) * 1.2);
  assert.ok(runs.length >= 1);
  const A = chains[0], n = A.g.P.length, gaps = [];
  for (let i = Math.floor(n * 0.25); i < n * 0.75; i += 5) gaps.push(actualGap(chains, i));
  const mx = Math.max(...gaps), mn = Math.min(...gaps);
  assert.ok(mx - mn < 0.1, `分隔島寬度還在抖：${mn.toFixed(2)}～${mx.toFixed(2)}`);
  assert.ok(mn >= 1.0 - 0.05 && mx <= 3.0 + 0.05);
});

test('分隔島：寬度真的改變時用 smoothstep 慢慢過渡，不會突然跳', () => {
  // 前半段中心線間距 17(分隔島 1.75)，後半段 18(分隔島 2.75)
  const { chains } = pairRoads((lat) => (lat < 25.015 ? 17 : 18));
  const A = chains[0], n = A.g.P.length;
  let prev = null, maxStep = 0;
  const first = actualGap(chains, Math.floor(n * 0.2)), last = actualGap(chains, Math.floor(n * 0.8));
  for (let i = Math.floor(n * 0.2); i < n * 0.8; i++) {
    const g = actualGap(chains, i);
    if (prev !== null) maxStep = Math.max(maxStep, Math.abs(g - prev) / (A.g.S[i] - A.g.S[i - 1]));
    prev = g;
  }
  assert.ok(Math.abs(first - 1.75) < 0.1 && Math.abs(last - 2.75) < 0.1, `前 ${first.toFixed(2)} 後 ${last.toFixed(2)}`);
  // 差 1 公尺，最短 150 公尺過渡：smoothstep 最陡 = 1.5 × 1 / 150 = 0.01(每公尺)
  assert.ok(maxStep < 0.012, '過渡太陡 ' + maxStep.toFixed(4));
});

test('高度：三條路互相交叉(抬高一條會影響另一個交叉)，最後每個交叉都有 4.5 公尺淨空', () => {
  const els = [
    way(1, [1, 2], [[121, 24.99], [121, 25.01]], { bridge: 'yes', layer: '1' }),                          // 南北向
    way(2, [3, 4], [[120.99, 25], [121.01, 25]], { highway: 'trunk', bridge: 'yes', layer: '2' }),        // 東西向，在南北向上面
    way(3, [5, 6], [[120.99, 24.99], [121.01, 25.01]], { highway: 'motorway_link', bridge: 'yes', layer: '3' }),   // 斜的，在兩條上面
  ];
  const chains = setup(els);
  const r = H.computeHeights(chains);
  const cl = H.clearances(r.crossings).filter((c) => c.kind !== 'atgrade');
  assert.ok(cl.length >= 3, '交叉數 ' + cl.length);
  for (const c of cl) assert.ok(c.dz >= 5.3 - 1e-6, '淨空不夠 ' + c.dz.toFixed(2));
});

// ── 自動檢查 ──
const V = require('../tools/road3d2/validate');
test('自動檢查：沒過只排除那一段，不是整條路(長路某一點出問題，其他幾公里照常產生)', () => {
  const els = [
    way(1, [1, 2, 3], [[121, 24.98], [121, 25.0], [121, 25.02]], { bridge: 'yes', layer: '1' }),   // 南北向 4.4 公里
    way(2, [4, 5], [[120.99, 25], [121.01, 25]], { highway: 'trunk', bridge: 'yes', layer: '1' }),    // 東西向橫過
  ];
  const chains = setup(els);
  const r = H.computeHeights(chains);
  chains.forEach(K.sections);
  // 故意把東西向在交叉點的高度弄壞(淨空不夠)
  const c = H.clearances(r.crossings)[0];
  c.up.z = c.up.z.map(() => 0); c.low.z = c.low.z.map(() => 0);
  const res = V.validate(chains, [], r.crossings);
  assert.ok(res.failures.some((f) => f.check === 'clearance'));
  const up = c.up, L = up.g.S[up.g.S.length - 1], bad = up.bad.reduce((a, x) => a + x[1] - x[0], 0);
  assert.ok(bad > 0 && bad <= 401, '排除長度 ' + bad);
  assert.ok(bad < L / 2, '不能整條排除');
});
