// 第 2 版 3D 道路引擎：路面網格
//   1. 每條路先減點(直路上 2 公尺一點太多)：位置、高度、路寬誤差都在 5 公分內的點拿掉(標線是 Shader 畫的，網格不用那麼細)
//   2. 每 40 個點一塊，做成「左緣 → 右緣」的路面多邊形；頭尾是路口的加半圓
//   3. 重疊的路面(匯流、分岔處)：優先順序低的那塊減掉優先順序高的(polygon-clipping)，只剩一片，不會打架
//      優先順序：主線 > 匝道；車道多的 > 少的；再一樣固定一條
//   4. 三角化(earcut)；每個頂點帶 Shader 塗標線用的資料：
//      u 橫向位置(離中心線，往右為正)、S 沿路距離、a / b 最左 / 最右車道外緣、flags(匝道、雙向)、
//      槽化區(gu = 在主線座標的橫向位置，g0～g1 = 槽化區範圍)
'use strict';

const pc = require('polygon-clipping');
const earcut = require('earcut');
const G = require('./geom');
const inBad = (ch, s) => { if (!ch.bad) return false; for (const r of ch.bad) if (s >= r[0] && s <= r[1]) return true; return false; };

const BLOCK = 40;

function priority(ch) {
  let lanes = 0; for (const w of ch.attr) lanes = Math.max(lanes, w.lanes);
  return { link: ch.link, lanes, id: ch.id };
}
// a 要不要讓 b(b 優先)
function yields(a, b) {
  if (a.link !== b.link) return a.link;
  if (a.lanes !== b.lanes) return b.lanes > a.lanes;
  return b.id < a.id;
}

// 減點：留下的原始索引(值：位置、高度、路寬誤差都在 tol 內；最長 200 公尺一點)
function simplifyIdx(ch, tol = 0.05) {
  const P = ch.g.P, S = ch.g.S, n = P.length, keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const val = (i) => { const k = G.kAtY(P[i][1]); return [P[i][0] * k, P[i][1] * k, ch.z[i], ch.eL[i], ch.a[i], ch.b[i], ch.eR[i], ch.goreA[i], ch.goreB[i], ch.goreU[i]]; };
  const V = []; for (let i = 0; i < n; i++) V.push(val(i));
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const t = (S[i] - S[a]) / ((S[b] - S[a]) || 1), A = V[a], B = V[b], X = V[i];
      let e = Math.hypot(A[0] + (B[0] - A[0]) * t - X[0], A[1] + (B[1] - A[1]) * t - X[1]);
      for (let c = 2; c < 10; c++) e = Math.max(e, Math.abs(A[c] + (B[c] - A[c]) * t - X[c]));
      if (e > worst) { worst = e; wi = i; }
    }
    if (worst > tol || S[b] - S[a] > 200) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

// 邊緣點(Mercator)
function edgePoint(ch, i, off) {
  const p = ch.g.P[i], n = G.normalOf(ch.g.T[i]), k = G.kAtY(p[1]);
  return [p[0] + n[0] * off / k, p[1] + n[1] * off / k];
}

// 每條路切成路面塊
function makeBlocks(chains, fills) {
  const blocks = [];
  for (const ch of chains) {
    ch.pri = priority(ch);
    ch.keep = simplifyIdx(ch);
    // 自動檢查沒過的路段(ch.bad)不產生：把減點後的點切成好幾段連續的
    const runs = [];
    let cur = [];
    for (const i of ch.keep) { if (inBad(ch, ch.g.S[i])) { if (cur.length > 1) runs.push(cur); cur = []; } else cur.push(i); }
    if (cur.length > 1) runs.push(cur);
    for (const K of runs) for (let b0 = 0; b0 < K.length - 1; b0 += BLOCK) {
      const idx = K.slice(b0, Math.min(K.length, b0 + BLOCK + 1));
      const left = idx.map((i) => edgePoint(ch, i, ch.eL[i])), right = idx.map((i) => edgePoint(ch, i, ch.eR[i]));
      const ring = left.concat(right.reverse());
      const blk = { ch, idx, ring, caps: [] };
      blocks.push(blk);
    }
    // 頭尾：路口加半圓(讓斜接的地方平順)
    [0, ch.g.P.length - 1].forEach((i) => {
      if (inBad(ch, ch.g.S[i])) return;
      const p = ch.g.P[i], k = G.kAtY(p[1]), r = (ch.eR[i] - ch.eL[i]) / 2, ring = [];
      for (let j = 0; j < 24; j++) { const a = j / 24 * Math.PI * 2; ring.push([p[0] + Math.cos(a) * r / k, p[1] + Math.sin(a) * r / k]); }
      blocks.push({ ch, idx: [i], ring, cap: true });
    });
  }
  // 槽化區路面(主線外緣 → 匝道內緣)
  for (const f of fills || []) if (!inBad(f.ch, f.ch.g.S[f.idx[0]]) && !inBad(f.ch, f.ch.g.S[f.idx[1]])) blocks.push({ ch: f.ch, idx: rangeIdx(f.idx[0], f.idx[1]), ring: f.ring, fill: true });
  return blocks;
}
function rangeIdx(a, b) { const out = []; for (let i = a; i <= b; i++) out.push(i); return out; }

