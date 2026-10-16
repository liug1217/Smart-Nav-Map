// 第 2 版 3D 道路引擎：幾何基礎
//   座標：Web Mercator 公尺(X 往東、Y 往北)；地面距離 = Mercator 距離 × k，k = cos(緯度)
//   取點：向心 Catmull-Rom 曲線，先用 0.25 公尺密集取樣建弧長表，再依真正的弧長取點(每段原始線段內等弧長，約 2 公尺一點；
//         原始節點一定是取樣點，交流道接點位置不會跑掉)
//   方向：切線用曲線本身(密集取樣的前後點)，法向量 = 切線 × 朝上向量(永遠水平，S 彎不會翻面)
'use strict';

const R_EARTH = 6378137, D2R = Math.PI / 180;
const STEP = 2;          // 取點間距(公尺)
const DENSE = 0.25;      // 弧長表密度(公尺)

function merc(lon, lat) { return [R_EARTH * lon * D2R, R_EARTH * Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2))]; }
function unmerc(X, Y) { return [X / R_EARTH / D2R, (2 * Math.atan(Math.exp(Y / R_EARTH)) - Math.PI / 2) / D2R]; }
function kAtY(Y) { return Math.cos(2 * Math.atan(Math.exp(Y / R_EARTH)) - Math.PI / 2); }

// 向心 Catmull-Rom：p0..p3，t ∈ [0, 1] 在 p1→p2 之間
function crPoint(p0, p1, p2, p3, u) {
  const d = (a, b) => Math.max(1e-6, Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5));
  const t0 = 0, t1 = d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3), t = t1 + (t2 - t1) * u;
  const q = [0, 0];
  for (let c = 0; c < 2; c++) {
    const A1 = (t1 - t) / (t1 - t0) * p0[c] + (t - t0) / (t1 - t0) * p1[c];
    const A2 = (t2 - t) / (t2 - t1) * p1[c] + (t - t1) / (t2 - t1) * p2[c];
    const A3 = (t3 - t) / (t3 - t2) * p2[c] + (t - t2) / (t3 - t2) * p3[c];
    const B1 = (t2 - t) / (t2 - t0) * A1 + (t - t0) / (t2 - t0) * A2;
    const B2 = (t3 - t) / (t3 - t1) * A2 + (t - t1) / (t3 - t1) * A3;
    q[c] = (t2 - t) / (t2 - t1) * B1 + (t - t1) / (t2 - t1) * B2;
  }
  return q;
}

