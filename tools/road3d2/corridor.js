// 第 2 版 3D 道路引擎：橫斷面與中央分隔島
//
// 橫斷面(sections)：車道 3.75 公尺、內側路肩 1、外側路肩 3(匝道 2)；雙向道路兩邊各 1.5。路面置中在中心線上。
//   車道數變多 / 變少：90 公尺漸變一個車道(往前往後各掃一次取最小)
//   每點：eL / eR 路面左右緣，a / b 最左 / 最右車道外緣(相對中心線，往右為正，地面公尺)
//
// 中央分隔島(corridors)：上、下行合成一條「共用的走廊中心線」，兩個方向都從這條線往外推
//   1. 配對：每點找對向(方向相反、在左邊、40 公尺內、高度差 1.5 公尺內)最近的主線，同一條對向連續 100 公尺以上算一段
//   2. 走廊中心線 = 兩條線對應點的中點，等弧長取點後平滑(去掉原始資料的抖動)
//   3. 分隔島寬度：沿走廊量兩邊路面內緣距離 → 前後 200 公尺中位數(單一個歪掉的點不影響) → 限制 1～3 公尺 →
//      分段：穩定段用該段的中位數(固定不動)；寬度改變超過 0.5 公尺的地方抓起點、終點，用 smoothstep 在 150～300 公尺內過渡
//   4. 曲率檢查：走廊中心線半徑 < 1.2 × (分隔島一半 + 較寬那邊的路寬) 的地方先平滑走廊
//   5. 兩個方向的新位置 = 走廊點 ± 法向量 × (分隔島寬 / 2 + 自己路寬 / 2)；配對段頭尾 150～300 公尺用 smoothstep 從原本位置過渡過來
'use strict';

const G = require('./geom');

const LANE = 3.75, TAPER = LANE / 90;
const MEDIAN_MIN = 1.0, MEDIAN_MAX = 3.0;
const PAIR_DIST = 40, MIN_RUN = 100, CHANGE = 0.5;

function sections(ch) {
  const n = ch.g.P.length, S = ch.g.S;
  ch.eL = new Array(n); ch.eR = new Array(n); ch.a = new Array(n); ch.b = new Array(n);
  if (!ch.oneway) {
    for (let i = 0; i < n; i++) { const W = ch.attr[i].lanes * LANE + 3; ch.eL[i] = -W / 2; ch.eR[i] = W / 2; ch.a[i] = -W / 2 + 1.5; ch.b[i] = W / 2 - 1.5; }
    return;
  }
  const bt = ch.attr.map((w) => w.lanes * LANE);
  for (let i = 1; i < n; i++) bt[i] = Math.min(bt[i], bt[i - 1] + TAPER * (S[i] - S[i - 1]));
  for (let i = n - 2; i >= 0; i--) bt[i] = Math.min(bt[i], bt[i + 1] + TAPER * (S[i + 1] - S[i]));
  for (let i = 0; i < n; i++) {
    const inner = 1.0, outer = ch.attr[i].link ? 2.0 : 3.0, W = bt[i] + inner + outer;
    ch.eL[i] = -W / 2; ch.a[i] = ch.eL[i] + inner; ch.b[i] = ch.a[i] + bt[i]; ch.eR[i] = W / 2;
  }
}
const halfW = (ch, i) => (ch.eR[i] - ch.eL[i]) / 2;

// 主線線段格子
function segGrid(mains, CELL) {
  const grid = new Map();
  for (const ch of mains) {
    const P = ch.g.P;
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      if (L < 1e-9) continue;
      const g = { ch, i, a, d: [dx / L, dy / L], L };
      const x0 = Math.floor(Math.min(a[0], b[0]) / CELL), x1 = Math.floor(Math.max(a[0], b[0]) / CELL);
      const y0 = Math.floor(Math.min(a[1], b[1]) / CELL), y1 = Math.floor(Math.max(a[1], b[1]) / CELL);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = x * 100003 + y; let arr = grid.get(key); if (!arr) { arr = []; grid.set(key, arr); } arr.push(g);
      }
    }
  }
  return grid;
}

