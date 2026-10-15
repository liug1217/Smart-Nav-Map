// 3D 道路資料的核心計算(給 tools/build-road3d.js 用；也有單元測試 tests/road3d-core.test.js)
// 全部在電腦上一次算好：手機只負責把結果畫出來(road_3d.js)。
//
// 流程：
//   1. parseWays     OSM 道路(國道、快速道路、匝道)：方向統一成行車方向，記下車道數、橋梁、層
//   2. buildChains   一段段的路接成完整的一條(同一條國道整條連續，接縫不會裂開)
//   3. smoothChain   向心 Catmull-Rom 曲線(等同一串三次貝茲曲線)穿過每個原本的點，每 3 公尺一點
//   4. heights       橋梁照層數抬高，引道慢慢降到地面；匝道接主線的地方高度跟主線一樣
//   5. medians       中央分隔島寬度：沿路平滑後限制在 1～3 公尺(可以有寬有窄，但不會差很多)
//   6. sections      橫斷面：車道 3.75 公尺、內側路肩 1、外側路肩 3(匝道 2)；車道數變少的地方漸變
//   7. features      標線、護欄、路況綠線；落在別條路面上的部分不畫(交叉、匯流處)
//   8. gores         匝道分岔、匯入處的槽化線(白色外框＋斜紋)
//   9. tiles         切成 zoom 13 圖磚，每塊存成手機直接能畫的格式
//
// 座標：Web Mercator 公尺(X 往東、Y 往北)。實際地面距離 = Mercator 距離 × cos(緯度)。

'use strict';

const R_EARTH = 6378137, D2R = Math.PI / 180;
const LANE = 3.75;
const STEP = 3;                     // 曲線取點間距(公尺)
const LAYER_H = 1.2;                // 每一層橋抬高(公尺)：剛好高過下面道路的護欄，又不會讓平面的導航路線、車子跟橋面差太多
const RAMP_SLOPE = LAYER_H / 100;   // 引道坡度：100 公尺升一層
const MEDIAN_MIN = 1.0, MEDIAN_MAX = 3.0;
const TAPER_SLOPE = LANE / 90;      // 車道數變少：90 公尺縮一個車道

// ── 座標 ──
function merc(lon, lat) { return [R_EARTH * lon * D2R, R_EARTH * Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2))]; }
function unmerc(X, Y) { return [X / R_EARTH / D2R, (2 * Math.atan(Math.exp(Y / R_EARTH)) - Math.PI / 2) / D2R]; }
function cosAtY(Y) { return Math.cos(2 * Math.atan(Math.exp(Y / R_EARTH)) - Math.PI / 2); }   // 地面公尺 / Mercator 公尺

// ── 1. OSM 道路 ──
function parseWays(elements) {
  const out = [], seen = new Set();
  for (const e of elements) {
    if (e.type !== 'way' || !e.geometry || e.geometry.length < 2 || !e.nodes || seen.has(e.id)) continue;
    seen.add(e.id);
    const t = e.tags || {};
    if (/^(yes|building_passage|culvert)$/.test(t.tunnel || '')) continue;   // 隧道不畫
    const hw = t.highway || '', link = /_link$/.test(hw), cls = hw.replace('_link', '');
    if (cls !== 'motorway' && cls !== 'trunk') continue;
    let coords = e.geometry.map((g) => [g.lon, g.lat]), nodes = e.nodes.slice();
    if (coords.length !== nodes.length) continue;
    const oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === '-1' || (t.oneway !== 'no' && (cls === 'motorway' || t.junction === 'roundabout'));
    if (t.oneway === '-1') { coords.reverse(); nodes.reverse(); }
    const lanesTag = parseInt(t.lanes, 10);
    const lanes = Math.max(1, Math.min(8, lanesTag > 0 ? lanesTag : (oneway ? (link ? 1 : cls === 'motorway' ? 3 : 2) : (link ? 2 : 4))));
    const bridge = !!t.bridge && t.bridge !== 'no';
    const layer = Math.max(0, Math.min(5, parseInt(t.layer, 10) || (bridge ? 1 : 0)));
    out.push({ id: e.id, cls, link, oneway, lanes, bridge, layer, coords, nodes });
  }
  return out;
}

