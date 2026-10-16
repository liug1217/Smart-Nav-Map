// 第 2 版 3D 道路引擎：槽化區(匝道分岔、匯入處的白色斜紋)
//   匝道的頭 / 尾接在主線上：沿匝道往外每點投影到主線，算「主線外側車道線 → 匝道內側車道線」的空隙
//   空隙 > 0.15 公尺、< 8 公尺的那段就是槽化區
//   給 Shader 的資料(都用主線的橫向座標)：
//     主線每點：goreA = 主線外側車道線位置，goreB = 匝道內側車道線位置，goreU = 0
//     匝道每點：goreU = 匝道中心在主線座標的橫向位置(頂點的主線座標 = goreU + 自己的 u)，goreA / goreB 同上
//   空隙超過兩邊路肩(地上會露出來)的地方，再補一塊「槽化區路面」(主線右緣 → 匝道左緣)
'use strict';

const G = require('./geom');

function gores(chains, nodes) {
  const fills = [];
  let count = 0;
  for (const ch of chains) { const n = ch.g.P.length; ch.goreU = new Array(n).fill(0); ch.goreA = new Array(n).fill(0); ch.goreB = new Array(n).fill(0); }
  for (const link of chains) {
    if (!link.link || !link.oneway) continue;
    for (const atStart of [true, false]) {
      const li = atStart ? 0 : link.g.P.length - 1;
      const hit = (nodes.get(link.node[li]) || []).find((o) => o.ch !== link && o.ch.oneway && !o.ch.link);
      if (!hit) continue;
      if (goreOf(link, atStart, hit.ch, hit.i, fills)) count++;
    }
  }
  return { count, fills };
}

function goreOf(link, atStart, main, mi, fills) {
  const n = link.g.P.length, order = [];
  for (let k = 0; k < n; k++) order.push(atStart ? k : n - 1 - k);
  // 先決定匝道在主線右邊還是左邊(離接點 30 公尺左右那點)
  const lo = Math.max(0, mi - 200), hi = Math.min(main.g.P.length - 1, mi + 200);
  const samples = [];
  for (const k of order) {
    const u = atStart ? link.g.S[k] : link.g.S[n - 1] - link.g.S[k];
    if (u > 300) break;
    const pr = G.project(main.g, link.g.P[k], lo, hi);
    if (!pr || pr.endT || pr.dist > 60) break;
    samples.push({ k, u, pr });
  }
  if (samples.length < 8) return false;
  const probe = samples.find((x) => x.u > 30) || samples[samples.length - 1], sg = probe.pr.lat >= 0 ? 1 : -1;
  const zone = [];
  let started = false;
  for (const smp of samples) {
    const mi2 = Math.min(main.g.P.length - 1, smp.pr.i + (smp.pr.t > 0.5 ? 1 : 0)), k = smp.k;
    const edgeM = sg > 0 ? main.b[mi2] : main.a[mi2];
    const edgeL = smp.pr.lat + (sg > 0 ? link.a[k] : link.b[k]);
    const gap = sg * (edgeL - edgeM);
    if (gap > 0.15 && gap < 8) {
      started = true;
      zone.push({ k, mi: mi2, edgeM, edgeL, lat: smp.pr.lat });
    } else if (started) break;
  }
  if (zone.length < 3) return false;
  // 槽化區前後各 40 個點：位置照頭 / 尾那點、寬度 0(三角形內插時寬度平順縮到 0，不會內插出假的斜紋)
  const mis = zone.map((z) => z.mi), mLo = Math.min(...mis), mHi = Math.max(...mis);
  const first = zone.reduce((a, z) => (z.mi < a.mi ? z : a)), last = zone.reduce((a, z) => (z.mi > a.mi ? z : a));
  for (let i = Math.max(0, mLo - 40); i <= Math.min(main.g.P.length - 1, mHi + 40); i++) {
    if (i >= mLo && i <= mHi) continue;
    if (Math.abs(main.goreB[i] - main.goreA[i]) > 0) continue;   // 別的匝道已經標了
    const z = i < mLo ? first : last;
    main.goreA[i] = z.edgeM; main.goreB[i] = z.edgeM;
  }
  const ks = zone.map((z) => z.k), kLo = Math.min(...ks), kHi = Math.max(...ks);
  const kFirst = zone.reduce((a, z) => (z.k < a.k ? z : a)), kLast = zone.reduce((a, z) => (z.k > a.k ? z : a));
  for (let i = Math.max(0, kLo - 40); i <= Math.min(link.g.P.length - 1, kHi + 40); i++) {
    if (i >= kLo && i <= kHi) continue;
    const z = i < kLo ? kFirst : kLast;
    link.goreU[i] = z.lat; link.goreA[i] = z.edgeM; link.goreB[i] = z.edgeM;
  }
  // 標在兩條路上(主線用最近的點；同一點被兩個匝道標到時取比較寬的)
  for (const z of zone) {
    const wNew = Math.abs(z.edgeL - z.edgeM), wOld = Math.abs(main.goreB[z.mi] - main.goreA[z.mi]);
    if (wNew > wOld) { main.goreA[z.mi] = z.edgeM; main.goreB[z.mi] = z.edgeL; }
    link.goreU[z.k] = z.lat; link.goreA[z.k] = z.edgeM; link.goreB[z.k] = z.edgeL;
  }
  // 空隙超過兩邊路肩：補槽化區路面(主線外緣 → 匝道內緣)
  const ring1 = [], ring2 = [], idx = [];
  for (const z of zone) {
    const mEdge = sg > 0 ? main.eR[z.mi] : main.eL[z.mi], lEdge = z.lat + (sg > 0 ? link.eL[z.k] : link.eR[z.k]);
    if (sg * (lEdge - mEdge) <= 0.05) continue;
    ring1.push(edgeOf(main, z.mi, mEdge)); ring2.push(edgeOf(main, z.mi, lEdge)); idx.push(z.mi);
  }
  if (ring1.length >= 2) fills.push({ ch: main, idx: [idx.reduce((a, b) => Math.min(a, b)), idx.reduce((a, b) => Math.max(a, b))], ring: ring1.concat(ring2.reverse()), fill: true });
  return true;
}
function edgeOf(ch, i, off) {
  const p = ch.g.P[i], n = G.normalOf(ch.g.T[i]), k = G.kAtY(p[1]);
  return [p[0] + n[0] * off / k, p[1] + n[1] * off / k];
}

module.exports = { gores };