// 每點的對向：{ ch, Q(對向上的投影點), dist } 或 null
function partners(ch, grid, CELL) {
  const P = ch.g.P, T = ch.g.T, out = new Array(P.length).fill(null);
  for (let i = 0; i < P.length; i++) {
    const p = P[i], t = T[i], rgt = G.normalOf(t), k = G.kAtY(p[1]);
    const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
    let best = null;
    for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
      for (const g of grid.get(x * 100003 + y) || []) {
        if (g.ch === ch || g.d[0] * t[0] + g.d[1] * t[1] > -0.85) continue;
        const u = (p[0] - g.a[0]) * g.d[0] + (p[1] - g.a[1]) * g.d[1];
        if (u < -0.01 || u > g.L + 0.01) continue;
        const qx = g.a[0] + g.d[0] * u, qy = g.a[1] + g.d[1] * u;
        const lat = ((qx - p[0]) * rgt[0] + (qy - p[1]) * rgt[1]) * k;
        if (lat >= 0) continue;
        const dist = -lat;
        if (dist > PAIR_DIST || (best && dist >= best.dist)) continue;
        const f = u / g.L, oz = g.ch.z[g.i] + (g.ch.z[g.i + 1] - g.ch.z[g.i]) * f;
        if (Math.abs(oz - ch.z[i]) > 1.5) continue;
        best = { ch: g.ch, Q: [qx, qy], dist, oi: g.i, of: f };
      }
    }
    out[i] = best;
  }
  return out;
}

// 分隔島寬度：中位數濾波 → 限制範圍 → 分段(穩定段固定、變化段 smoothstep)
//   每 100 公尺一塊取中位數；連續 3 塊(300 公尺)都跟目前寬度差 0.5 公尺以上才算「真的變了」，
//   比這短的起伏(原始資料抖動)一律當雜訊，寬度不動
function segmentGap(S, raw) {
  const n = S.length;
  const f = G.rollingMedian(S, raw, 100).map((x) => (x === null ? null : Math.max(MEDIAN_MIN, Math.min(MEDIAN_MAX, x))));
  const med = (arr) => { const w = arr.filter((x) => x !== null).sort((a, b) => a - b); return w.length ? w[Math.floor(w.length / 2)] : null; };
  const BLOCK = 100, L = S[n - 1], nb = Math.max(1, Math.ceil(L / BLOCK)), blocks = [];
  for (let b = 0; b < nb; b++) blocks.push([]);
  for (let i = 0; i < n; i++) blocks[Math.min(nb - 1, Math.floor(S[i] / BLOCK))].push(f[i]);
  const bv = blocks.map(med);
  for (let b = 1; b < nb; b++) if (bv[b] === null) bv[b] = bv[b - 1];
  for (let b = nb - 2; b >= 0; b--) if (bv[b] === null) bv[b] = bv[b + 1];
  if (bv[0] === null) return S.map(() => MEDIAN_MIN);
  const changes = [];
  let plateau = med(bv.slice(0, 3)), b = 0;
  while (b < nb) {
    const run = bv.slice(b, b + 3);
    if (run.length === 3 && run.every((x) => Math.abs(x - plateau) > CHANGE) && run.every((x) => Math.sign(x - plateau) === Math.sign(run[0] - plateau))) {
      const to = med(run), d = Math.abs(to - plateau), Lt = Math.max(150, Math.min(300, d * 100)), mid = b * BLOCK;
      changes.push({ s0: mid - Lt / 2, s1: mid + Lt / 2, from: plateau, to });
      plateau = to; b += 3;
    } else b++;
  }
  const first = med(bv.slice(0, 3));
  return S.map((s) => {
    let v = first;
    for (const c of changes) {
      if (s >= c.s1) v = c.to;
      else if (s > c.s0) { v = c.from + (c.to - c.from) * G.smoothstep((s - c.s0) / (c.s1 - c.s0)); break; }
      else break;
    }
    return v;
  });
}