// ── 2. 接成完整的一條 ──
// 每個節點：結束在這裡的路 × 從這裡開始的路，挑「同樣是匝道 / 主線、轉彎角度最小」的配成一對
function headingAt(w, atEnd) {
  const c = w.coords, a = atEnd ? c[c.length - 2] : c[0], b = atEnd ? c[c.length - 1] : c[1];
  const A = merc(a[0], a[1]), B = merc(b[0], b[1]);
  return Math.atan2(B[0] - A[0], B[1] - A[1]);
}
function buildChains(ways) {
  const ins = new Map(), outs = new Map();
  for (const w of ways) {
    const s = w.nodes[0], e = w.nodes[w.nodes.length - 1];
    if (!outs.has(s)) outs.set(s, []); outs.get(s).push(w);
    if (!ins.has(e)) ins.set(e, []); ins.get(e).push(w);
  }
  const next = new Map(), prev = new Map();
  for (const [node, list] of ins) {
    const o = outs.get(node);
    if (!o) continue;
    const pairs = [];
    for (const a of list) for (const b of o) {
      if (a === b || a.oneway !== b.oneway) continue;
      let d = Math.abs(headingAt(a, true) - headingAt(b, false)); if (d > Math.PI) d = 2 * Math.PI - d;
      if (d > 60 * D2R) continue;   // 轉太大的不算同一條
      pairs.push({ a, b, score: d + (a.link === b.link ? 0 : 1) + (a.cls === b.cls ? 0 : 0.5) });
    }
    pairs.sort((x, y) => x.score - y.score);
    for (const p of pairs) if (!next.has(p.a) && !prev.has(p.b)) { next.set(p.a, p.b); prev.set(p.b, p.a); }
  }
  const chains = [], used = new Set();
  const walk = (start) => {
    const list = [];
    for (let w = start; w && !used.has(w); w = next.get(w)) { used.add(w); list.push(w); }
    return list;
  };
  for (const w of ways) if (!prev.has(w) && !used.has(w)) chains.push(walk(w));
  for (const w of ways) if (!used.has(w)) chains.push(walk(w));   // 環狀的
  return chains.map((list, id) => {
    const pts = [], nodes = [], segWay = [];
    list.forEach((w, k) => {
      w.coords.forEach((c, i) => {
        if (k > 0 && i === 0) return;   // 接點不重複
        pts.push(merc(c[0], c[1])); nodes.push(w.nodes[i]);
        if (pts.length > 1) segWay.push(w);
      });
    });
    return { id, ways: list, pts, nodes, segWay, oneway: list[0].oneway };
  });
}

// ── 3. 曲線平滑 ──
// 回傳每 3 公尺一點：P(Mercator)、src(來自原本第幾段)、node(原本的節點 id，不是節點就是 null)
function smoothChain(ch) {
  const P = ch.pts, n = P.length;
  const out = [{ p: P[0], seg: 0, node: ch.nodes[0] }];
  const ghost0 = [2 * P[0][0] - P[1][0], 2 * P[0][1] - P[1][1]], ghostN = [2 * P[n - 1][0] - P[n - 2][0], 2 * P[n - 1][1] - P[n - 2][1]];
  const at = (i) => (i < 0 ? ghost0 : i >= n ? ghostN : P[i]);
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1), p1 = P[i], p2 = P[i + 1], p3 = at(i + 2);
    const k = cosAtY((p1[1] + p2[1]) / 2), dGround = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) * k;
    const m = Math.max(1, Math.ceil(dGround / STEP));
    const dist = (a, b) => Math.max(1e-6, Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5));
    const t0 = 0, t1 = dist(p0, p1), t2 = t1 + dist(p1, p2), t3 = t2 + dist(p2, p3);
    for (let j = 1; j <= m; j++) {
      if (j === m) { out.push({ p: p2, seg: i, node: ch.nodes[i + 1] }); break; }
      const t = t1 + (t2 - t1) * j / m, q = [0, 0];
      for (let c = 0; c < 2; c++) {
        const A1 = (t1 - t) / (t1 - t0) * p0[c] + (t - t0) / (t1 - t0) * p1[c];
        const A2 = (t2 - t) / (t2 - t1) * p1[c] + (t - t1) / (t2 - t1) * p2[c];
        const A3 = (t3 - t) / (t3 - t2) * p2[c] + (t - t2) / (t3 - t2) * p3[c];
        const B1 = (t2 - t) / (t2 - t0) * A1 + (t - t0) / (t2 - t0) * A2;
        const B2 = (t3 - t) / (t3 - t1) * A2 + (t - t1) / (t3 - t1) * A3;
        q[c] = (t2 - t) / (t2 - t1) * B1 + (t - t1) / (t2 - t1) * B2;
      }
      out.push({ p: q, seg: i, node: null });
    }
  }
  return out;
}

