// 第 2 版 3D 道路引擎：護欄、分隔島、橋梁結構
//   護欄：外側鋼板(平地)／混凝土(橋上)；匝道兩側；落在同高度別條路面上的不畫(交叉、匯流處)
//   中央分隔：窄(< 1.6 公尺)正中間一道紐澤西護欄＋防眩板(只由 id 小的那條畫)；寬的兩邊各一道、中間灌木
//   橋面版：高度 > 0.5 公尺的路段，兩側 0.8 公尺厚的側邊＋底面(跟別條同高度路面重疊的地方不畫)
//   橋墩：高度 > 3 公尺，每 30 公尺一根(在中心線下面)
'use strict';

const G = require('./geom');
const NARROW = 1.6, SLAB = 0.8;
const inBad = (ch, s) => { if (!ch.bad) return false; for (const r of ch.bad) if (s >= r[0] && s <= r[1]) return true; return false; };

function makeCover(chains) {
  const CELL = 60, grid = new Map();
  for (const ch of chains) {
    const P = ch.g.P;
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1], k = G.kAtY(a[1]), pad = Math.max(-ch.eL[i], ch.eR[i]) / k + 1;
      const x0 = Math.floor((Math.min(a[0], b[0]) - pad) / CELL), x1 = Math.floor((Math.max(a[0], b[0]) + pad) / CELL);
      const y0 = Math.floor((Math.min(a[1], b[1]) - pad) / CELL), y1 = Math.floor((Math.max(a[1], b[1]) + pad) / CELL);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = x * 100003 + y; let arr = grid.get(key); if (!arr) { arr = []; grid.set(key, arr); } arr.push(ch.id * 1048576 + i);
      }
    }
  }
  const byId = new Map(chains.map((c) => [c.id, c]));
  // 這點(路面高度 z)是不是在別條同高度的路面上(高度差 1 公尺內，跟路面裁切同一個標準：那裡的路面已經被裁掉了)
  return function covered(p, z, self) {
    const arr = grid.get(Math.floor(p[0] / CELL) * 100003 + Math.floor(p[1] / CELL));
    if (!arr) return false;
    for (const code of arr) {
      const ch = byId.get(Math.floor(code / 1048576)), i = code % 1048576;
      if (ch === self) continue;
      const A = ch.g.P[i], B = ch.g.P[i + 1], dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
      if (!L2) continue;
      const t = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2;
      if (t < -1e-4 || t > 1 + 1e-4) continue;
      const zo = ch.z[i] + (ch.z[i + 1] - ch.z[i]) * t;
      if (Math.abs(zo - z) > 1) continue;
      const k = G.kAtY(A[1]), L = Math.sqrt(L2);
      const lat = ((p[0] - A[0] - dx * t) * dy / L - (p[1] - A[1] - dy * t) * dx / L) * k;
      const eL = ch.eL[i] + (ch.eL[i + 1] - ch.eL[i]) * t, eR = ch.eR[i] + (ch.eR[i + 1] - ch.eR[i]) * t;
      if (lat > eL + 0.5 && lat < eR - 0.5) return true;
    }
    return false;
  };
}

// 沿線(偏移 off(i))每 1 公尺取樣，回傳看得到的區間 [[s0, s1], ...]；ok(i) = 這段要不要畫
function runs(ch, off, covered, ok) {
  const P = ch.g.P, S = ch.g.S, out = [];
  let cur = null;
  for (let i = 0; i < P.length - 1; i++) {
    const len = S[i + 1] - S[i], m = Math.max(1, Math.ceil(len));
    const good = !ok || (ok(i) && ok(i + 1));
    for (let j = 0; j < m; j++) {
      const t = (j + 0.5) / m, s0 = S[i] + len * j / m, s1 = S[i] + len * (j + 1) / m;
      let vis = good && !inBad(ch, (s0 + s1) / 2);   // 自動檢查沒過的路段不畫
      if (vis) {
        const p = [P[i][0] + (P[i + 1][0] - P[i][0]) * t, P[i][1] + (P[i + 1][1] - P[i][1]) * t], nrm = G.normalOf(ch.g.T[i]), k = G.kAtY(p[1]);
        const o = off(i) * (1 - t) + off(i + 1) * t, z = ch.z[i] + (ch.z[i + 1] - ch.z[i]) * t;
        vis = !covered([p[0] + nrm[0] * o / k, p[1] + nrm[1] * o / k], z, ch);
      }
      if (vis) { if (cur && Math.abs(cur[1] - s0) < 1e-6) cur[1] = s1; else { cur = [s0, s1]; out.push(cur); } } else cur = null;
    }
  }
  return out;
}