// 沿線順序投影：從上一點的位置附近找(前後 40 個線段內)，找不到再整條找；整段只要 O(n)
function nearProjector(g) {
  let hint = null;
  return function (p) {
    let r = null;
    if (hint !== null) r = G.project(g, p, hint - 40, hint + 40);
    if (!r || (r.endT && r.i !== 0 && r.i !== g.P.length - 2) || r.dist > 60) r = G.project(g, p);
    hint = r ? r.i : hint;
    return r;
  };
}

function corridors(chains) {
  const mains = chains.filter((ch) => ch.oneway && !ch.link);
  const CELL = 100, grid = segGrid(mains, CELL);
  const part = new Map();
  for (const ch of mains) part.set(ch, partners(ch, grid, CELL));
  const runs = [];
  const moves = new Map();   // ch → [{ i, T, w }]
  for (const A of mains) {
    const pa = part.get(A), S = A.g.S;
    let i = 0;
    while (i < pa.length) {
      if (!pa[i]) { i++; continue; }
      const B = pa[i].ch; let j = i;
      for (;;) {
        while (j + 1 < pa.length && pa[j + 1] && pa[j + 1].ch === B) j++;
        // 中間短暫配不到(80 公尺內)又接回同一條對向：當成同一段(不然兩段之間會被拉回原位又推出去，變成折角)
        let k = j + 1;
        while (k < pa.length && S[k] - S[j] < 80 && !(pa[k] && pa[k].ch === B)) k++;
        if (k < pa.length && S[k] - S[j] < 80 && pa[k] && pa[k].ch === B && k > j + 1) { j = k; continue; }
        break;
      }
      if (A.id < B.id && S[j] - S[i] >= MIN_RUN) runs.push(buildCorridor(A, B, i, j, pa, moves));
      i = j + 1;
    }
  }
  // 全部算完再移(算的時候都用原本的位置)
  for (const [ch, list] of moves) {
    ch.medGap = ch.medGap || new Array(ch.g.P.length).fill(null);
    ch.pairId = ch.pairId || new Array(ch.g.P.length).fill(null);
    // 同一點被好幾段影響：只用權重最大的那段
    const best = new Map();
    for (const m of list) if (!best.has(m.i) || m.w > best.get(m.i).w) best.set(m.i, m);
    for (const m of best.values()) {
      const p = ch.g.P[m.i];
      ch.g.P[m.i] = [p[0] + (m.T[0] - p[0]) * m.w, p[1] + (m.T[1] - p[1]) * m.w];
      if (m.w > 0.999) { ch.medGap[m.i] = m.gap; ch.pairId[m.i] = m.pair; }
    }
    G.refresh(ch.g);
  }
  for (const ch of chains) {
    if (!ch.medGap) ch.medGap = new Array(ch.g.P.length).fill(null);
    if (!ch.pairId) ch.pairId = new Array(ch.g.P.length).fill(null);
  }
  // 走廊頭尾過渡的地方再把曲率拉順一次；已經對齊走廊的點(分隔島寬度要準)、交流道接點都不動
  const shared = new Map();
  for (const ch of chains) ch.node.forEach((id) => { if (id != null) shared.set(id, (shared.get(id) || 0) + 1); });
  for (const ch of moves.keys()) {
    const last = ch.g.P.length - 1;
    G.relaxKinks(ch.g, (i) => i === 0 || i === last || ch.medGap[i] !== null || (ch.node[i] != null && shared.get(ch.node[i]) > 1));
  }
  return runs.filter(Boolean);
}