// 一條路的每個點：P、S(地面累積距離)、k(cos 緯度)、dir(前進方向)、屬性
function prepChain(ch) {
  const sm = smoothChain(ch), n = sm.length;
  const v = sm.map((o) => {
    const w = ch.segWay[Math.min(o.seg, ch.segWay.length - 1)];
    return { P: o.p.slice(), node: o.node, way: w, link: w.link, lanes: w.lanes, bridge: w.bridge, layer: w.layer, cls: w.cls };
  });
  ch.v = v;
  updateFrames(ch);
  return ch;
}
function updateFrames(ch) {
  const v = ch.v, n = v.length;
  let S = 0;
  for (let i = 0; i < n; i++) {
    v[i].k = cosAtY(v[i].P[1]);
    if (i) S += Math.hypot(v[i].P[0] - v[i - 1].P[0], v[i].P[1] - v[i - 1].P[1]) * (v[i].k + v[i - 1].k) / 2;
    v[i].S = S;
  }
  ch.L = S;
  for (let i = 0; i < n; i++) {
    const a = v[Math.max(0, i - 1)].P, b = v[Math.min(n - 1, i + 1)].P, dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1;
    v[i].dir = [dx / d, dy / d];   // Mercator 單位向量
  }
}
// 右手方向(Mercator，北上時往東)
const rightOf = (dir) => [dir[1], -dir[0]];

// ── 沿路距離 ±r 公尺平均 ──
function windowAvg(v, arr, r, ok) {
  const n = v.length, out = new Array(n);
  let lo = 0, hi = -1, sum = 0, cnt = 0;
  for (let k = 0; k < n; k++) {
    while (hi + 1 < n && v[hi + 1].S <= v[k].S + r) { hi++; if (ok(hi)) { sum += arr[hi]; cnt++; } }
    while (v[lo].S < v[k].S - r) { if (ok(lo)) { sum -= arr[lo]; cnt--; } lo++; }
    out[k] = cnt ? sum / cnt : null;
  }
  return out;
}

// ── 4. 高度 ──
// 每點目標高度(橋 = 層 × 1.2 公尺)，往前往後各掃一次：比旁邊低的點用坡度補上(整座橋都是滿高度，引道慢慢降)
function dilate(v, target, slope) {
  const n = v.length, h = target.slice();
  for (let i = 1; i < n; i++) h[i] = Math.max(h[i], h[i - 1] - slope * (v[i].S - v[i - 1].S));
  for (let i = n - 2; i >= 0; i--) h[i] = Math.max(h[i], h[i + 1] - slope * (v[i + 1].S - v[i].S));
  return h;
}
function heights(chains) {
  for (const ch of chains) {
    const target = ch.v.map((o) => (o.bridge ? LAYER_H * Math.max(1, o.layer) : 0));
    const h = dilate(ch.v, target, RAMP_SLOPE);
    ch.v.forEach((o, i) => { o.z = h[i]; });
  }
  // 路的頭尾接到別條路：頭尾高度對齊那條路在接點的高度(接在中間 → 照那條路；頭尾互接 → 平均)，往裡面慢慢過渡
  const byNode = new Map();
  chains.forEach((ch) => ch.v.forEach((o, i) => { if (o.node != null) { if (!byNode.has(o.node)) byNode.set(o.node, []); byNode.get(o.node).push({ ch, i }); } }));
  for (let iter = 0; iter < 2; iter++) {
    for (const ch of chains) {
      const n = ch.v.length;
      [0, n - 1].forEach((i) => {
        const list = (byNode.get(ch.v[i].node) || []).filter((o) => o.ch !== ch);
        if (!list.length) return;
        const inner = list.filter((o) => o.i > 0 && o.i < o.ch.v.length - 1);
        const want = inner.length ? Math.max(...inner.map((o) => o.ch.v[o.i].z))
          : (ch.v[i].z + list.reduce((a, o) => a + o.ch.v[o.i].z, 0)) / (list.length + 1);
        const diff = want - ch.v[i].z, rampL = Math.min(150, ch.L / 2);
        if (Math.abs(diff) < 0.01) return;
        ch.v.forEach((o) => {
          const d = i === 0 ? o.S : ch.L - o.S;
          if (d < rampL) o.z += diff * (1 - d / rampL);
        });
      });
    }
  }
}

// ── 6. 橫斷面 ──
// 單向：車道寬 = 車道數 × 3.75，路面置中在中心線上；車道數變多 / 變少的地方用固定斜率漸變(往前往後各掃一次取最小)
// o.eL / o.eR 路面左右緣，o.a / o.b 最左 / 最右車道外緣(相對中心線，往右為正，地面公尺)
function sections(ch) {
  const v = ch.v, n = v.length;
  if (!ch.oneway) {
    v.forEach((o) => { const W = o.lanes * LANE + 3; o.eL = -W / 2; o.eR = W / 2; o.a = -W / 2 + 1.5; o.b = W / 2 - 1.5; });
    return;
  }
  const bt = v.map((o) => o.lanes * LANE);
  for (let i = 1; i < n; i++) bt[i] = Math.min(bt[i], bt[i - 1] + TAPER_SLOPE * (v[i].S - v[i - 1].S));
  for (let i = n - 2; i >= 0; i--) bt[i] = Math.min(bt[i], bt[i + 1] + TAPER_SLOPE * (v[i + 1].S - v[i].S));
  v.forEach((o, i) => {
    const inner = 1.0, outer = o.link ? 2.0 : 3.0, W = bt[i] + inner + outer;
    o.eL = -W / 2; o.a = o.eL + inner; o.b = o.a + bt[i]; o.eR = W / 2;
  });
}