function bbox(ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of ring) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  return [x0, y0, x1, y1];
}
function zRange(blk) { let lo = Infinity, hi = -Infinity; for (const i of blk.idx) { lo = Math.min(lo, blk.ch.z[i]); hi = Math.max(hi, blk.ch.z[i]); } return [lo, hi]; }

// 重疊：優先順序低的減掉高的；回傳每塊的多邊形(MultiPolygon，Mercator)，null = 沒被裁(直接用條狀三角形)
function clipBlocks(blocks) {
  const CELL = 200, grid = new Map();
  blocks.forEach((b, bi) => {
    b.bb = bbox(b.ring); b.zr = zRange(b);
    for (let x = Math.floor(b.bb[0] / CELL); x <= Math.floor(b.bb[2] / CELL); x++)
      for (let y = Math.floor(b.bb[1] / CELL); y <= Math.floor(b.bb[3] / CELL); y++) {
        const key = x * 100003 + y; let arr = grid.get(key); if (!arr) { arr = []; grid.set(key, arr); } arr.push(bi);
      }
  });
  let clipped = 0, failed = 0;
  blocks.forEach((b) => {
    const cand = new Set();
    for (let x = Math.floor(b.bb[0] / CELL); x <= Math.floor(b.bb[2] / CELL); x++)
      for (let y = Math.floor(b.bb[1] / CELL); y <= Math.floor(b.bb[3] / CELL); y++)
        for (const oi of grid.get(x * 100003 + y) || []) cand.add(oi);
    const subs = [];
    for (const oi of cand) {
      const o = blocks[oi];
      if (o === b || o.ch === b.ch) continue;
      if (o.bb[0] > b.bb[2] || o.bb[2] < b.bb[0] || o.bb[1] > b.bb[3] || o.bb[3] < b.bb[1]) continue;
      if (o.zr[0] > b.zr[1] + 1 || o.zr[1] < b.zr[0] - 1) continue;   // 高度差很多(上下層)：不用裁，深度會處理
      if (!yields(b.ch.pri, o.ch.pri)) continue;
      // 逐段比高度：只拿「在同一個位置、高度差 1 公尺內」的那幾段去裁(引道從地面爬上高架時，整塊的高度範圍會跟上下層重疊)
      for (const q of sameHeightQuads(o, b)) subs.push(q);
    }
    if (!subs.length) { b.poly = null; return; }
    // 用這塊的局部座標(公尺，原點在第一點)做裁切，數值穩定
    const o0 = b.ring[0], k = G.kAtY(o0[1]);
    const toL = (r) => r.map((p) => [(p[0] - o0[0]) * k, (p[1] - o0[1]) * k]);
    try {
      const res = pc.difference([toL(b.ring)], ...subs.map((q) => [toL(q)]));
      b.poly = res.map((poly) => poly.map((ring) => ring.map((q) => [o0[0] + q[0] / k, o0[1] + q[1] / k])));
      clipped++;
    } catch (e) { b.poly = null; failed++; }
  });
  return { clipped, failed };
}

// o 這塊裡，跟 b 在同一個位置、高度差 1 公尺內的路段(四邊形，Mercator)
function sameHeightQuads(o, b) {
  const out = [], ch = o.ch, idx = o.idx;
  if (o.cap || o.fill || idx.length < 2) {   // 半圓、槽化區路面：用中心點的高度判斷整塊
    const zo = ch.z[idx[0]], at = locate(b.ch, b.idx, ch.g.P[idx[0]]), zb = lerpAt(b.ch.z, at.i, at.f);
    if (Math.abs(zo - zb) <= 1) out.push(o.ring);
    return out;
  }
  for (let j = 0; j < idx.length - 1; j++) {
    const i0 = idx[j], i1 = idx[j + 1];
    const mid = [(ch.g.P[i0][0] + ch.g.P[i1][0]) / 2, (ch.g.P[i0][1] + ch.g.P[i1][1]) / 2];
    const zo = (ch.z[i0] + ch.z[i1]) / 2, at = locate(b.ch, b.idx, mid), zb = lerpAt(b.ch.z, at.i, at.f);
    if (Math.abs(zo - zb) > 1) continue;
    out.push([edgePoint(ch, i0, ch.eL[i0]), edgePoint(ch, i1, ch.eL[i1]), edgePoint(ch, i1, ch.eR[i1]), edgePoint(ch, i0, ch.eR[i0])]);
  }
  return out;
}