function buildCorridor(A, B, i0, i1, pa, moves) {
  // 走廊中心線：對應點的中點 → 等弧長取點 → 平滑(前後 15 公尺平均)
  const mids = [];
  for (let i = i0; i <= i1; i++) if (pa[i] && pa[i].ch === B) mids.push([(A.g.P[i][0] + pa[i].Q[0]) / 2, (A.g.P[i][1] + pa[i].Q[1]) / 2]);
  if (mids.length < 3) return null;
  const C = G.resample(mids);
  smoothLine(C, 15);
  const n = C.P.length;
  // 量分隔島寬度
  const raw = new Array(n).fill(null), prA = nearProjector(A.g), prB = nearProjector(B.g);
  for (let j = 0; j < n; j++) {
    const pA = prA(C.P[j]), pB = prB(C.P[j]);
    if (!pA || !pB || pA.dist > PAIR_DIST || pB.dist > PAIR_DIST) continue;
    raw[j] = pA.dist + pB.dist - halfW(A, Math.min(A.g.P.length - 1, pA.i)) - halfW(B, Math.min(B.g.P.length - 1, pB.i));
  }
  const gap = segmentGap(C.S, raw);
  // 曲率：走廊中心線到最外側路緣 = 分隔島一半 + 較寬那邊的路寬
  const wMax = Math.max(halfW(A, i0) * 2, halfW(A, i1) * 2, 15);
  const curv = G.relaxCurvature(C, (j) => gap[j] / 2 + wMax, (j) => j === 0 || j === n - 1, 80);
  G.relaxKinks(C, (j) => j === 0 || j === n - 1);   // 走廊中心線的曲率也要平順(兩個方向都照它推，有折角會一起折)
  const Lc = C.S[n - 1], Lb = Math.min(Lc / 2, Math.max(150, Math.min(300, Lc / 4)));
  const gapAt = (s) => { const q = G.pointAt(C, s); return gap[q.i] + (gap[Math.min(n - 1, q.i + 1)] - gap[q.i]) * q.f; };
  // 兩條路的新位置
  const apply = (X, sign, lo, hi) => {
    const list = moves.get(X) || []; moves.set(X, list);
    const prC = nearProjector(C);
    for (let i = Math.max(0, lo); i <= Math.min(X.g.P.length - 1, hi); i++) {
      const pr = prC(X.g.P[i]);
      if (!pr || pr.endT || pr.dist > 45) continue;
      const q = G.pointAt(C, pr.s), nrm = G.normalOf(q.t), k = G.kAtY(q.p[1]), gp = gapAt(pr.s);
      const off = sign * (gp / 2 + halfW(X, i));
      const T = [q.p[0] + nrm[0] * off / k, q.p[1] + nrm[1] * off / k];
      const w = G.smoothstep(Math.min(pr.s, Lc - pr.s) / Lb);
      list.push({ i, T, w, gap: gp, pair: X === A ? B.id : A.id });
    }
  };
  apply(A, +1, i0, i1);
  // B 的範圍：對應點附近
  let bLo = Infinity, bHi = -Infinity; for (let i = i0; i <= i1; i++) if (pa[i] && pa[i].ch === B) { bLo = Math.min(bLo, pa[i].oi); bHi = Math.max(bHi, pa[i].oi); }
  apply(B, -1, bLo - 2, bHi + 2);
  return { A, B, C, gap, curv, Lc };
}

// 折線平滑：每點換成前後 r 公尺內的平均(頭尾不動)，之後重新等弧長取點
function smoothLine(g, r) {
  const P = g.P, S = g.S, n = P.length, out = P.map((p) => p.slice());
  let lo = 0, hi = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    while (hi < n && S[hi] <= S[i] + r) { sx += P[hi][0]; sy += P[hi][1]; hi++; }
    while (S[lo] < S[i] - r) { sx -= P[lo][0]; sy -= P[lo][1]; lo++; }
    if (i > 0 && i < n - 1) out[i] = [sx / (hi - lo), sy / (hi - lo)];
  }
  g.P = out;
  G.refresh(g);
}

module.exports = { LANE, MEDIAN_MIN, MEDIAN_MAX, sections, corridors, segmentGap, halfW, nearProjector };