// ── 5. 中央分隔島 ──
function medians(chains) {
  const mains = chains.filter((ch) => ch.oneway && !ch.v.some((o) => o.link));
  // 格子：所有主線的線段
  const CELL = 120, grid = new Map();
  const put = (x, y, g) => { const key = x + ',' + y; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(g); };
  for (const ch of mains) {
    const v = ch.v;
    for (let i = 0; i < v.length - 1; i++) {
      const a = v[i].P, b = v[i + 1].P, dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      if (L < 1e-6) continue;
      const g = { ch, i, a, d: [dx / L, dy / L], L };
      const x0 = Math.floor(Math.min(a[0], b[0]) / CELL), x1 = Math.floor(Math.max(a[0], b[0]) / CELL);
      const y0 = Math.floor(Math.min(a[1], b[1]) / CELL), y1 = Math.floor(Math.max(a[1], b[1]) / CELL);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) put(x, y, g);
    }
  }
  const shifts = new Map();
  for (const ch of mains) {
    const v = ch.v, n = v.length, gaps = new Array(n).fill(null), wgts = new Array(n).fill(0), pairs = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const p = v[i].P, dir = v[i].dir, rgt = rightOf(dir), k = v[i].k;
      const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
      let best = null;
      for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
        for (const g of grid.get(x + ',' + y) || []) {
          if (g.ch === ch || g.d[0] * dir[0] + g.d[1] * dir[1] > -0.85) continue;
          const t = (p[0] - g.a[0]) * g.d[0] + (p[1] - g.a[1]) * g.d[1];
          if (t < -0.01 || t > g.L + 0.01) continue;   // 留一點誤差：投影剛好落在兩段交界時不會兩邊都漏掉
          const ov = g.ch.v[g.i];
          if (Math.abs(ov.z - v[i].z) > 0.6) continue;   // 不同層(高架 vs 平面)不配對
          const lat = ((g.a[0] + g.d[0] * t - p[0]) * rgt[0] + (g.a[1] + g.d[1] * t - p[1]) * rgt[1]) * k;
          if (lat >= 0) continue;   // 對向車道在左邊(靠右行駛)
          const dist = -lat;
          if (dist > 55 || (best && dist >= best.dist)) continue;
          best = { dist, other: ov, och: g.ch };
        }
      }
      if (!best) continue;
      // 兩邊路面內緣的距離：自己的左緣到對方的左緣(對方方向相反，它的左緣也朝這邊)
      gaps[i] = best.dist + v[i].eL + best.other.eL;
      pairs[i] = best.och;
      wgts[i] = best.dist <= 35 ? 1 : (55 - best.dist) / 20;
    }
    const smGap = windowAvg(v, gaps, 60, (k) => gaps[k] !== null);
    const shift = v.map((o, i) => {
      if (gaps[i] === null || smGap[i] === null) return 0;
      const target = Math.max(MEDIAN_MIN, Math.min(MEDIAN_MAX, smGap[i]));
      return (gaps[i] - target) / 2 * wgts[i];   // 正 = 往左(往對向)移；兩邊各移一半
    });
    const sm = windowAvg(v, shift, 30, () => true);
    shifts.set(ch, sm);
    // 移完之後的分隔島寬度(兩邊各移差不多一樣多)與對向是哪一條：中央護欄要畫一道還是兩道用
    v.forEach((o, i) => {
      if (gaps[i] !== null && wgts[i] >= 0.99) { o.medGap = gaps[i] - 2 * sm[i]; o.pairId = pairs[i].id; }
      else { o.medGap = null; o.pairId = null; }
    });
  }
  // 全部算完再移(算的時候都用原本的位置，兩邊才對稱)
  for (const [ch, sm] of shifts) {
    ch.v.forEach((o, i) => {
      const r = rightOf(o.dir), m = sm[i] / o.k;   // 地面公尺 → Mercator
      o.P = [o.P[0] - r[0] * m, o.P[1] - r[1] * m];
    });
    updateFrames(ch);
  }
}

