// 第 2 版 3D 道路引擎：自動檢查(每次產生資料都跑)
//   1. 分隔島寬度：配對段每 10 公尺量一次，相鄰兩次的變化跟設計的變化差 ≤ 2 公分(平順)、實際跟設計差 ≤ 5 公分；
//      設計寬度本身每公尺變化 ≤ 1.5 × 寬度差 / 150(smoothstep 最陡的地方)
//   2. 邊線無折回：每條路左右路緣的每一點都要沿切線往前(不會往回折)
//   3. 接縫角度：資料切成圖磚的地方，前後兩塊在接縫的方向差 < 0.5 度(build-road3d.js 輸出後檢查)
//      (曲率突然跳的地方(原始資料比較亂)只列為提醒，不排除那條路)
//   4. 淨空：所有上下交叉，上層 - 下層 ≥ 5.3 公尺(淨空 4.5 + 橋面 0.8)
// 沒過的「路段」(出問題的位置前後一段)不產生，列進報告；排除的長度超過全台道路總長的 0.5% 就整批停止
//   排除範圍：邊線折回前後 60 公尺、分隔島前後 300、分隔島平順前後 200、淨空前後 200
'use strict';

const G = require('./geom');
const H = require('./heights');
const K = require('./corridor');

const LIMIT = 0.005;
const SPAN = { 'edge-fold': 60, 'median-width': 300, 'median-smooth': 200, 'median-design': 300, clearance: 200 };

function where(ch, i) {
  const p = ch.g.P[Math.max(0, Math.min(ch.g.P.length - 1, i))], ll = G.unmerc(p[0], p[1]);
  return { lon: +ll[0].toFixed(6), lat: +ll[1].toFixed(6) };
}
function describe(ch) {
  return { chain: ch.id, osmWays: ch.ways.map((w) => w.id), name: [...new Set(ch.ways.map((w) => w.name).filter(Boolean))].join(' / ') };
}

function checkMedians(runs, fail) {
  for (const r of runs) {
    const { A, B, C, gap } = r, n = C.P.length;
    // 設計寬度的變化率
    let maxSlope = 0, span = 0;
    for (let j = 1; j < n; j++) maxSlope = Math.max(maxSlope, Math.abs(gap[j] - gap[j - 1]) / ((C.S[j] - C.S[j - 1]) || 1));
    span = gap.reduce((a, b) => Math.max(a, b), -Infinity) - gap.reduce((a, b) => Math.min(a, b), Infinity);
    if (maxSlope > 1.5 * Math.max(span, 0.01) / 150 + 1e-4) fail('median-design', A, 0, { maxSlope: +maxSlope.toFixed(4) }, B);
    // 實際寬度：在 A 上有分隔島資料(配對完全生效)的點
    let worst = 0, wi = -1, worstStep = 0, si = -1, prev = null;
    const badW = [], badS = [];
    const prB = K.nearProjector(B.g);
    for (let i = 0; i < A.g.P.length; i += 5) {
      if (A.medGap[i] === null || A.pairId[i] !== B.id) continue;
      const pr = prB(A.g.P[i]);
      if (!pr || pr.endT) continue;
      // 只量兩邊都是這條走廊管的點(對向那點也配對到 A)
      const bi = Math.min(B.g.P.length - 1, pr.i + (pr.t > 0.5 ? 1 : 0));
      if (B.pairId[bi] !== A.id || B.medGap[bi] === null) continue;
      // 對向的路寬：投影點前後兩點內插(車道數漸變時路寬一直在變，取最近一點會有幾公分誤差)
      const j1 = Math.min(B.g.P.length - 1, pr.i + 1), hB = K.halfW(B, pr.i) + (K.halfW(B, j1) - K.halfW(B, pr.i)) * pr.t;
      const actual = pr.dist - K.halfW(A, i) - hB;
      const d = Math.abs(actual - A.medGap[i]);
      if (d > worst) { worst = d; wi = i; }
      if (d > 0.05) badW.push(i);
      if (prev && i - prev.i <= 5) {
        const step = Math.abs((actual - prev.actual) - (A.medGap[i] - prev.design));
        if (step > worstStep) { worstStep = step; si = i; }
        if (step > 0.02) badS.push(i);
      }
      prev = { i, actual, design: A.medGap[i] };
    }
    // 每個沒過的點都排除(兩條路都排除那一段)，報告每條每種只列最嚴重的一處
    badW.forEach((i) => fail('median-width', A, i, { diff: +worst.toFixed(3) }, B, i === wi));
    badS.forEach((i) => fail('median-smooth', A, i, { step: +worstStep.toFixed(3) }, B, i === si));
  }
}