// 一串 Mercator 點 → 等弧長取點
// 回傳 { P: [[x, y]], T: [[tx, ty]](單位切線), S: [地面弧長], seg: [來自第幾段原始線段], nodeAt: [原始第 i 點在取樣的索引] }
function resample(pts) {
  const n = pts.length;
  const ghost = (i) => (i < 0 ? [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]]
    : i >= n ? [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]] : pts[i]);
  const P = [], T = [], S = [], seg = [], nodeAt = [0];
  let sAcc = 0;
  for (let i = 0; i < n - 1; i++) {
    const p0 = ghost(i - 1), p1 = pts[i], p2 = pts[i + 1], p3 = ghost(i + 2);
    const k = kAtY((p1[1] + p2[1]) / 2);
    // 這段曲線的弧長表
    const chordG = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) * k;
    const m = Math.max(4, Math.ceil(chordG / DENSE));
    const dense = [p1], ds = [0];
    for (let j = 1; j <= m; j++) {
      const q = j === m ? p2 : crPoint(p0, p1, p2, p3, j / m);
      const prev = dense[j - 1];
      ds.push(ds[j - 1] + Math.hypot(q[0] - prev[0], q[1] - prev[1]) * k);
      dense.push(q);
    }
    const L = ds[m];
    const cnt = Math.max(1, Math.round(L / STEP));
    // 切線：密集表中前後點(接點用前後兩段的平均，讓節點處切線連續)
    const tanAt = (j) => {
      const a = dense[Math.max(0, j - 1)], b = dense[Math.min(m, j + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      return [dx / l, dy / l];
    };
    let jj = 0;
    for (let c = (i === 0 ? 0 : 1); c <= cnt; c++) {
      const target = L * c / cnt;
      while (jj < m - 1 && ds[jj + 1] < target) jj++;
      const f = (target - ds[jj]) / ((ds[jj + 1] - ds[jj]) || 1);
      const a = dense[jj], b = dense[jj + 1];
      const q = c === cnt ? p2 : [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      const ta = tanAt(jj), tb = tanAt(jj + 1);
      let tx = ta[0] + (tb[0] - ta[0]) * f, ty = ta[1] + (tb[1] - ta[1]) * f;
      const tl = Math.hypot(tx, ty) || 1;
      P.push(q); T.push([tx / tl, ty / tl]); S.push(sAcc + target); seg.push(i);
    }
    sAcc += L;
    nodeAt.push(P.length - 1);
  }
  // 節點處切線：前後兩段的切線平均(兩段在節點的切線可能有一點點不同)
  for (let i = 1; i < n - 1; i++) {
    const j = nodeAt[i];
    if (j <= 0 || j >= P.length - 1) continue;
    const a = [P[j][0] - P[j - 1][0], P[j][1] - P[j - 1][1]], b = [P[j + 1][0] - P[j][0], P[j + 1][1] - P[j][1]];
    const la = Math.hypot(a[0], a[1]) || 1, lb = Math.hypot(b[0], b[1]) || 1;
    const tx = a[0] / la + b[0] / lb, ty = a[1] / la + b[1] / lb, l = Math.hypot(tx, ty) || 1;
    T[j] = [tx / l, ty / l];
  }
  return { P, T, S, seg, nodeAt };
}

// 法向量(右手、水平)：切線 × 朝上向量；Mercator Y 往北，所以 (tx, ty) 的右邊是 (ty, -tx)
const normalOf = (t) => [t[1], -t[0]];

// 重新算弧長、切線(位置被移動過之後；切線用前後點)
function refresh(g) {
  const P = g.P, n = P.length;
  g.S = [0];
  for (let i = 1; i < n; i++) {
    const k = kAtY((P[i][1] + P[i - 1][1]) / 2);
    g.S.push(g.S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]) * k);
  }
  g.T = P.map((_, i) => {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  });
  return g;
}

// 曲率半徑(地面公尺)：用前後各 span 公尺的三點
// (Catmull-Rom 在原始節點附近曲率稍大，估出來的半徑會偏小一點，檢查只會變嚴格、不會漏掉)
function radii(g, span) {
  const P = g.P, S = g.S, n = P.length, out = new Array(n).fill(Infinity);
  let lo = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    while (lo < i && S[i] - S[lo + 1] >= span) lo++;
    while (hi < n - 1 && S[hi] - S[i] < span) hi++;
    if (lo === i || hi === i) continue;
    const a = P[lo], b = P[i], c = P[hi], k = kAtY(b[1]);
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]) * k, bc = Math.hypot(c[0] - b[0], c[1] - b[1]) * k, ca = Math.hypot(a[0] - c[0], a[1] - c[1]) * k;
    const area2 = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * k * k;
    out[i] = area2 < 1e-9 ? Infinity : (ab * bc * ca) / (2 * area2);
  }
  return out;
}