// 頂點的斷面方向(右手，斜接；最多放大 2 倍)
function miterRight(v, i) {
  const n = v.length;
  const seg = (j) => { const a = v[j].P, b = v[j + 1].P, dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1; return [dy / d, -dx / d]; };
  const a = seg(Math.max(0, i - 1)), b = seg(Math.min(n - 2, i));
  let x = a[0] + b[0], y = a[1] + b[1]; const l = Math.hypot(x, y) || 1; x /= l; y /= l;
  const f = Math.min(2, 1 / Math.max(0.5, x * b[0] + y * b[1]));
  return [x * f, y * f];
}
// 某點、橫向偏移 o 公尺的 Mercator 位置
function offsetPoint(o, r, off) { const m = off / o.k; return [o.P[0] + r[0] * m, o.P[1] + r[1] * m]; }

// ── 7. 路面覆蓋：一點是不是在「別條路」的路面上 ──
function priority(ch) { return { link: ch.v.some((o) => o.link), lanes: ch.v.reduce((m, o) => Math.max(m, o.lanes), 0), id: ch.id }; }
// 標線：A 落在 B 路面上(同高度)時要不要讓 B：主線優先，再來車道多的，再一樣就固定一條(重疊處還是有一組標線)
function marksYield(pa, pb) {
  if (pa.link !== pb.link) return pa.link;
  if (pa.lanes !== pb.lanes) return pb.lanes > pa.lanes;
  return pb.id < pa.id;
}
function makeCover(chains) {
  const CELL = 60, grid = new Map();
  for (const ch of chains) {
    ch.pri = priority(ch);
    const v = ch.v;
    for (let i = 0; i < v.length - 1; i++) {
      const a = v[i], b = v[i + 1];
      const pad = Math.max(-a.eL, a.eR, -b.eL, b.eR) / a.k + 1;
      const x0 = Math.floor((Math.min(a.P[0], b.P[0]) - pad) / CELL), x1 = Math.floor((Math.max(a.P[0], b.P[0]) + pad) / CELL);
      const y0 = Math.floor((Math.min(a.P[1], b.P[1]) - pad) / CELL), y1 = Math.floor((Math.max(a.P[1], b.P[1]) + pad) / CELL);
      const g = { ch, a, b };
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = x + ',' + y; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(g);
      }
    }
  }
  // kind = 'rail'：同高度的別條路面上就不畫(護欄不會橫過路面；比較高的路面本來就會擋住)
  // kind = 'mark'：同高度、而且要讓那條路(marksYield)才不畫
  return function covered(p, z, ch, kind) {
    const list = grid.get(Math.floor(p[0] / CELL) + ',' + Math.floor(p[1] / CELL));
    if (!list) return false;
    for (const g of list) {
      if (g.ch === ch) continue;
      const A = g.a.P, B = g.b.P, dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
      if (!L2) continue;
      const t = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2;
      if (t < -1e-4 || t > 1 + 1e-4) continue;
      const k = g.a.k, L = Math.sqrt(L2), rgt = [dy / L, -dx / L];
      const lat = ((p[0] - A[0] - dx * t) * rgt[0] + (p[1] - A[1] - dy * t) * rgt[1]) * k;
      const eL = g.a.eL + (g.b.eL - g.a.eL) * t, eR = g.a.eR + (g.b.eR - g.a.eR) * t, zo = g.a.z + (g.b.z - g.a.z) * t;
      if (Math.abs(zo - z) > 0.4) continue;
      const margin = kind === 'rail' ? 0.5 : 0.3;
      if (lat < eL + margin || lat > eR - margin) continue;
      if (kind === 'rail' || marksYield(ch.pri, g.ch.pri)) return true;
    }
    return false;
  };
}

// 沿線(偏移 off(i))每 1 公尺取樣，回傳看得到的區間 [[s0, s1], ...]
function visibleRuns(ch, offAt, z0, kind, covered) {
  const v = ch.v, runs = [];
  let cur = null;
  for (let i = 0; i < v.length - 1; i++) {
    const a = v[i], b = v[i + 1], len = b.S - a.S, m = Math.max(1, Math.ceil(len));
    const ra = miterRight(v, i), rb = miterRight(v, i + 1);
    for (let j = 0; j < m; j++) {
      const t = (j + 0.5) / m, s0 = a.S + len * j / m, s1 = a.S + len * (j + 1) / m;
      const o = { P: [a.P[0] + (b.P[0] - a.P[0]) * t, a.P[1] + (b.P[1] - a.P[1]) * t], k: a.k };
      const r = [ra[0] + (rb[0] - ra[0]) * t, ra[1] + (rb[1] - ra[1]) * t];
      const off = offAt(i) * (1 - t) + offAt(i + 1) * t, z = a.z + (b.z - a.z) * t + z0;
      const hid = covered(offsetPoint(o, r, off), z, ch, kind);
      if (!hid) { if (cur && Math.abs(cur[1] - s0) < 1e-6) cur[1] = s1; else { cur = [s0, s1]; runs.push(cur); } }
    }
  }
  return runs;
}