function checkFolds(chains, fail) {
  for (const ch of chains) {
    const P = ch.g.P, T = ch.g.T;
    let bad = 0, first = -1;
    const pts = [];
    const edge = (i, off) => { const n = G.normalOf(T[i]), k = G.kAtY(P[i][1]); return [P[i][0] + n[0] * off / k, P[i][1] + n[1] * off / k]; };
    for (let i = 0; i < P.length - 1; i++) {
      for (const which of ['eL', 'eR']) {
        const a = edge(i, ch[which][i]), b = edge(i + 1, ch[which][i + 1]);
        if ((b[0] - a[0]) * T[i][0] + (b[1] - a[1]) * T[i][1] <= 0) { bad++; if (first < 0) first = i; pts.push(i); }
      }
    }
    pts.forEach((i) => fail('edge-fold', ch, i, { points: bad }, null, i === first));
  }
}

// 折角：每點的轉彎量(換算成每 2 公尺的角度)跟前後點平均差多少；曲率改變(直線接彎道)不算，只有突然折一下才算
function checkJoints(chains, warn) {
  for (const ch of chains) {
    const P = ch.g.P, n = P.length;
    if (n < 5) continue;
    const head = [], len = [];
    for (let i = 0; i < n - 1; i++) { head.push(Math.atan2(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1])); len.push(ch.g.S[i + 1] - ch.g.S[i]); }
    const curv = [null];
    for (let i = 1; i < n - 1; i++) {
      let d = head[i] - head[i - 1]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      curv.push(d / Math.max(0.2, (len[i - 1] + len[i]) / 2));   // 每公尺轉幾度(弧度)
    }
    let worst = 0, wi = -1;
    for (let i = 2; i < n - 2; i++) {
      const kink = Math.abs(curv[i] - (curv[i - 1] + curv[i + 1]) / 2) * 2 * 180 / Math.PI;   // 換成每 2 公尺
      if (kink > worst) { worst = kink; wi = i; }
    }
    if (worst >= 0.5) warn('kink', ch, wi, { deg: +worst.toFixed(2) });
  }
}

function checkClearance(crossings, fail) {
  for (const c of H.clearances(crossings)) {
    if (c.kind === 'atgrade' || c.dz >= H.CLEAR - 0.01) continue;
    fail('clearance', c.up, c.c.A === c.up ? c.c.ia : c.c.ib, { dz: +c.dz.toFixed(2) }, c.low, true);
  }
}

function validate(chains, runs, crossings) {
  const failures = [], warnings = [], seen = new Set();
  // 排除這條路第 i 點前後 SPAN 公尺；對向 / 交叉的另一條，在同一個位置也排除；報告每條每種只列一處(listIt = 最嚴重那處)
  const fail = (check, ch, i, detail, other, listIt) => {
    const span = SPAN[check] || 100, ii = Math.max(0, Math.min(ch.g.S.length - 1, i)), s = ch.g.S[ii];
    (ch.bad = ch.bad || []).push([s - span, s + span]);
    if (other) {
      const pr = G.project(other.g, ch.g.P[ii]);
      if (pr && pr.dist < 80) (other.bad = other.bad || []).push([pr.s - span, pr.s + span]);
    }
    const key = check + ':' + ch.id + ':' + (other ? other.id : '');
    if (seen.has(key) || listIt === false) return;   // listIt 沒傳 = 照常列
    seen.add(key);
    failures.push(Object.assign({ check }, describe(ch), where(ch, i), { detail }, other ? { other: describe(other) } : {}));
  };
  const warn = (check, ch, i, detail) => warnings.push(Object.assign({ check }, describe(ch), where(ch, i), { detail }));
  checkClearance(crossings, fail);
  checkMedians(runs, fail);
  checkFolds(chains, fail);
  checkJoints(chains, warn);
  // 排除的總長度(合併重疊的區間)
  let badLen = 0, total = 0;
  for (const ch of chains) {
    const L = ch.g.S[ch.g.S.length - 1]; total += L;
    if (!ch.bad) continue;
    const rs = ch.bad.map((r) => [Math.max(0, r[0]), Math.min(L, r[1])]).sort((a, b) => a[0] - b[0]), merged = [];
    for (const r of rs) { const last = merged[merged.length - 1]; if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push(r.slice()); }
    ch.bad = merged;
    for (const r of merged) badLen += r[1] - r[0];
  }
  const failedChains = chains.filter((c) => c.bad && c.bad.length).length;
  warnings.sort((a, b) => b.detail.deg - a.detail.deg);
  return { failures, warnings, failedChains, total: chains.length, badKm: badLen / 1000, totalKm: total / 1000, ratio: badLen / total, abort: badLen / total > LIMIT };
}

module.exports = { LIMIT, validate };