function features(ch, covered) {
  const R = [];
  const bridge = (i) => ch.attr[i].bridge || ch.z[i] > 0.5;
  const rail = (off, side) => {
    R.push({ t: 'wb', off, side, vis: runs(ch, off, covered, (i) => !bridge(i)) });
    R.push({ t: 'pp', off, side, vis: runs(ch, off, covered, (i) => bridge(i)) });
  };
  if (ch.oneway) {
    rail((i) => ch.eR[i] - 0.3, 1);
    if (ch.link) rail((i) => ch.eL[i] + 0.3, -1);
    else median(ch, covered, R);
  } else {
    rail((i) => ch.eR[i] - 0.3, 1);
    rail((i) => ch.eL[i] + 0.3, -1);
  }
  // 橋面版側邊＋底面
  R.push({ t: 'slab', off: (i) => ch.eL[i], off2: (i) => ch.eR[i], side: 1, vis: runs(ch, () => 0, covered, (i) => ch.z[i] > 0.5) });   // 中心線落在別條同高度的路面上：路面已經被裁掉，橋面版也不畫，不然底面會從上面露出來
  return R;
}
function median(ch, covered, R) {
  const narrow = (i) => ch.medGap[i] !== null && ch.medGap[i] < NARROW;
  const mine = (i) => ch.pairId[i] === null || ch.id < ch.pairId[i];
  const center = (i) => ch.eL[i] - (ch.medGap[i] !== null ? ch.medGap[i] / 2 : 0);
  const single = runs(ch, center, covered, (i) => narrow(i) && mine(i));
  R.push({ t: 'nj', off: (i) => center(i) - 0.33, side: 1, vis: single });
  R.push({ t: 'ag', off: center, side: 1, vis: single });
  R.push({ t: 'nj', off: (i) => ch.eL[i], side: -1, vis: runs(ch, (i) => ch.eL[i] - 0.3, covered, (i) => !narrow(i)) });
  const hedgeOK = (i) => ch.medGap[i] !== null && ch.medGap[i] >= NARROW + 0.3 && mine(i);
  R.push({ t: 'hg', off: (i) => ch.eL[i] - 0.7, off2: (i) => ch.eL[i] - Math.max(1.0, (ch.medGap[i] || 0) - 0.7), side: -1, vis: runs(ch, (i) => ch.eL[i] - 0.7, covered, hedgeOK) });
}

// 橋墩：高度 > 3 公尺，每 30 公尺一根；回傳 [{ P, z(橋面), w(寬), t(方向) }]
function piers(ch) {
  const out = [], S = ch.g.S;
  let next = 15;
  for (let i = 0; i < S.length; i++) {
    if (S[i] < next) continue;
    next = S[i] + 30;
    if (ch.z[i] < 3 || inBad(ch, S[i])) continue;
    const W = ch.eR[i] - ch.eL[i];
    out.push({ P: ch.g.P[i], z: ch.z[i] - SLAB, w: Math.max(2, W * 0.3), off: (ch.eL[i] + ch.eR[i]) / 2, i });
  }
  return out;
}

module.exports = { NARROW, SLAB, makeCover, runs, features, piers };