// 每條路要畫的線：標線、路況綠線、護欄
function features(ch, covered) {
  const v = ch.v, lines = [], rails = [];
  const line = (t, off, w, dash) => lines.push({ t, off, w, dash, vis: visibleRuns(ch, off, 0, 'mark', covered) });
  const isLink = v.some((o) => o.link);
  if (ch.oneway) {
    const maxLanes = v.reduce((m, o) => Math.max(m, o.lanes), 0);
    line('g2', (i) => (v[i].a + v[i].b) / 2, 1.9, 0);   // 路況綠線外框
    line('g', (i) => (v[i].a + v[i].b) / 2, 1.4, 0);    // 路況綠線
    line('y', (i) => v[i].a + 0.075, 0.15, 0);          // 內側路面邊線(黃實線)
    line('w', (i) => v[i].b - 0.075, 0.15, 0);          // 外側路面邊線(白實線)
    for (let k = 1; k < maxLanes; k++) {
      // 車道線(白虛線，線段 4 公尺、間距 6 公尺、線寬 10 公分)：縮減掉的車道那段不畫
      const L = { t: 'w', off: (i) => v[i].a + k * LANE, w: 0.10, dash: 1, vis: null };
      const vis = visibleRuns(ch, L.off, 0, 'mark', covered);
      L.vis = clipRuns(vis, (i) => v[i].a + k * LANE < v[i].b - 1, v);
      lines.push(L);
    }
    railRuns(ch, (i) => v[i].eR - 0.3, 1, covered, rails);
    if (isLink) railRuns(ch, (i) => v[i].eL + 0.3, -1, covered, rails);
    else medianRails(ch, covered, rails);
  } else {
    const per = (i) => Math.max(1, Math.floor(v[i].lanes / 2)) * LANE;
    line('y', () => 0.12, 0.12, 0); line('y', () => -0.12, 0.12, 0);   // 中央雙黃線
    line('w', (i) => per(i) - 0.075, 0.15, 0); line('w', (i) => -per(i) + 0.075, 0.15, 0);
    const maxPer = v.reduce((m, o) => Math.max(m, Math.max(1, Math.floor(o.lanes / 2))), 0);
    for (let k = 1; k < maxPer; k++) { line('w', () => k * LANE, 0.10, 1); line('w', () => -k * LANE, 0.10, 1); }
    railRuns(ch, (i) => v[i].eR - 0.3, 1, covered, rails);
    railRuns(ch, (i) => v[i].eL + 0.3, -1, covered, rails);
  }
  return { lines, rails };
}
// 外側護欄：橋上混凝土護欄(pp)、平地鋼板護欄(wb)，依每段是不是橋分開
function railRuns(ch, off, side, covered, out) {
  const v = ch.v, vis = visibleRuns(ch, off, 0.4, 'rail', covered);
  const onBridge = (i) => v[i].bridge;
  out.push({ t: 'wb', off, side, vis: clipRuns(vis, (i) => !onBridge(i), v) });
  out.push({ t: 'pp', off, side, vis: clipRuns(vis, (i) => onBridge(i), v) });
}
// 中央分隔：照分隔島寬度
//   窄(< 1.6 公尺，只塞得下一道)：正中間一道紐澤西護欄＋綠色防眩板，只由 id 小的那條畫(兩個方向不會各畫一道)
//   寬：兩邊各一道護欄(靠分隔島那側)，中間種灌木(id 小的那條畫)
//   沒有對向(上下行分很開)：自己左邊一道護欄
const NARROW = 1.6;
function medianRails(ch, covered, rails) {
  const v = ch.v;
  const narrow = (i) => v[i].medGap !== null && v[i].medGap < NARROW;
  const mine = (i) => v[i].pairId === null || ch.id < v[i].pairId;
  const center = (i) => v[i].eL - (v[i].medGap !== null ? v[i].medGap / 2 : 0);
  // 窄：正中間一道
  const visC = visibleRuns(ch, center, 0.4, 'rail', covered);
  const single = clipRuns(visC, (i) => narrow(i) && mine(i), v);
  rails.push({ t: 'nj', off: (i) => center(i) - 0.33, side: 1, vis: single });
  rails.push({ t: 'ag', off: center, side: 1, vis: single });   // 防眩板
  // 寬或沒有對向：自己這邊一道(往分隔島那側長)
  const visE = visibleRuns(ch, (i) => v[i].eL - 0.3, 0.4, 'rail', covered);
  rails.push({ t: 'nj', off: (i) => v[i].eL, side: -1, vis: clipRuns(visE, (i) => !narrow(i), v) });
  // 灌木：兩道護欄中間還有 0.3 公尺以上的空間才種
  const hedgeOK = (i) => v[i].medGap !== null && v[i].medGap >= NARROW + 0.3 && mine(i);
  rails.push({ t: 'hg', off: (i) => v[i].eL - 0.7, off2: (i) => v[i].eL - Math.max(1.0, (v[i].medGap || 0) - 0.7), side: -1, vis: clipRuns(visE, hedgeOK, v) });
}
function clipRuns(runs, ok, v) {
  const out = [];
  for (const r of runs) {
    let cur = null;
    for (let i = 0; i < v.length - 1; i++) {
      const s0 = Math.max(r[0], v[i].S), s1 = Math.min(r[1], v[i + 1].S);
      if (s1 <= s0) continue;
      if (ok(i) && ok(i + 1)) { if (cur && Math.abs(cur[1] - s0) < 1e-6) cur[1] = s1; else { cur = [s0, s1]; out.push(cur); } }
      else cur = null;
    }
  }
  return out;
}