// 頂點 → 路的哪裡(投影到這塊的中心線)：回傳 { s, u, i, f }
function locate(ch, idx, p) {
  let best = null;
  const i0 = idx[0], i1 = idx[idx.length - 1];
  for (let i = i0; i < Math.max(i0 + 1, i1); i++) {
    const A = ch.g.P[i], B = ch.g.P[Math.min(ch.g.P.length - 1, i + 1)], dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2)) : 0;
    const qx = A[0] + dx * t, qy = A[1] + dy * t, d = Math.hypot(p[0] - qx, p[1] - qy);
    if (!best || d < best.d) best = { d, i, t };
  }
  const i = best.i, j = Math.min(ch.g.P.length - 1, i + 1), t = best.t;
  const P = [ch.g.P[i][0] + (ch.g.P[j][0] - ch.g.P[i][0]) * t, ch.g.P[i][1] + (ch.g.P[j][1] - ch.g.P[i][1]) * t];
  const T = ch.g.T[i], n = G.normalOf(T), k = G.kAtY(P[1]);
  return { i, f: t, s: ch.g.S[i] + (ch.g.S[j] - ch.g.S[i]) * t, u: ((p[0] - P[0]) * n[0] + (p[1] - P[1]) * n[1]) * k };
}
const lerpAt = (arr, i, f) => arr[i] + (arr[Math.min(arr.length - 1, i + 1)] - arr[i]) * f;

// 一個頂點的所有資料
function vertex(ch, p, loc) {
  const i = loc.i, f = loc.f;
  return {
    X: p[0], Y: p[1], z: lerpAt(ch.z, i, f), u: loc.u, S: loc.s,
    a: lerpAt(ch.a, i, f), b: lerpAt(ch.b, i, f),
    flags: (ch.link ? 1 : 0) | (ch.oneway ? 0 : 2),
    gu: ch.goreU ? lerpAt(ch.goreU, i, f) + (loc.u) : 0,
    g0: ch.goreA ? lerpAt(ch.goreA, i, f) : 0, g1: ch.goreB ? lerpAt(ch.goreB, i, f) : 0,
    ch,
  };
}

// 三角化：回傳 [{ verts: [...], tris: [i, j, k, ...] }]
function triangulate(blocks) {
  const out = [];
  for (const b of blocks) {
    const ch = b.ch;
    if (!b.poly) {
      if (b.cap || b.fill) {   // 半圓、槽化區路面(沒被裁)：當成多邊形三角化
        b.poly = [[b.ring.concat([b.ring[0]])]];
      } else {
        // 條狀：每兩點一個四邊形
        const verts = [], tris = [];
        b.idx.forEach((i) => {
          const L = edgePoint(ch, i, ch.eL[i]), R = edgePoint(ch, i, ch.eR[i]);
          verts.push(vertex(ch, L, { i, f: 0, s: ch.g.S[i], u: ch.eL[i] }), vertex(ch, R, { i, f: 0, s: ch.g.S[i], u: ch.eR[i] }));
        });
        for (let j = 0; j < b.idx.length - 1; j++) { const a = j * 2; tris.push(a, a + 1, a + 3, a, a + 3, a + 2); }
        out.push({ verts, tris });
        continue;
      }
    }
    for (const poly of b.poly) {
      const flat = [], holes = [], pts = [];
      poly.forEach((ring, ri) => {
        if (ri) holes.push(pts.length);
        const r = ring.slice(0, -1);   // polygon-clipping 的環頭尾重複
        for (const p of r) { pts.push(p); flat.push(p[0], p[1]); }
      });
      const tris = earcut(flat, holes, 2);
      if (!tris.length) continue;
      const verts = pts.map((p) => vertex(ch, p, locate(ch, b.idx, p)));
      out.push({ verts, tris });
    }
  }
  return out;
}

module.exports = { priority, yields, simplifyIdx, makeBlocks, clipBlocks, triangulate, edgePoint, locate };