// 曲率檢查：半徑 < 1.2 × 最大偏移量的地方，局部平滑中心線(固定的點不動)，直到通過或次數用完
// need(i) = 第 i 點需要的最大偏移量；fixed(i) = 這點不能動(交流道接點)
// 回傳 { ok, passes, worst }
function relaxCurvature(g, need, fixed, maxPass = 60) {
  const n = g.P.length;
  let passes = 0, bad = [];
  const check = () => {
    const R = radii(g, 10);
    bad = [];
    for (let i = 1; i < n - 1; i++) if (R[i] < 1.2 * need(i)) bad.push(i);
    return R;
  };
  check();
  while (bad.length && passes < maxPass) {
    passes++;
    // 有問題的點前後 20 公尺內做一次拉普拉斯平滑(往前後點的中點靠一半)
    const mark = new Uint8Array(n);
    for (const i of bad) {
      let a = i, b = i;
      while (a > 1 && g.S[i] - g.S[a] < 20) a--;
      while (b < n - 2 && g.S[b] - g.S[i] < 20) b++;
      for (let j = a; j <= b; j++) mark[j] = 1;
    }
    const P = g.P.map((p) => p.slice());
    for (let j = 1; j < n - 1; j++) {
      if (!mark[j] || fixed(j)) continue;
      const mx = (g.P[j - 1][0] + g.P[j + 1][0]) / 2, my = (g.P[j - 1][1] + g.P[j + 1][1]) / 2;
      P[j] = [g.P[j][0] + (mx - g.P[j][0]) * 0.5, g.P[j][1] + (my - g.P[j][1]) * 0.5];
    }
    g.P = P;
    refresh(g);
    check();
  }
  const R = radii(g, 10);
  let worst = Infinity;
  for (let i = 1; i < n - 1; i++) worst = Math.min(worst, R[i] / Math.max(1e-6, need(i)));
  return { ok: bad.length === 0, passes, worst };
}

// 每點的折角(轉彎量跟前後點平均差多少，換算成每 2 公尺幾度)：曲率改變不算，突然折一下才算
function kinks(g) {
  const P = g.P, n = P.length, out = new Array(n).fill(0);
  if (n < 5) return out;
  const head = [], len = [];
  for (let i = 0; i < n - 1; i++) { head.push(Math.atan2(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1])); len.push(g.S[i + 1] - g.S[i]); }
  const curv = [0];
  for (let i = 1; i < n - 1; i++) {
    let d = head[i] - head[i - 1]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    curv.push(d / Math.max(0.2, (len[i - 1] + len[i]) / 2));
  }
  curv.push(0);
  for (let i = 2; i < n - 2; i++) out[i] = Math.abs(curv[i] - (curv[i - 1] + curv[i + 1]) / 2) * 2 * 180 / Math.PI;
  return out;
}
// 曲率平順化：只處理有折角(≥ limit)的那幾小段(前後 6 公尺)，每段自己反覆拉普拉斯平滑，不用每一輪重算整條路
// 固定點(交流道接點)不動；最後重算一次弧長、切線
function relaxKinks(g, fixed, limit = 0.4, maxPass = 80) {
  const n = g.P.length;
  if (n < 7) return { ok: true, passes: 0, worst: 0 };
  const K0 = kinks(g);
  // 有問題的區段(合併相鄰的)
  const regions = [];
  for (let i = 2; i < n - 2; i++) {
    if (K0[i] < limit) continue;
    let a = i, b = i;
    while (a > 1 && g.S[i] - g.S[a] < 6) a--;
    while (b < n - 2 && g.S[b] - g.S[i] < 6) b++;
    const last = regions[regions.length - 1];
    if (last && a <= last[1] + 2) last[1] = Math.max(last[1], b); else regions.push([a, b]);
  }
  if (!regions.length) return { ok: true, passes: 0, worst: 0 };
  // 局部折角(只看 a-2 ～ b+2)
  const localKink = (a, b) => {
    const lo = Math.max(1, a - 2), hi = Math.min(n - 2, b + 2), curv = {};
    for (let i = lo; i <= hi; i++) {
      const p0 = g.P[i - 1], p1 = g.P[i], p2 = g.P[i + 1];
      const h1 = Math.atan2(p1[0] - p0[0], p1[1] - p0[1]), h2 = Math.atan2(p2[0] - p1[0], p2[1] - p1[1]);
      let d = h2 - h1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      const k = kAtY(p1[1]), len = (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1])) * k / 2;
      curv[i] = d / Math.max(0.2, len);
    }
    let worst = 0;
    for (let i = lo + 1; i < hi; i++) worst = Math.max(worst, Math.abs(curv[i] - (curv[i - 1] + curv[i + 1]) / 2) * 2 * 180 / Math.PI);
    return worst;
  };
  let passes = 0, worstAll = 0;
  for (const [a, b] of regions) {
    let w = localKink(a, b), p = 0;
    for (; p < maxPass && w >= limit; p++) {
      const P = g.P.slice(a, b + 1).map((q) => q.slice());
      for (let j = a; j <= b; j++) {
        if (fixed(j) || j <= 0 || j >= n - 1) continue;
        P[j - a] = [g.P[j][0] + ((g.P[j - 1][0] + g.P[j + 1][0]) / 2 - g.P[j][0]) * 0.5, g.P[j][1] + ((g.P[j - 1][1] + g.P[j + 1][1]) / 2 - g.P[j][1]) * 0.5];
      }
      for (let j = a; j <= b; j++) g.P[j] = P[j - a];
      w = localKink(a, b);
    }
    passes = Math.max(passes, p); worstAll = Math.max(worstAll, w);
  }
  refresh(g);
  return { ok: worstAll < 0.5, passes, worst: worstAll };
}