// ── 8. 槽化線 ──
// 匝道的頭 / 尾接在主線上：沿匝道往外取樣，投影到主線，主線外側車道線到匝道內側車道線之間有空隙的那段就是槽化區
function gores(chains) {
  const byNode = new Map();
  chains.forEach((ch) => ch.v.forEach((o, i) => { if (o.node != null) { if (!byNode.has(o.node)) byNode.set(o.node, []); byNode.get(o.node).push({ ch, i }); } }));
  const out = [];   // 每個：{ ch(主線), quads: [[P,z]×4], lines }
  for (const ch of chains) {
    if (!ch.oneway || !ch.v.some((o) => o.link)) continue;
    const v = ch.v;
    for (const atStart of [true, false]) {
      const end = atStart ? 0 : v.length - 1;
      const main = (byNode.get(v[end].node) || []).find((o) => o.ch !== ch && o.ch.oneway && !o.ch.v.some((x) => x.link));
      if (!main) continue;
      const g = goreOf(ch, atStart, main.ch, main.i);
      if (g) out.push(g);
    }
  }
  return out;
}
function goreOf(link, atStart, main, mi) {
  const lv = link.v, mv = main.v;
  const proj = (p) => {   // 投影到主線(接點前後 150 個點內找)
    let best = null;
    for (let i = Math.max(0, mi - 150); i < Math.min(mv.length - 1, mi + 150); i++) {
      const A = mv[i].P, B = mv[i + 1].P, dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
      if (!L2) continue;
      const t = Math.max(0, Math.min(1, ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2));
      const qx = A[0] + dx * t, qy = A[1] + dy * t, d = Math.hypot(p[0] - qx, p[1] - qy);
      if (!best || d < best.d) {
        const L = Math.sqrt(L2);
        best = { d, i, t, lat: ((p[0] - qx) * dy / L - (p[1] - qy) * dx / L) * mv[i].k };
      }
    }
    return best;
  };
  const samples = [];
  const order = atStart ? lv.map((_, i) => i) : lv.map((_, i) => lv.length - 1 - i);
  for (const i of order) {
    const u = atStart ? lv[i].S : link.L - lv[i].S;
    if (u > 300) break;
    const pr = proj(lv[i].P);
    if (!pr || (pr.t === 0 && pr.i === 0) || pr.d * mv[pr.i].k > 60) break;
    samples.push({ u, li: i, pr });
  }
  if (samples.length < 5) return null;
  const probe = samples[Math.min(samples.length - 1, 8)], sg = probe.pr.lat >= 0 ? 1 : -1;
  const pts = [];
  let started = false;
  for (const s of samples) {
    const mo = mv[s.pr.i], lo = lv[s.li];
    const edgeM = sg > 0 ? mo.b : mo.a, edgeL = sg > 0 ? lo.a : lo.b;
    const gap = sg * (s.pr.lat + edgeL - edgeM);
    if (gap > 0.15) { started = true; pts.push({ i: s.pr.i, t: s.pr.t, gap, edgeM }); }
    else if (started) break;
    if (gap > 8) break;
  }
  if (pts.length < 3) return null;
  return { main, sg, pts };
}

