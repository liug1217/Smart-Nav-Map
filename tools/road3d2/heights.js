// 第 2 版 3D 道路引擎：高度
//   1. 橋梁目標高度 = 6 公尺 × 層數，往前後用 4% 坡度降回地面(整座橋都是滿高度)
//   2. 匝道接主線：接點高度跟主線一樣，往匝道裡面慢慢過渡
//   3. 淨空保證：找出所有上下交叉(平面上相交、但沒有接在一起)，上層路面 - 下層路面 ≥ 5.3 公尺
//      (淨空 4.5 + 橋面厚 0.8)；不夠就把上層在交叉點附近抬高，再用 4% 坡度接回去；重複到全部通過
//   上下層：OSM layer 大的在上；一樣就看哪條是橋；再一樣看現在的高度；都一樣 → 用規則猜(匝道在主線上面、快速道路在國道上面、
//   再不行固定一條)，一樣保證淨空，列入報告的「猜的」
//   兩條都不是橋、layer 也一樣 → 平面路口(快速道路有紅綠燈路口)，不要求淨空
'use strict';

const G = require('./geom');
const N = require('./network');

const LAYER_H = 6, SLOPE = 0.04, CLEAR = 5.3, MERGE_ZONE = 60;

// 往前往後各掃一次：比旁邊低的點用坡度補上(只會抬高)
function dilate(S, z, slope) {
  const n = z.length;
  for (let i = 1; i < n; i++) z[i] = Math.max(z[i], z[i - 1] - slope * (S[i] - S[i - 1]));
  for (let i = n - 2; i >= 0; i--) z[i] = Math.max(z[i], z[i + 1] - slope * (S[i + 1] - S[i]));
  return z;
}

function initial(chains) {
  for (const ch of chains) {
    ch.z = ch.attr.map((w) => (w.bridge ? LAYER_H * Math.max(1, w.layer) : 0));
    dilate(ch.g.S, ch.z, SLOPE);
  }
}

// 路的頭尾接到別條路：接在別條路中間 → 照那條路的高度；頭尾互接 → 平均。往裡面用斜率過渡
function relaxJunctions(chains, nodes) {
  for (const ch of chains) {
    const n = ch.z.length, L = ch.g.S[n - 1];
    [0, n - 1].forEach((i) => {
      const list = (nodes.get(ch.node[i]) || []).filter((o) => o.ch !== ch);
      if (!list.length) return;
      const inner = list.filter((o) => o.i > 0 && o.i < o.ch.z.length - 1);
      const want = inner.length ? Math.max(...inner.map((o) => o.ch.z[o.i]))
        : (ch.z[i] + list.reduce((a, o) => a + o.ch.z[o.i], 0)) / (list.length + 1);
      const diff = want - ch.z[i];
      if (Math.abs(diff) < 0.005) return;
      const ramp = Math.min(L / 2, Math.max(30, Math.abs(diff) / SLOPE));
      for (let j = 0; j < n; j++) {
        const d = i === 0 ? ch.g.S[j] : L - ch.g.S[j];
        if (d < ramp) ch.z[j] += diff * (1 - d / ramp);
      }
    });
  }
}