// 沿路 ±r 公尺的中位數(只算有值的點)
function rollingMedian(S, vals, r) {
  const n = S.length, out = new Array(n).fill(null);
  let lo = 0, hi = -1;
  for (let i = 0; i < n; i++) {
    while (hi + 1 < n && S[hi + 1] <= S[i] + r) hi++;
    while (S[lo] < S[i] - r) lo++;
    const w = [];
    for (let j = lo; j <= hi; j++) if (vals[j] !== null) w.push(vals[j]);
    if (!w.length) continue;
    w.sort((a, b) => a - b);
    out[i] = w.length % 2 ? w[(w.length - 1) / 2] : (w[w.length / 2 - 1] + w[w.length / 2]) / 2;
  }
  return out;
}
const smoothstep = (t) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };

// 點投影到折線(地面公尺)：回傳 { i(段), t, s, lat(右正), dist }
function project(g, p, i0 = 0, i1 = g.P.length - 1) {
  let best = null;
  for (let i = Math.max(0, i0); i < Math.min(g.P.length - 1, i1); i++) {
    const A = g.P[i], B = g.P[i + 1], dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
    if (!L2) continue;
    const t = Math.max(0, Math.min(1, ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2));
    const qx = A[0] + dx * t, qy = A[1] + dy * t, k = kAtY(qy), d = Math.hypot(p[0] - qx, p[1] - qy) * k;
    if (!best || d < best.dist) {
      const L = Math.sqrt(L2);
      best = { i, t, s: g.S[i] + (g.S[i + 1] - g.S[i]) * t, lat: ((p[0] - qx) * dy / L - (p[1] - qy) * dx / L) * k, dist: d,
        endT: (i === 0 && t === 0) || (i === g.P.length - 2 && t === 1) };
    }
  }
  return best;
}
// 沿線距離 s 的點、切線
function pointAt(g, s) {
  const S = g.S, n = S.length;
  let lo = 0, hi = n - 1;
  if (s <= 0) return { p: g.P[0].slice(), t: g.T[0], i: 0, f: 0 };
  if (s >= S[n - 1]) return { p: g.P[n - 1].slice(), t: g.T[n - 1], i: n - 2, f: 1 };
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
  const f = (s - S[lo]) / ((S[hi] - S[lo]) || 1), a = g.P[lo], b = g.P[hi], ta = g.T[lo], tb = g.T[hi];
  let tx = ta[0] + (tb[0] - ta[0]) * f, ty = ta[1] + (tb[1] - ta[1]) * f; const l = Math.hypot(tx, ty) || 1;
  return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], t: [tx / l, ty / l], i: lo, f };
}

module.exports = { kinks, relaxKinks, R_EARTH, STEP, merc, unmerc, kAtY, crPoint, resample, normalOf, refresh, radii, relaxCurvature, rollingMedian, smoothstep, project, pointAt };