// 槽化線的幾何：外框(匝道那一側的白實線)＋斜紋，回傳四邊形 [[X, Y, z] × 4]
function goreQuads(g) {
  const mv = g.main.v, out = [], y = 0.075;
  const at = (i, t, off) => {   // 主線第 i 段、比例 t、橫向偏移 off 的點
    const a = mv[i], b = mv[Math.min(mv.length - 1, i + 1)];
    const ra = miterRight(mv, i), rb = miterRight(mv, Math.min(mv.length - 1, i + 1));
    const P = [a.P[0] + (b.P[0] - a.P[0]) * t, a.P[1] + (b.P[1] - a.P[1]) * t], k = a.k;
    const r = [ra[0] + (rb[0] - ra[0]) * t, ra[1] + (rb[1] - ra[1]) * t], m = off / k;
    return [P[0] + r[0] * m, P[1] + r[1] * m, a.z + (b.z - a.z) * t + y];
  };
  const pts = g.pts.slice().sort((p, q) => (p.i + p.t) - (q.i + q.t));
  const sOf = (p) => mv[p.i].S + (mv[Math.min(mv.length - 1, p.i + 1)].S - mv[p.i].S) * p.t;
  pts.forEach((p) => { p.s = sOf(p); });
  const lw = 0.15;
  for (let j = 0; j < pts.length - 1; j++) {
    const p = pts[j], q = pts[j + 1], o0 = p.edgeM + g.sg * p.gap, o1 = q.edgeM + g.sg * q.gap;
    out.push([at(p.i, p.t, o0 - lw / 2), at(p.i, p.t, o0 + lw / 2), at(q.i, q.t, o1 + lw / 2), at(q.i, q.t, o1 - lw / 2)]);
  }
  // 斜紋：每 4 公尺一條，從主線外側車道線斜向匝道邊線，往缺口變寬的方向斜
  const widen = pts[pts.length - 1].gap >= pts[0].gap ? 1 : -1;
  const atS = (s) => {   // 沿主線距離 s → {i, t, gap, edgeM}
    for (let j = 0; j < pts.length - 1; j++) if (s <= pts[j + 1].s) {
      const p = pts[j], q = pts[j + 1], t = (s - p.s) / ((q.s - p.s) || 1);
      let i = p.i; while (i < mv.length - 2 && mv[i + 1].S < s) i++;
      return { i, t: Math.max(0, Math.min(1, (s - mv[i].S) / ((mv[i + 1].S - mv[i].S) || 1))), gap: p.gap + (q.gap - p.gap) * t, edgeM: p.edgeM + (q.edgeM - p.edgeM) * t };
    }
    return null;
  };
  const s0 = pts[0].s, s1 = pts[pts.length - 1].s, sw = 0.3;
  for (let s = s0 + 2; s < s1; s += 4) {
    const A = atS(s);
    if (!A || A.gap < 0.8) continue;
    const B = atS(Math.max(s0, Math.min(s1, s + widen * A.gap * 0.8)));
    if (!B) continue;
    const A2 = atS(Math.min(s1, s + sw)), B2 = atS(Math.max(s0, Math.min(s1, s + widen * A.gap * 0.8 + sw)));
    if (!A2 || !B2) continue;
    const g1 = Math.min(A.gap, B.gap);
    out.push([at(A.i, A.t, A.edgeM + g.sg * 0.1), at(A2.i, A2.t, A2.edgeM + g.sg * 0.1), at(B2.i, B2.t, B2.edgeM + g.sg * (g1 - 0.1)), at(B.i, B.t, B.edgeM + g.sg * (g1 - 0.1))]);
  }
  return out;
}

// 減少點數：拿掉後形狀(位置、高度、路寬)誤差都在 tol 公尺內的點就不存(直路上 3 公尺一點太多)
// 回傳要留下的原始索引
function simplifyIdx(ch, tol) {
  const v = ch.v, n = v.length, keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const val = (o) => [o.P[0] * o.k, o.P[1] * o.k, o.z, o.eL, o.a, o.b, o.eR];
  const vals = v.map(val);
  const err = (i, a, b) => {
    const t = (v[i].S - v[a].S) / ((v[b].S - v[a].S) || 1), A = vals[a], B = vals[b], X = vals[i];
    let e = Math.hypot(A[0] + (B[0] - A[0]) * t - X[0], A[1] + (B[1] - A[1]) * t - X[1]);
    for (let c = 2; c < 7; c++) e = Math.max(e, Math.abs(A[c] + (B[c] - A[c]) * t - X[c]));
    return e;
  };
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) { const e = err(i, a, b); if (e > worst) { worst = e; wi = i; } }
    if (worst > tol || v[b].S - v[a].S > 200) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }   // 最長 200 公尺一點
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

module.exports = {
  simplifyIdx,
  goreQuads,
  LANE, MEDIAN_MIN, MEDIAN_MAX, LAYER_H,
  merc, unmerc, cosAtY, parseWays, buildChains, smoothChain, prepChain, updateFrames, heights, sections, medians,
  miterRight, offsetPoint, makeCover, visibleRuns, features, gores, windowAvg, dilate, marksYield, rightOf,
};