// 找出所有上下交叉
function findCrossings(chains, nodes) {
  const CELL = 60, grid = new Map();
  chains.forEach((ch, ci) => {
    const P = ch.g.P;
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1];
      const x0 = Math.floor(Math.min(a[0], b[0]) / CELL), x1 = Math.floor(Math.max(a[0], b[0]) / CELL);
      const y0 = Math.floor(Math.min(a[1], b[1]) / CELL), y1 = Math.floor(Math.max(a[1], b[1]) / CELL);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = x * 100003 + y;
        let arr = grid.get(key); if (!arr) { arr = []; grid.set(key, arr); }
        arr.push(ci * 1048576 + i);
      }
    }
  });
  // 兩條路共用的節點(各自的沿路距離)：交叉點在共用節點 60 公尺內 → 是匯流 / 分岔，不是上下交叉
  const shared = new Map();
  for (const list of nodes.values()) {
    if (list.length < 2) continue;
    for (let a = 0; a < list.length; a++) for (let b = 0; b < list.length; b++) {
      if (list[a].ch === list[b].ch) continue;
      const key = list[a].ch.id + ':' + list[b].ch.id;
      if (!shared.has(key)) shared.set(key, []);
      shared.get(key).push([list[a].ch.g.S[list[a].i], list[b].ch.g.S[list[b].i]]);
    }
  }
  const seen = new Set(), out = [];
  for (const arr of grid.values()) {
    for (let x = 0; x < arr.length; x++) for (let y = x + 1; y < arr.length; y++) {
      const ca = Math.floor(arr[x] / 1048576), cb = Math.floor(arr[y] / 1048576);
      if (ca === cb) continue;
      const A = chains[ca], B = chains[cb], ia = arr[x] % 1048576, ib = arr[y] % 1048576;
      const p = A.g.P[ia], q = A.g.P[ia + 1], r = B.g.P[ib], s = B.g.P[ib + 1];
      if (Math.max(p[0], q[0]) < Math.min(r[0], s[0]) || Math.max(r[0], s[0]) < Math.min(p[0], q[0]) ||
          Math.max(p[1], q[1]) < Math.min(r[1], s[1]) || Math.max(r[1], s[1]) < Math.min(p[1], q[1])) continue;
      const d = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0]);
      if (!d) continue;
      const ta = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / d;
      const tb = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d;
      if (ta < 0 || ta > 1 || tb < 0 || tb > 1) continue;
      const key = Math.min(arr[x], arr[y]) + ',' + Math.max(arr[x], arr[y]);   // 同一對線段可能在好幾格都出現
      if (seen.has(key)) continue;
      seen.add(key);
      const sa = A.g.S[ia] + (A.g.S[ia + 1] - A.g.S[ia]) * ta, sb = B.g.S[ib] + (B.g.S[ib + 1] - B.g.S[ib]) * tb;
      const sh = shared.get(A.id + ':' + B.id) || [];
      if (sh.some((x2) => Math.abs(x2[0] - sa) < MERGE_ZONE && Math.abs(x2[1] - sb) < MERGE_ZONE)) continue;
      out.push({ A, ia, ta, sa, B, ib, tb, sb, P: [p[0] + (q[0] - p[0]) * ta, p[1] + (q[1] - p[1]) * ta] });
    }
  }
  return out;
}
const zAt = (ch, i, t) => ch.z[i] + (ch.z[i + 1] - ch.z[i]) * t;
// 誰在上面：回傳 { up, low, guessed } 或 null(平面路口)
function order(c) {
  const wa = c.A.attr[c.ia], wb = c.B.attr[c.ib];
  if (!wa.bridge && !wb.bridge && wa.layer === wb.layer) return null;
  // 第一次決定後就記住(抬高之後高度會變，不能再用高度重新判斷，不然上下可能翻過來)
  if (c.upA !== undefined) return pack(c, c.upA, c.guessed);
  let upA, guessed = false;
  if (wa.layer !== wb.layer) upA = wa.layer > wb.layer;
  else if (wa.bridge !== wb.bridge) upA = wa.bridge;
  else {
    const za = zAt(c.A, c.ia, c.ta), zb = zAt(c.B, c.ib, c.tb);
    if (Math.abs(za - zb) >= 0.01) upA = za > zb;
    else {
      guessed = true;
      if (wa.link !== wb.link) upA = wa.link;
      else if (wa.cls !== wb.cls) upA = wa.cls === 'trunk';
      else upA = c.A.id < c.B.id;
    }
  }
  c.upA = upA; c.guessed = guessed;
  return pack(c, upA, guessed);
}
function pack(c, upA, guessed) {
  return upA ? { up: c.A, ui: c.ia, ut: c.ta, us: c.sa, low: c.B, li: c.ib, lt: c.tb, guessed }
    : { up: c.B, ui: c.ib, ut: c.tb, us: c.sb, low: c.A, li: c.ia, lt: c.ta, guessed };
}

// 全部流程；回傳交叉清單(驗證、報告用)
function computeHeights(chains) {
  const nodes = N.nodeIndex(chains);
  initial(chains);
  relaxJunctions(chains, nodes);
  const crossings = findCrossings(chains, nodes);
  let rounds = 0;
  for (; rounds < 12; rounds++) {
    let raised = 0;
    for (const c of crossings) {
      const o = order(c);
      if (!o) continue;
      const need = zAt(o.low, o.li, o.lt) + CLEAR, have = zAt(o.up, o.ui, o.ut);
      if (have >= need - 0.001) continue;
      // 上層在交叉點抬到 need，用 4% 坡度往兩邊接回去
      const S = o.up.g.S, z = o.up.z;
      for (let j = 0; j < z.length; j++) z[j] = Math.max(z[j], need - SLOPE * Math.max(0, Math.abs(S[j] - o.us) - 2.5));   // 交叉點前後 2.5 公尺平的(交叉點落在兩點中間也夠高)
      raised++;
    }
    relaxJunctions(chains, nodes);
    if (!raised) break;
  }
  // 最後再抬，之後不再調匝道接點(接點調整可能把交叉點附近又拉低，淨空一定要保證)
  // 好幾條路互相交叉時，抬高一條可能讓它在另一個交叉變成太高的下層 → 重複到全部通過(最多 30 回，循環的列入報告)
  for (let pass = 0; pass < 30; pass++) {
    let raised = 0;
    for (const c of crossings) {
      const o = order(c);
      if (!o) continue;
      const need = zAt(o.low, o.li, o.lt) + CLEAR, have = zAt(o.up, o.ui, o.ut);
      if (have >= need - 0.001) continue;
      const S = o.up.g.S, z = o.up.z;
      for (let j = 0; j < z.length; j++) z[j] = Math.max(z[j], need - SLOPE * Math.max(0, Math.abs(S[j] - o.us) - 2.5));
      raised++;
    }
    if (!raised) break;
  }
  return { crossings, rounds, nodes };
}

// 驗證用：每個交叉的淨空
function clearances(crossings) {
  return crossings.map((c) => {
    const o = order(c);
    if (!o) return { c, kind: 'atgrade' };
    return { c, kind: o.guessed ? 'guessed' : 'ok', up: o.up, low: o.low, dz: zAt(o.up, o.ui, o.ut) - zAt(o.low, o.li, o.lt) };
  });
}

module.exports = { LAYER_H, SLOPE, CLEAR, dilate, computeHeights, findCrossings, clearances, order };
