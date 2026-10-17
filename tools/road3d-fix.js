// 3D 道路資料的修正(tools/build-road3d.js 用)：第一版的畫法不變，只把會出 bug 的地方先在電腦上修好
//   0. 接點、接縫也改成貝茲曲線(手機只處理一般轉角)，接在那裡的路一起移，照樣接在一起
//   1. 車道數：沒標的用接點車道數守恆推(進來的車道數 = 出去的)，推不出來才讓手機用一般值
//   2. 對向車道疊在一起：OSM 兩個方向的線常常比兩邊路寬加起來還近 → 兩邊路面重疊、中央護欄畫到對向車道上。
//      量每點跟左邊對向車道的距離，不夠(兩邊半寬 + 0.8 公尺)就兩條各往外推一半(前後 60 公尺平順過渡)，
//      接在推過的點上的匝道頭尾跟著移(往匝道裡面 100 公尺慢慢變回原位)，路還是接在一起
//   3. 高度：橋每層 6 公尺(真的高架)；上下交叉保證上層比下層高 5.3 公尺(淨空 4.5)，不夠就在交叉點附近抬高；
//      每條路頭尾的高度(接在別條路中間就照那條路那點實際的高度)算好存起來，手機照用
//   4. 護欄會畫在別條路的路面上：用手機一模一樣的畫法(road_3d_shape.js)算出每條路的路面，
//      護欄每 2 公尺檢查一次，落在別條同高度(差 0.6 公尺內)的路面上就記下來，手機那段不畫
'use strict';

const SH = require('../road_3d_shape');

const R = 6378137, D2R = Math.PI / 180;
const merc = (lon, lat) => [R * lon * D2R, R * Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2))];
const unmerc = (X, Y) => [X / R / D2R, (2 * Math.atan(Math.exp(Y / R)) - Math.PI / 2) / D2R];
const kAt = (lat) => Math.cos(lat * D2R);
const key = (c) => c[0].toFixed(6) + ',' + c[1].toFixed(6);
const rightN = (tx, ty) => [ty, -tx];   // y 往北
// 比對用的共同座標(公尺，原點在台灣中間)：每條路都用同一個比例，兩條路在同一個位置的點座標一樣
//   (每條路自己的形狀照手機用自己的比例算，換到這裡時長度乘上 fOf 修正，差不到萬分之五)
const O = merc(121, 23.7), KC = kAt(23.7);
const chk = (c) => { const m = merc(c[0], c[1]); return [(m[0] - O[0]) * KC, (m[1] - O[1]) * KC]; };
const fOf = (lat) => KC / kAt(lat);

// ── 0-1. 清掉接點旁邊的雜訊小折點 ──
//   原始資料常在接點附近幾公尺內畫一堆很密、一折一折的點(測量雜訊)；曲線一定要通過每個點，會被逼得急轉、路面外緣往回折。
//   前後兩段都在 4 公尺內(或其中一段 1.5 公尺內)、轉角超過 25 度、又不是好幾條路共用的點 → 刪掉，重複到沒有
function cleanJitter(ways) {
  const use = new Map();
  for (const w of ways) w.nodes.forEach((id) => { if (id != null) use.set(id, (use.get(id) || 0) + 1); });
  let removed = 0;
  for (const w of ways) {
    for (let pass = 0; pass < 10; pass++) {
      let changed = false;
      for (let i = 1; i < w.ll.length - 1; i++) {
        if (w.nodes[i] != null && use.get(w.nodes[i]) > 1) continue;
        const a = w.ll[i - 1], b = w.ll[i], c = w.ll[i + 1], l1 = dist(a, b), l2 = dist(b, c);
        if (!((l1 < 4 && l2 < 4) || l1 < 1.5 || l2 < 1.5)) continue;
        const A = merc(a[0], a[1]), B = merc(b[0], b[1]), C = merc(c[0], c[1]);
        const u = [B[0] - A[0], B[1] - A[1]], v = [C[0] - B[0], C[1] - B[1]], cos = (u[0] * v[0] + u[1] * v[1]) / ((Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1])) || 1);
        if (Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI <= 25) continue;
        w.ll.splice(i, 1); w.nodes.splice(i, 1); i--; changed = true; removed++;
      }
      if (!changed) break;
    }
  }
  return removed;
}

// ── 0. 接點、接縫也用貝茲曲線 ──
//   手機只把「只有這條路用的轉角」改成曲線，接點(匝道接上來的點)、兩段路接縫的地方都保持原本的折角(不然路會接不起來)，
//   主線在每個交流道、每個接縫都會折一下。這裡在電腦上先處理：每個接點找「直直穿過去的那條路」
//   (路在這點中間經過，或前一段的尾接下一段的頭，挑轉彎最小的)，把那個轉角換成二次貝茲曲線(兩邊各取一段，
//   不超過那段的一半、最多 40 公尺)，接點本身移到曲線的正中間；接在這點的其他路(匝道)也一起移過去，路照樣接在一起
function roundNodes(ways) {
  const at = new Map();
  for (const w of ways) w.nodes.forEach((id, i) => { if (id == null) return; if (!at.has(id)) at.set(id, []); at.get(id).push({ w, i }); });
  const plans = new Map();   // 節點 id → { prev, next, J, curve: [點...](經緯度，正中間那點 = 接點新位置), owner }
  for (const [id, list] of at) {
    if (list.length < 2) continue;
    const J = list[0].w.ll[list[0].i], kx = 111320 * Math.cos(J[1] * D2R), ky = 110540;
    const loc = (c) => [(c[0] - J[0]) * kx, (c[1] - J[1]) * ky];
    const cands = [];
    for (const o of list) {
      const last = o.w.ll.length - 1;
      if (o.i > 0 && o.i < last) cands.push({ prev: o.w.ll[o.i - 1], next: o.w.ll[o.i + 1], inner: o });
    }
    for (const a of list) for (const b of list) {
      if (a.w === b.w || a.i !== a.w.ll.length - 1 || b.i !== 0 || a.w.oneway !== b.w.oneway) continue;
      cands.push({ prev: a.w.ll[a.i - 1], next: b.w.ll[1], A: a, B: b });
    }
    let best = null;
    for (const c of cands) {
      const p = loc(c.prev), n = loc(c.next), lp = Math.hypot(p[0], p[1]), ln = Math.hypot(n[0], n[1]);
      if (lp < 0.5 || ln < 0.5) continue;
      const cos = (-p[0] * n[0] - p[1] * n[1]) / (lp * ln), deg = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
      if (deg > 60) continue;   // 轉太大的不是「直直穿過去」
      if (!best || deg < best.deg) best = Object.assign({ deg, p, n, lp, ln }, c);
    }
    if (!best || best.deg < 0.5) continue;
    const d = Math.min(40, best.lp / 2, best.ln / 2);
    const q0 = [best.p[0] * d / best.lp, best.p[1] * d / best.lp], q2 = [best.n[0] * d / best.ln, best.n[1] * d / best.ln];
    let m = Math.max(2, Math.ceil(best.deg / 3)); if (m % 2) m++;   // 偶數：正中間剛好是一個點
    const curve = [];
    for (let j = 0; j <= m; j++) {
      const t = j / m, x = (1 - t) * (1 - t) * q0[0] + t * t * q2[0], y = (1 - t) * (1 - t) * q0[1] + t * t * q2[1];   // 控制點 = 接點(本地座標原點)
      curve.push([J[0] + x / kx, J[1] + y / ky]);
    }
    plans.set(id, { curve, mid: m / 2, best });
  }
  // 套用：直直穿過的路換成曲線(中間經過 → 整段曲線；前一段 → 曲線前半；下一段 → 曲線後半)，其他路的這個點移到曲線正中間
  let rounded = 0;
  for (const w of ways) {
    const ll = [], nodes = [];
    w.ll.forEach((c, i) => {
      const id = w.nodes[i], pl = id != null ? plans.get(id) : null;
      if (!pl) { ll.push(c); nodes.push(id); return; }
      const b = pl.best, cv = pl.curve, mid = pl.mid;
      const push = (from, to) => { for (let j = from; j <= to; j++) { ll.push(cv[j]); nodes.push(j === mid ? id : null); } };
      if (b.inner && b.inner.w === w && b.inner.i === i) push(0, cv.length - 1);
      else if (b.A && b.A.w === w && i === w.ll.length - 1) push(0, mid);
      else if (b.B && b.B.w === w && i === 0) push(mid, cv.length - 1);
      else { ll.push(cv[mid]); nodes.push(id); }
    });
    if (ll.length !== w.ll.length) rounded++;
    w.ll = ll; w.nodes = nodes;
  }
  return { nodes: plans.size, ways: rounded };
}

// ── 1. 車道數 ──
function inferLanes(ways) {
  const ins = new Map(), outs = new Map(), add = (m, k, w) => { if (!m.has(k)) m.set(k, []); m.get(k).push(w); };
  for (const w of ways) if (w.oneway) { add(outs, w.nodes[0], w); add(ins, w.nodes[w.nodes.length - 1], w); }
  let n = 0;
  for (let pass = 0; pass < 20; pass++) {
    let changed = 0;
    for (const id of new Set([...ins.keys(), ...outs.keys()])) {
      const I = ins.get(id) || [], O = outs.get(id) || [], all = I.concat(O), unk = all.filter((w) => !w.lanes);
      if (unk.length !== 1 || all.length < 2) continue;
      const u = unk[0], sIn = I.reduce((a, w) => a + w.lanes, 0), sOut = O.reduce((a, w) => a + w.lanes, 0);
      const v = I.length === 1 && O.length === 1 ? (u === I[0] ? O[0] : I[0]).lanes : I.includes(u) ? sOut - sIn : sIn - sOut;
      if (!(v >= 1 && v <= 6)) continue;
      u.lanes = v; changed++; n++;
    }
    if (!changed) break;
  }
  return n;
}
const lanesOf = (w) => w.lanes || (w.oneway ? (w.link ? 1 : w.cls === 'motorway' ? 3 : 2) : (w.link ? 2 : 4));

// ── 2. 對向車道推開 ──
function separate(ways) {
  const GAP = 0.8, RANGE = 40, CELL = 60;
  const mains = ways.filter((w) => w.oneway && !w.link);
  // 平面公尺(每條路用自己第一點的緯度比例；只用來量距離)
  const grid = new Map();
  for (const w of mains) {
    w._f = fOf(w.ll[0][1]); w._P = w.ll.map(chk);
    for (let i = 0; i < w._P.length - 1; i++) {
      const a = w._P[i], b = w._P[i + 1];
      for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++)
        for (let y = Math.floor(Math.min(a[1], b[1]) / CELL); y <= Math.floor(Math.max(a[1], b[1]) / CELL); y++) {
          const k = x * 100003 + y; if (!grid.has(k)) grid.set(k, []); grid.get(k).push([w, i]);
        }
    }
  }
  const shift = new Map();   // 路 → 每點往右推幾公尺
  let pushed = 0, maxPush = 0;
  for (const w of mains) {
    const P = w._P, n = P.length, need = new Array(n).fill(0), Wa = SH.widthOf({ oneway: true, link: false, lanes: lanesOf(w) });
    // 這一點(方向 t)要往右推多少才跟左邊的對向車道隔開
    const needAt = (p, t) => {
      const r = rightN(t[0], t[1]);
      let best = null;
      for (let x = Math.floor((p[0] - RANGE * w._f) / CELL); x <= Math.floor((p[0] + RANGE * w._f) / CELL); x++)
        for (let y = Math.floor((p[1] - RANGE * w._f) / CELL); y <= Math.floor((p[1] + RANGE * w._f) / CELL); y++)
          for (const [o, j] of grid.get(x * 100003 + y) || []) {
            if (o === w || Math.abs(SH.baseH(o) - SH.baseH(w)) > 0.6) continue;
            const A = o._P[j], B = o._P[j + 1], dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
            if (!L2) continue;
            const L = Math.sqrt(L2);
            if ((dx * t[0] + dy * t[1]) / L > -0.8) continue;   // 要方向相反
            const f = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2;
            if (f < 0 || f > 1) continue;
            const q = [A[0] + dx * f, A[1] + dy * f], side = (q[0] - p[0]) * r[0] + (q[1] - p[1]) * r[1];
            if (side >= 0) continue;   // 對向要在左邊
            const D = Math.hypot(q[0] - p[0], q[1] - p[1]) / w._f;   // 換回公尺
            if (D > RANGE || (best && D >= best.D)) continue;
            best = { D, o };
          }
      if (!best) return 0;
      const Wb = SH.widthOf({ oneway: true, link: false, lanes: lanesOf(best.o) });
      return Math.max(0, Math.min(6, (Wa / 2 + Wb / 2 + GAP - best.D) / 2));
    };
    // 每段每 10 公尺量一次(很長的直線段中間也要量)，一段要推多少 = 這段量到的最大值，給兩端的點
    for (let i = 0; i < n - 1; i++) {
      const A = P[i], B = P[i + 1], len = Math.hypot(B[0] - A[0], B[1] - A[1]) / w._f, t = [(B[0] - A[0]) / (len * w._f || 1), (B[1] - A[1]) / (len * w._f || 1)];
      const m = Math.max(1, Math.ceil(len / 10));
      let v = 0;
      for (let j = 0; j <= m; j++) v = Math.max(v, needAt([A[0] + (B[0] - A[0]) * j / m, A[1] + (B[1] - A[1]) * j / m], t));
      need[i] = Math.max(need[i], v); need[i + 1] = Math.max(need[i + 1], v);
    }
    if (!need.some((v) => v > 0.02)) continue;
    // 平順：前後 30 公尺取最大(該推的地方一定推夠)，再前後 60 公尺平均(慢慢過渡)
    const S = [0]; for (let i = 1; i < n; i++) S.push(S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]) / w._f);
    const mx = need.map((_, i) => { let v = 0; for (let j = 0; j < n; j++) if (Math.abs(S[j] - S[i]) <= 30) v = Math.max(v, need[j]); return v; });
    const sm = mx.map((_, i) => { let a = 0, c = 0; for (let j = 0; j < n; j++) { const d = Math.abs(S[j] - S[i]); if (d <= 60) { const wt = 1 - d / 60; a += mx[j] * wt; c += wt; } } return Math.max(need[i], a / c); });
    shift.set(w, sm);
    pushed++; maxPush = Math.max(maxPush, ...sm);
  }
  // 套用：主線每點往右推；接點(OSM 節點)記下移了多少，其他路在那個節點跟著移
  const nodeMove = new Map();
  for (const [w, sm] of shift) {
    const P = w._P, n = P.length;
    w.ll = w.ll.map((c, i) => {
      if (sm[i] < 0.005) return c;
      const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, r = rightN((b[0] - a[0]) / l, (b[1] - a[1]) / l);
      const m = merc(c[0], c[1]), k = kAt(c[1]), q = unmerc(m[0] + r[0] * sm[i] / k, m[1] + r[1] * sm[i] / k);
      const id = w.nodes[i], mv = [q[0] - c[0], q[1] - c[1]];
      if (id != null) { if (!nodeMove.has(id)) nodeMove.set(id, []); nodeMove.get(id).push(mv); }   // 沒有節點 id 的點(接點曲線上的點)不是接點
      return q;
    });
  }
  const moveOf = (id) => { const l = nodeMove.get(id); if (!l) return null; return [l.reduce((a, v) => a + v[0], 0) / l.length, l.reduce((a, v) => a + v[1], 0) / l.length]; };
  // 同一個節點每條路都移到一樣的位置(推過的主線也統一，兩條主線接在一起的地方不會錯開)
  let followed = 0;
  for (const w of ways) {
    const n = w.ll.length, orig = w._orig || w.ll;
    const moves = w.nodes.map((id) => (id == null ? null : moveOf(id)));
    if (!moves.some(Boolean)) continue;
    if (shift.has(w)) {   // 主線：節點統一成平均位置
      w.ll = w.ll.map((c, i) => (moves[i] ? [w._ll0[i][0] + moves[i][0], w._ll0[i][1] + moves[i][1]] : c));
      continue;
    }
    // 沒推的路(匝道等)：接點移過去，往裡面 100 公尺慢慢變回原位
    const S = [0]; for (let i = 1; i < n; i++) S.push(S[i - 1] + dist(orig[i - 1], orig[i]));
    const out = orig.map((c) => c.slice());
    // 每點的移動 = 附近被移的接點的加權平均(權重：100 公尺內 smoothstep)；接點本身一定剛好移到跟別條路一樣的位置
    const acc = orig.map(() => [0, 0, 0]);
    moves.forEach((mv, i) => {
      if (!mv) return;
      for (let j = 0; j < n; j++) {
        const d = Math.abs(S[j] - S[i]); if (d > 100) continue;
        const wt = 1 - d / 100, f = wt * wt * (3 - 2 * wt);
        acc[j][0] += mv[0] * f; acc[j][1] += mv[1] * f; acc[j][2] += f;
      }
    });
    for (let j = 0; j < n; j++) {
      if (moves[j]) { out[j] = [orig[j][0] + moves[j][0], orig[j][1] + moves[j][1]]; continue; }
      const wsum = Math.max(1, acc[j][2]);
      out[j] = [orig[j][0] + acc[j][0] / wsum, orig[j][1] + acc[j][1] / wsum];
    }
    w.ll = out; followed++;
  }
  unifyNodes(ways);
  return { pushed, maxPush, followed };
}
// 匝道跟同一層的路(同向或對向)平行疊在一起(OSM 畫得比實際路寬還近)：匝道往外推開，中間留 0.8 公尺
//   對方是主線：主線不動、匝道推足；對方也是匝道：各推一半
//   跟別條路共用的節點不動，離它越遠才推越多(每公尺最多 0.1 公尺)，接點附近的重疊交給交流道的槽化區
function separateLinks(ways) {
  const GAP = 0.8, RANGE = 30, CELL = 60, SLOPE = 0.1, MAXP = 10;
  const grid = new Map(), useCnt = new Map();
  // 匝道每 20 公尺補一個點(OSM 直線段很長，只推頭尾的點中間會推不夠)
  for (const w of ways) {
    if (!w.link) continue;
    const ll = [w.ll[0]], nd = [w.nodes[0]];
    for (let i = 1; i < w.ll.length; i++) {
      const a = w.ll[i - 1], b = w.ll[i], m = Math.floor(dist(a, b) / 20);
      for (let j = 1; j <= m; j++) { const f = j / (m + 1); ll.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]); nd.push(null); }
      ll.push(b); nd.push(w.nodes[i]);
    }
    w.ll = ll; w.nodes = nd;
  }
  for (const w of ways) {
    w._f = fOf(w.ll[0][1]); w._P = w.ll.map(chk);
    w.nodes.forEach((id) => { if (id != null) useCnt.set(id, (useCnt.get(id) || 0) + 1); });
    for (let i = 0; i < w._P.length - 1; i++) {
      const a = w._P[i], b = w._P[i + 1];
      for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++)
        for (let y = Math.floor(Math.min(a[1], b[1]) / CELL); y <= Math.floor(Math.max(a[1], b[1]) / CELL); y++) {
          const k = x * 100003 + y; if (!grid.has(k)) grid.set(k, []); grid.get(k).push([w, i]);
        }
    }
  }
  const W = (w) => SH.widthOf({ oneway: w.oneway, link: w.link, lanes: lanesOf(w) });
  let pushed = 0, maxPush = 0;
  const moves = [];
  for (const w of ways) {
    if (!w.link) continue;
    const P = w._P, n = P.length, Wa = W(w), need = new Array(n).fill(0);
    // 這一點(方向 t)要往右推多少(負 = 往左)
    const needAt = (p, t) => {
      const r = rightN(t[0], t[1]);
      let best = null;
      for (let x = Math.floor((p[0] - RANGE * w._f) / CELL); x <= Math.floor((p[0] + RANGE * w._f) / CELL); x++)
        for (let y = Math.floor((p[1] - RANGE * w._f) / CELL); y <= Math.floor((p[1] + RANGE * w._f) / CELL); y++)
          for (const [o, j] of grid.get(x * 100003 + y) || []) {
            if (o === w || Math.abs(SH.baseH(o) - SH.baseH(w)) > 0.6) continue;
            const A = o._P[j], B = o._P[j + 1], dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
            if (!L2) continue;
            if (Math.abs((dx * t[0] + dy * t[1]) / Math.sqrt(L2)) < 0.85) continue;   // 要平行(交叉的不算)
            const f = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2;
            if (f < 0 || f > 1) continue;
            const q = [A[0] + dx * f, A[1] + dy * f], lat = ((q[0] - p[0]) * r[0] + (q[1] - p[1]) * r[1]) / w._f;   // 對方在右邊為正
            const ov = Wa / 2 + W(o) / 2 + GAP - Math.abs(lat);
            if (ov <= 0) continue;
            const v = -Math.sign(lat || 1) * ov * (o.link ? 0.5 : 1);
            if (!best || Math.abs(v) > Math.abs(best)) best = v;
          }
      return best || 0;
    };
    for (let i = 0; i < n - 1; i++) {
      const A = P[i], B = P[i + 1], len = Math.hypot(B[0] - A[0], B[1] - A[1]) / w._f, t = [(B[0] - A[0]) / (len * w._f || 1), (B[1] - A[1]) / (len * w._f || 1)];
      const m = Math.max(1, Math.ceil(len / 10));
      for (let j = 0; j <= m; j++) {
        const v = needAt([A[0] + (B[0] - A[0]) * j / m, A[1] + (B[1] - A[1]) * j / m], t);
        if (Math.abs(v) > Math.abs(need[i])) need[i] = v;
        if (Math.abs(v) > Math.abs(need[i + 1])) need[i + 1] = v;
      }
    }
    if (!need.some((v) => Math.abs(v) > 0.05)) continue;
    const S = [0]; for (let i = 1; i < n; i++) S.push(S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]) / w._f);
    // 前後 30 公尺取(絕對值)最大，再前後 60 公尺平均
    const mx = need.map((_, i) => { let v = 0; for (let j = 0; j < n; j++) if (Math.abs(S[j] - S[i]) <= 30 && Math.abs(need[j]) > Math.abs(v)) v = need[j]; return v; });
    const sm = mx.map((_, i) => { let a = 0, c = 0; for (let j = 0; j < n; j++) { const d = Math.abs(S[j] - S[i]); if (d <= 60) { const wt = 1 - d / 60; a += mx[j] * wt; c += wt; } } return a / c; });
    // 共用節點(和頭尾)不動，離它越遠才推越多
    const fixedS = []; for (let i = 0; i < n; i++) if (i === 0 || i === n - 1 || (w.nodes[i] != null && useCnt.get(w.nodes[i]) > 1)) fixedS.push(S[i]);
    const out = sm.map((v, i) => { let d = Infinity; for (const fs of fixedS) d = Math.min(d, Math.abs(S[i] - fs)); const cap = Math.min(MAXP, d * SLOPE); return Math.max(-cap, Math.min(cap, v)); });
    if (!out.some((v) => Math.abs(v) > 0.05)) continue;
    moves.push([w, out]); pushed++; maxPush = Math.max(maxPush, ...out.map(Math.abs));
  }
  for (const [w, sm] of moves) {
    const P = w._P, n = P.length;
    w.ll = w.ll.map((c, i) => {
      if (Math.abs(sm[i]) < 0.005) return c;
      const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, r = rightN((b[0] - a[0]) / l, (b[1] - a[1]) / l);
      const m = merc(c[0], c[1]), k = kAt(c[1]);
      return unmerc(m[0] + r[0] * sm[i] / k, m[1] + r[1] * sm[i] / k);
    });
  }
  return { pushed, maxPush };
}
// 同一個 OSM 節點在每條路上的座標一定要一模一樣(差 1e-6 度手機就認不出是同一點，高度會接不起來)：
// 以「主線、路中間經過那條」的位置為準，全部統一
function unifyNodes(ways) {
  const best = new Map();
  for (const w of ways) w.nodes.forEach((id, i) => {
    if (id == null) return;
    const inner = i > 0 && i < w.ll.length - 1, rank = (w.link ? 0 : 2) + (inner ? 1 : 0), b = best.get(id);
    if (!b || rank > b.rank) best.set(id, { rank, c: w.ll[i] });
  });
  let fixed = 0;
  for (const w of ways) w.ll = w.ll.map((c, i) => { const id = w.nodes[i], b = id != null && best.get(id); if (b && (b.c[0] !== c[0] || b.c[1] !== c[1])) { fixed++; return b.c.slice(); } return c; });
  return fixed;
}
// 原始資料兩條路頭尾畫得很近(0.6 公尺內)卻不是同一個點：接起來
//   頭尾附近 0.6 公尺內的點(包括已經好幾條路接在一起的點)歸成一組，整組改成同一個位置(主線、路中間經過那條的點優先)
function snapEnds(ways) {
  const at = new Map(), K = 1e5, grid = new Map();
  for (const w of ways) w.ll.forEach((c, i) => {
    const k = key(c);
    if (!at.has(k)) { at.set(k, { c, rank: -1, list: [] }); const g = Math.floor(c[0] * K) + ',' + Math.floor(c[1] * K); if (!grid.has(g)) grid.set(g, []); grid.get(g).push(k); }
    const e = at.get(k), inner = i > 0 && i < w.ll.length - 1;
    e.list.push({ w, i }); e.rank = Math.max(e.rank, (w.link ? 0 : 2) + (inner ? 1 : 0));
  });
  const parent = new Map(), find = (k) => { while (parent.get(k) !== k) k = parent.get(k); return k; };
  for (const k of at.keys()) parent.set(k, k);
  for (const [k, e] of at) {
    if (!e.list.some((o) => o.i === 0 || o.i === o.w.ll.length - 1)) continue;   // 只處理有路的頭尾在這裡的點
    const gx = Math.floor(e.c[0] * K), gy = Math.floor(e.c[1] * K);
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (const k2 of grid.get((gx + x) + ',' + (gy + y)) || []) {
      if (k2 === k || dist(e.c, at.get(k2).c) >= 0.6) continue;
      const r1 = find(k), r2 = find(k2); if (r1 !== r2) parent.set(r1, r2);
    }
  }
  const groups = new Map();
  for (const k of at.keys()) { const r = find(k); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(k); }
  let n = 0;
  for (const ks of groups.values()) {
    if (ks.length < 2) continue;
    const rep = ks.map((k) => at.get(k)).sort((p, q) => q.rank - p.rank || (key(p.c) < key(q.c) ? -1 : 1))[0].c;
    for (const k of ks) for (const o of at.get(k).list) { o.w.ll[o.i] = rep.slice(); n++; }
  }
  return n;
}
function dist(a, b) { const A = merc(a[0], a[1]), B = merc(b[0], b[1]); return Math.hypot(B[0] - A[0], B[1] - A[1]) * kAt((a[1] + b[1]) / 2); }

// ── 3、4 用手機的畫法算每條路的路面 ──
function geometry(ways) {
  const nodeIdx = new Map();
  for (const w of ways) w.ll.forEach((c, i) => { const k = key(c); if (!nodeIdx.has(k)) nodeIdx.set(k, []); nodeIdx.get(k).push({ w, i }); });
  // 接續的路：這個點只有兩條路用，一條在這裡結束、一條在這裡開始，單行 / 雙向一樣
  const cont = (w, atEnd) => {
    const list = nodeIdx.get(key(w.ll[atEnd ? w.ll.length - 1 : 0])) || [];
    if (list.length !== 2) return null;
    const o = list.find((x) => x.w !== w);
    if (!o || o.w.oneway !== w.oneway) return null;
    if (atEnd ? o.i !== 0 : o.i !== o.w.ll.length - 1) return null;
    return o.w;
  };
  const endH = (w, i) => {
    let inner = -1, sum = 0, n = 0;
    for (const o of nodeIdx.get(key(w.ll[i])) || []) { const last = o.w.ll.length - 1; if (o.i > 0 && o.i < last) inner = Math.max(inner, SH.baseH(o.w)); else { sum += SH.baseH(o.w); n++; } }
    return inner >= 0 ? inner : n ? sum / n : SH.baseH(w);
  };
  const dirOf = (w, atEnd) => {   // 原始線第一段 / 最後一段的方向(平面公尺)
    const c = w.ll, a = atEnd ? c[c.length - 2] : c[0], b = atEnd ? c[c.length - 1] : c[1], A = merc(a[0], a[1]), B = merc(b[0], b[1]);
    const l = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1; return [(B[0] - A[0]) / l, (B[1] - A[1]) / l];
  };
  for (const w of ways) {
    w.lanesUse = lanesOf(w);
    const k = kAt(w.ll[0][1]), m0 = merc(w.ll[0][0], w.ll[0][1]), P0 = [], shared = [];
    let last = null;
    w.ll.forEach((c) => { const m = merc(c[0], c[1]), p = [(m[0] - m0[0]) * k, (m[1] - m0[1]) * k]; if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.3) { P0.push(p); shared.push((nodeIdx.get(key(c)) || []).length > 1); last = p; } });
    w.ok = P0.length >= 2;
    if (!w.ok) continue;
    const prev = cont(w, false), next = cont(w, true);
    const toL = (c) => { const m = merc(c[0], c[1]); return [(m[0] - m0[0]) * k, (m[1] - m0[1]) * k]; };
    // 接續的路：前一條倒數第二點、下一條第二點給曲線當延伸點(接縫兩邊切線一樣)
    let P = SH.curve(P0, shared, prev ? toL(prev.ll[prev.ll.length - 2]) : null, next ? toL(next.ll[1]) : null);
    // 太急的彎(轉彎半徑比路寬的一半還小，路面外緣會往回折)：那一小段再拉順，接點不動
    P = relaxSharp(P, P0.filter((_, i) => shared[i]), SH.widthOf({ oneway: w.oneway, link: w.link, lanes: lanesOf(w) }) / 2);
    w.dirB = prev ? dirOf(prev, true) : null; w.dirA = next ? dirOf(next, false) : null;   // 接續的路在接縫的方向(手機算斜接用)
    w.m0 = m0; w.k = k;   // 曲線點換回經緯度用
    const f = SH.frame(P, rightN, w.dirB, w.dirA);
    const sw = (o) => (o ? SH.widthOf({ oneway: o.oneway, link: o.link, lanes: lanesOf(o) }) : null);
    w.P = P; w.S = f.S; w.seg = f.seg; w.R = f.R;
    w.Wv = SH.widths({ oneway: w.oneway, link: w.link, lanes: w.lanesUse }, f.S, sw(prev), sw(next));
    // 原始第 i 點在曲線上的哪一點(接點不會被改成曲線，位置一模一樣)
    w.rawToP = new Map();
    let pj = 0;
    w.ll.forEach((c, i) => {
      const m = merc(c[0], c[1]), p = [(m[0] - m0[0]) * k, (m[1] - m0[1]) * k];
      for (let j = pj; j < P.length; j++) if (Math.hypot(P[j][0] - p[0], P[j][1] - p[1]) < 0.06) { w.rawToP.set(i, j); pj = j; break; }
    });
    w.hs = endH(w, 0); w.he = endH(w, w.ll.length - 1); w.bumps = w.bumps || [];
    w.H = SH.heights(f.S, SH.baseH(w), w.hs, w.he, w.bumps);
    // 比對用：換到共同座標(長度 × fc)
    const c0 = chk(w.ll[0]); w.fc = KC / k;
    w.Pc = P.map((p) => [c0[0] + p[0] * w.fc, c0[1] + p[1] * w.fc]);
  }
  return nodeIdx;
}

// 曲線上太急的地方拉順：每點用前後兩點量轉彎半徑，小於 max(半寬 × 1.3, 8 公尺) 的地方，前後 10 公尺內的點往前後點的中點靠一半，
// 重複到通過或 40 次；接點(fixedPts，原始的共用點，曲線一定通過)不動，路照樣接在一起
function relaxSharp(P, fixedPts, half) {
  const n = P.length, need = Math.max(half * 1.3, 8);
  if (n < 3) return P;
  const fixed = P.map((p) => fixedPts.some((q) => Math.abs(q[0] - p[0]) < 1e-6 && Math.abs(q[1] - p[1]) < 1e-6));
  fixed[0] = fixed[n - 1] = true;
  let Q = P.map((p) => p.slice());
  for (let pass = 0; pass < 40; pass++) {
    const S = [0]; for (let i = 1; i < n; i++) S.push(S[i - 1] + Math.hypot(Q[i][0] - Q[i - 1][0], Q[i][1] - Q[i - 1][1]));
    const bad = [];
    for (let i = 1; i < n - 1; i++) {
      // 用前後各約 3 公尺的點量(點太密時只看相鄰兩點會量不準)
      let a = i, b = i; while (a > 0 && S[i] - S[a] < 3) a--; while (b < n - 1 && S[b] - S[i] < 3) b++;
      const A = Q[a], B = Q[i], C = Q[b], ab = Math.hypot(B[0] - A[0], B[1] - A[1]), bc = Math.hypot(C[0] - B[0], C[1] - B[1]), ca = Math.hypot(A[0] - C[0], A[1] - C[1]);
      const area2 = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]));
      if (area2 > 1e-9 && ab * bc * ca / (2 * area2) < need) bad.push(i);
    }
    if (!bad.length) break;
    const mark = new Uint8Array(n);
    for (const i of bad) for (let j = i; j >= 0 && S[i] - S[j] <= 10; j--) mark[j] = 1, 0; 
    for (const i of bad) for (let j = i; j < n && S[j] - S[i] <= 10; j++) mark[j] = 1;
    const R = Q.map((p) => p.slice());
    for (let j = 1; j < n - 1; j++) if (mark[j] && !fixed[j]) R[j] = [Q[j][0] + ((Q[j - 1][0] + Q[j + 1][0]) / 2 - Q[j][0]) * 0.5, Q[j][1] + ((Q[j - 1][1] + Q[j + 1][1]) / 2 - Q[j][1]) * 0.5];
    Q = R;
  }
  return Q;
}

// ── 3. 上下交叉的淨空 ──
//   兩條路的線相交、附近沒有接點：上層 - 下層 ≥ 5.3 公尺(淨空 4.5 + 橋面版)，不夠就把上層在交叉點附近抬高(記成 bumps)
//   上下：layer 大的在上 → 是橋的在上 → 都一樣就猜(匝道在主線上、快速道路在國道上、短的在上)；兩條都是快速道路平面 → 平面路口
//   頭尾高度：接在別條路中間就照那條路「那一點實際的高度」(含抬高)，算好存起來(手機直接用)，重複到穩定
// 上下交叉：上層至少比下層高 5.3 公尺(淨空 4.5 + 橋面版)
const CLEAR = 5.3;
function clearance(ways, nodeIdx) {
  const CELL = 60, grid = new Map();
  for (const w of ways) if (w.ok) for (let i = 0; i < w.Pc.length - 1; i++) {
    const a = w.Pc[i], b = w.Pc[i + 1];
    for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++)
      for (let y = Math.floor(Math.min(a[1], b[1]) / CELL); y <= Math.floor(Math.max(a[1], b[1]) / CELL); y++) {
        const k = x * 100003 + y; if (!grid.has(k)) grid.set(k, []); grid.get(k).push([w, i]);
      }
  }
  const shares = new Map();   // 兩條路有沒有共用的點
  for (const list of nodeIdx.values()) for (const a of list) for (const b of list) if (a.w !== b.w) shares.set(a.w.id + ':' + b.w.id, true);
  // 交流道接點(好幾條路共用的點)附近 80 公尺內的交叉是匯流 / 分岔，不算
  const jgrid = new Map();
  for (const list of nodeIdx.values()) { if (list.length < 2) continue; const p = chk(list[0].w.ll[list[0].i]), g = Math.floor(p[0] / 200) * 100003 + Math.floor(p[1] / 200); if (!jgrid.has(g)) jgrid.set(g, []); jgrid.get(g).push(p); }
  const nearJ = (p) => { for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (const q of jgrid.get((Math.floor(p[0] / 200) + x) * 100003 + Math.floor(p[1] / 200) + y) || []) if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 80) return true; return false; };
  const cross = [], seen = new Set();
  for (const arr of grid.values()) for (let x = 0; x < arr.length; x++) for (let y = x + 1; y < arr.length; y++) {
    const [A, i] = arr[x], [B, j] = arr[y];
    if (A === B || shares.get(A.id + ':' + B.id)) continue;
    const p = A.Pc[i], q = A.Pc[i + 1], r = B.Pc[j], s = B.Pc[j + 1];
    const d = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0]); if (!d) continue;
    const ta = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / d, tb = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d;
    if (ta < 0 || ta > 1 || tb < 0 || tb > 1) continue;
    const kk = A.id + ':' + i + ':' + B.id + ':' + j;
    if (seen.has(kk)) continue; seen.add(kk);
    if (nearJ([p[0] + (q[0] - p[0]) * ta, p[1] + (q[1] - p[1]) * ta])) continue;
    let up;
    if (A.layer !== B.layer) up = A.layer > B.layer ? A : B;
    else if (A.bridge !== B.bridge) up = A.bridge ? A : B;
    else if (A.cls === 'trunk' && B.cls === 'trunk' && !A.bridge) continue;   // 快速道路平面路口
    else up = A.link !== B.link ? (A.link ? A : B) : A.cls !== B.cls ? (A.cls === 'trunk' ? A : B) : (A.S[A.S.length - 1] <= B.S[B.S.length - 1] ? A : B);
    const sA = A.S[i] + (A.S[i + 1] - A.S[i]) * ta, sB = B.S[j] + (B.S[j + 1] - B.S[j]) * tb;
    cross.push(up === A ? { U: A, su: sA, D: B, sd: sB } : { U: B, su: sB, D: A, sd: sA });
  }
  const hAt = (w, s) => { let k = 0; while (k < w.S.length - 2 && w.S[k + 1] < s) k++; const t = (s - w.S[k]) / ((w.S[k + 1] - w.S[k]) || 1); return w.H[k] + (w.H[k + 1] - w.H[k]) * t; };
  const redo = (w) => { w.H = SH.heights(w.S, SH.baseH(w), w.hs, w.he, w.bumps); };
  // 頭尾高度：接在別條路中間 → 那條路那一點的高度；頭尾互接 → 平均(第一版)
  const ends = () => {
    let changed = 0;
    for (const w of ways) {
      if (!w.ok) continue;
      [0, w.ll.length - 1].forEach((i) => {
        let inner = -1, sum = 0, n = 0;
        for (const o of nodeIdx.get(key(w.ll[i])) || []) {
          const last = o.w.ll.length - 1;
          if (o.i > 0 && o.i < last && o.w.ok && o.w.rawToP.has(o.i)) inner = Math.max(inner, o.w.H[o.w.rawToP.get(o.i)]);
          else { sum += SH.baseH(o.w); n++; }
        }
        const v = inner >= 0 ? inner : n ? sum / n : SH.baseH(w), key2 = i === 0 ? 'hs' : 'he';
        if (Math.abs(v - w[key2]) > 0.01) { w[key2] = v; changed++; }
      });
    }
    for (const w of ways) if (w.ok) redo(w);
    return changed;
  };
  let bumped = 0, left = 0;
  for (let pass = 0; pass < 8; pass++) {
    let raised = 0;
    for (const c of cross) {
      const need = hAt(c.D, c.sd) + CLEAR, have = hAt(c.U, c.su);
      if (have >= need - 0.02) continue;
      const fr = c.su / c.U.S[c.U.S.length - 1], ex = c.U.bumps.find((b) => Math.abs(b[0] - fr) < 1e-4);
      if (ex) ex[1] = Math.max(ex[1], need); else c.U.bumps.push([fr, need]);
      redo(c.U); raised++;
    }
    bumped += raised;
    if (!ends() && !raised) break;
  }
  for (const c of cross) if (hAt(c.U, c.su) - hAt(c.D, c.sd) < CLEAR - 0.05) left++;
  return { crossings: cross.length, bumped, left };
}

// ── 4. 交流道(第 2 階段)：分流、匯流、匝道分岔 ──
//   每個好幾條路接在一起的點：找「直直穿過去」的路(路在這點中間經過，或前一段的尾接下一段的頭、轉彎最小)，
//   其他在這裡開始 / 結束的路就是「分出去 / 併進來」的支線。分流看下游、匯流看上游的那條當「本線」。
//   沿著支線離開接點每 2 公尺量一次：支線內側路面邊緣跟本線外側路面邊緣的空隙 gap
//     gap < 0(還疊在本線上)：支線那段不畫，改成本線往那一側加寬(減速 / 加速車道)，本線那側的白線改虛線
//     0 ≤ gap < 1.5 公尺：槽化區(鋪路面＋白色斜紋＋邊線)
//     gap ≥ 1.5 公尺(槽化區尖端之後)：支線是獨立的路
//   本線那一側的護欄從接點到尖端都打開；支線靠本線那側的護欄到尖端之後才開始
//   400 公尺內都沒分開的(兩條路並排很久)：不特別處理(照一般重疊規則：護欄落在別條路上不畫)
const NOSE = 1.5;
const chkInv = (p) => unmerc(O[0] + p[0] / KC, O[1] + p[1] / KC);
function junctions(ways, nodeIdx) {
  for (const w of ways) if (w.ok) { const n = w.P.length; w.auxL = new Array(n).fill(0); w.auxR = new Array(n).fill(0); w.skip = []; w.gores = []; w.hideX = []; }
  // 這條路第 i 點(原始點)在曲線上的索引
  const pIdx = (w, i) => (w.rawToP && w.rawToP.has(i) ? w.rawToP.get(i) : (i === 0 ? 0 : w.P.length - 1));
  const dirAt = (w, k, out) => {   // 曲線第 k 點往前(out)或往後的方向(共同座標，單位向量)
    const a = out ? w.Pc[k] : w.Pc[Math.max(0, k - 1)], b = out ? w.Pc[Math.min(w.Pc.length - 1, k + 1)] : w.Pc[k];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l];
  };
  // p 投影到 w(共同座標)：{ s(公尺), lat(公尺，右正), k, t }
  const project = (w, p, hint) => {
    let best = null;
    const lo = hint == null ? 0 : Math.max(0, hint - 60), hi = hint == null ? w.Pc.length - 1 : Math.min(w.Pc.length - 1, hint + 60);
    for (let k = lo; k < hi; k++) {
      const A = w.Pc[k], B = w.Pc[k + 1], dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
      if (!L2) continue;
      const t = Math.max(0, Math.min(1, ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2));
      const qx = A[0] + dx * t, qy = A[1] + dy * t, d = Math.hypot(p[0] - qx, p[1] - qy);
      if (!best || d < best.d) best = { d, k, t, lat: ((p[0] - qx) * w.seg[k][0] + (p[1] - qy) * w.seg[k][1]) / w.fc, s: w.S[k] + (w.S[k + 1] - w.S[k]) * t };
    }
    return best;
  };
  const li = (arr, k, t) => arr[k] + (arr[Math.min(arr.length - 1, k + 1)] - arr[k]) * t;
  const lip = (P, k, t) => { const a = P[k], b = P[Math.min(P.length - 1, k + 1)]; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; };
  let count = 0, skipped = 0;
  for (const list of nodeIdx.values()) {
    if (list.length < 2) continue;
    const ents = list.filter((o) => o.w.ok && o.w.oneway);
    if (ents.length < 2) continue;
    // 直直穿過去的路
    let through = null;
    const turn = (u, v) => Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
    for (const o of ents) {
      const k = pIdx(o.w, o.i), last = o.w.P.length - 1;
      if (k > 0 && k < last) { const tv = turn(dirAt(o.w, k, false), dirAt(o.w, k, true)); if (!through || tv < through.turn) through = { turn: tv, up: { w: o.w, k }, down: { w: o.w, k } }; }
    }
    for (const a of ents) for (const b of ents) {
      if (a.w === b.w) continue;
      const ka = pIdx(a.w, a.i), kb = pIdx(b.w, b.i);
      if (ka !== a.w.P.length - 1 || kb !== 0) continue;
      const tv = turn(dirAt(a.w, ka, false), dirAt(b.w, kb, true));
      if (!through || tv < through.turn) through = { turn: tv, up: { w: a.w, k: ka }, down: { w: b.w, k: kb } };
    }
    if (!through || through.turn > Math.PI / 3) continue;
    for (const o of ents) {
      const A = o.w, kA = pIdx(A, o.i), last = A.P.length - 1;
      if (A === through.up.w || A === through.down.w) continue;
      if (kA !== 0 && kA !== last) continue;
      const diverge = kA === 0, base = diverge ? through.down : through.up;
      // 本線往下游(分流)或上游(匯流)一路接下去，最多 600 公尺(OSM 的本線常在交流道附近切成好幾段)
      const chain = [{ w: base.w, hint: base.k }];
      for (let tot = 0; chain.length < 12;) {
        const cw = chain[chain.length - 1].w, cl = cw.P.length - 1;
        tot += cw.S[cl]; if (tot > 600) break;
        const endKey = key(cw.ll[diverge ? cw.ll.length - 1 : 0]), dEnd = dirAt(cw, diverge ? cl : 0, !diverge);
        let nx = null, bt = Math.PI / 6;
        for (const o of nodeIdx.get(endKey) || []) {
          if (o.w === cw || !o.w.ok || !o.w.oneway || o.w === A || chain.some((c) => c.w === o.w)) continue;
          const ok0 = diverge ? o.i === 0 : o.i === o.w.ll.length - 1;
          if (!ok0) continue;
          const ko = diverge ? 0 : o.w.P.length - 1, tv = turn(dEnd, dirAt(o.w, ko, diverge));
          if (tv < bt) { bt = tv; nx = o.w; }
        }
        if (!nx) break;
        chain.push({ w: nx, hint: diverge ? 0 : nx.P.length - 1 });
      }
      // 每段本線上的位置 s → 離接點的距離 d(往支線那個方向為正；接點另一邊為負)
      {
        let endD = 0;
        chain.forEach((c, ci) => {
          const L = c.w.S[c.w.P.length - 1];
          if (ci === 0) { const s0 = c.w.S[base.k]; c.d = diverge ? (x) => x - s0 : (x) => s0 - x; endD = diverge ? L - s0 : s0; }
          else { const o = endD; c.d = diverge ? (x) => o + x : (x) => o + (L - x); endD += L; }
        });
      }
      const projChain = (p) => {
        let best = null;
        for (const c of chain) { const pr = project(c.w, p, c.hint); if (pr && (!best || pr.d < best.d)) { best = pr; best.c = c; } }
        if (best) best.c.hint = best.k;
        return best;
      };
      const lastW = chain[chain.length - 1].w;
      // 支線也一路接下去(OSM 的匝道也常切成好幾小段)，最多 500 公尺
      const aCh = [A];
      for (let tot = A.S[last]; tot < 500 && aCh.length < 12;) {
        const cw = aCh[aCh.length - 1], cl = cw.P.length - 1;
        const dEnd = dirAt(cw, diverge ? cl : 0, !diverge);
        let nx = null, bt = Math.PI / 6;
        for (const o of nodeIdx.get(key(cw.ll[diverge ? cw.ll.length - 1 : 0])) || []) {
          if (o.w === cw || !o.w.ok || !o.w.oneway || aCh.includes(o.w) || chain.some((c) => c.w === o.w)) continue;
          if (diverge ? o.i !== 0 : o.i !== o.w.ll.length - 1) continue;
          const tv = turn(dEnd, dirAt(o.w, diverge ? 0 : o.w.P.length - 1, diverge));
          if (tv < bt) { bt = tv; nx = o.w; }
        }
        if (!nx) break;
        aCh.push(nx); tot += nx.S[nx.P.length - 1];
      }
      // 沿支線離開接點取樣(分流往前、匯流往後)
      const samples = [];
      { let off = 0; for (const aw of aCh) { const L = aw.S[aw.P.length - 1]; for (let u = off ? 0 : 0; u <= L && off + u <= 500; u += 2) samples.push([aw, off + u, diverge ? u : L - u]); off += L; if (off > 500) break; } }
      let side = 0, sep = null, nose = null;
      const rec = [];
      for (const [Aw, u, sA] of samples) {
        let k = 0; while (k < Aw.S.length - 2 && Aw.S[k + 1] < sA) k++;
        const t = (sA - Aw.S[k]) / ((Aw.S[k + 1] - Aw.S[k]) || 1);
        const p = lip(Aw.Pc, k, t);
        const pr = projChain(p);
        if (!pr) break;
        const B = pr.c.w;
        if (B === lastW && (diverge ? (pr.k >= B.Pc.length - 2 && pr.t === 1) : (pr.k === 0 && pr.t === 0))) break;   // 超出本線
        const hA = li(Aw.Wv, k, t) / 2, hB = li(B.Wv, pr.k, pr.t) / 2;
        // 在哪一側：第一次真的分開(路面不再重疊)時在哪邊就是哪邊(接點曲線剛開始可能往反方向偏一點)
        if (!side && Math.abs(pr.lat) - hA - hB >= 0) side = pr.lat > 0 ? 1 : -1;
        const gap = (side || 1) * pr.lat - hA - hB;
        rec.push({ u, sA, k, t, p, pr, B, Aw, hA, hB, gap });
        if (sep == null && side && gap >= 0) sep = rec.length - 1;
        if (sep != null && gap >= NOSE) { nose = rec.length - 1; break; }
      }
      if (!side || sep == null || nose == null) { skipped++; continue; }
      count++;
      // 支線還疊在本線上的那段不畫；本線往那側加寬(每段本線各自算)
      const rangeOn = (aw, q0, q1) => { const ss = rec.slice(q0, q1 + 1).filter((r) => r.Aw === aw).map((r) => r.sA); return ss.length ? [Math.min(...ss), Math.max(...ss)] : null; };
      for (const aw of aCh) { const r = rangeOn(aw, 0, sep); if (r) aw.skip.push([r[0] - (r[0] < 1 ? 1 : 0), r[1] + (r[1] > aw.S[aw.P.length - 1] - 1 ? 1 : 0)]); }
      // 本線往那側加寬：要蓋住還疊在上面的支線(need)，前後每 15 公尺收 1 公尺慢慢變回原寬(減速 / 加速車道的漸變段)
      const need = [];
      for (let q = 0; q <= sep; q++) need.push([rec[q].pr.c.d(rec[q].pr.s), Math.max(0, side * rec[q].pr.lat + rec[q].hA - rec[q].hB)]);
      const TAPER = 1 / 15, envelope = (d) => { let v = 0; for (const [dq, vq] of need) v = Math.max(v, vq - TAPER * Math.abs(d - dq)); return v; };
      const vMax = Math.max(0, ...need.map((x) => x[1])), dLo = Math.min(...need.map((x) => x[0])) - vMax / TAPER, dHi = Math.max(...need.map((x) => x[0]));   // 分開之後不加寬(那裡是匝道自己的路面和槽化區)
      const segs = chain.map((c) => ({ w: c.w, d: c.d }));
      const back = diverge ? through.up : through.down;
      if (back.w !== base.w) { const bw = back.w, L = bw.S[bw.P.length - 1]; segs.push({ w: bw, d: diverge ? (x) => x - L : (x) => -x }); }
      for (const sg of segs) {
        const aux = side > 0 ? sg.w.auxR : sg.w.auxL;
        for (let k = 0; k < sg.w.P.length; k++) { const d = sg.d(sg.w.S[k]); if (d < dLo || d > dHi) continue; const v = envelope(d); if (v > aux[k]) aux[k] = v; }
      }
      for (const c of chain) {
        const B = c.w;
        // 護欄：本線那側從接點到尖端打開
        const ss = rec.slice(0, nose + 1).filter((r) => r.B === B).map((r) => r.pr.s);
        if (ss.length) B.hideX.push([side, Math.min(...ss) - 10, Math.max(...ss) + 10]);
      }
      // 槽化區：本線(沒加寬的)路面邊緣 → 支線內側路面邊緣
      const gl = [], gr = [], gz = [];
      for (let q = sep; q <= nose; q++) {
        const r = rec[q], B = r.B, kb = r.pr.k, nB = B.seg[kb], kA = r.k, Aw = r.Aw, nA = Aw.seg[kA];
        const qb = lip(B.Pc, kb, r.pr.t);
        gl.push(chkInv([qb[0] + nB[0] * side * r.hB * B.fc, qb[1] + nB[1] * side * r.hB * B.fc]));
        gr.push(chkInv([r.p[0] - nA[0] * side * r.hA * Aw.fc, r.p[1] - nA[1] * side * r.hA * Aw.fc]));
        gz.push((li(B.H, kb, r.pr.t) + li(Aw.H, kA, r.t)) / 2);
      }
      const GA = rec[sep].Aw;
      if (diverge) GA.gores.push({ l: gl, r: gr, z: gz }); else GA.gores.push({ l: gl.reverse(), r: gr.reverse(), z: gz.reverse() });
      // 支線靠本線那側到尖端之後才開始
      for (const aw of aCh) { const r = rangeOn(aw, 0, nose); if (r) aw.hideX.push([-side, diverge ? r[0] : r[0] - 5, diverge ? r[1] + 5 : r[1]]); }
    }
  }
  return { count, skipped };
}

// ── 5. 護欄落在別條路上 ──
function railHides(ways) {
  const CELL = 50, grid = new Map();
  for (const w of ways) if (w.ok) for (let i = 0; i < w.Pc.length - 1; i++) {
    const a = w.Pc[i], b = w.Pc[i + 1];
    for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++)
      for (let y = Math.floor(Math.min(a[1], b[1]) / CELL); y <= Math.floor(Math.max(a[1], b[1]) / CELL); y++) {
        const k = x * 100003 + y; if (!grid.has(k)) grid.set(k, []); grid.get(k).push([w, i]);
      }
  }
  // p(高度 h)在不在別條路的路面上(主線往左多鋪的 0.4 公尺是中央分隔底下，不算路面)
  const onDeck = (p, h, self) => {
    for (const [w, i] of grid.get(Math.floor(p[0] / CELL) * 100003 + Math.floor(p[1] / CELL)) || []) {
      if (w === self) continue;
      const A = w.Pc[i], B = w.Pc[i + 1], dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
      if (!L2) continue;
      const t = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2;
      if (t < 0 || t > 1) continue;
      const lat = ((p[0] - A[0]) * w.seg[i][0] + (p[1] - A[1]) * w.seg[i][1]) / w.fc;   // 右正(公尺)
      const hw = (w.Wv[i] + (w.Wv[i + 1] - w.Wv[i]) * t) / 2, hh = w.H[i] + (w.H[i + 1] - w.H[i]) * t;
      const aL = w.auxL ? w.auxL[i] + (w.auxL[i + 1] - w.auxL[i]) * t : 0, aR = w.auxR ? w.auxR[i] + (w.auxR[i + 1] - w.auxR[i]) * t : 0;
      const sw = w.S[i] + (w.S[i + 1] - w.S[i]) * t;
      if (w.skip && w.skip.some((r) => sw >= r[0] && sw <= r[1])) continue;   // 支線還疊在本線上、沒畫的那段
      if (lat > -hw - aL + 0.2 && lat < hw + aR - 0.2 && Math.abs(hh - h) < 0.6) return w;
    }
    return null;
  };
  let hiddenM = 0;
  for (const w of ways) {
    if (!w.ok) continue;
    const L = w.S[w.S.length - 1], rails = SH.rails({ oneway: w.oneway, link: w.link }, w.Wv), out = [];
    for (const rl of rails) {
      let cur = null;
      for (let k = 0; k < w.P.length - 1; k++) {
        const len = w.S[k + 1] - w.S[k], m = Math.max(1, Math.ceil(len / 2));
        for (let j = 0; j < m; j++) {
          const t = (j + 0.5) / m, s0 = w.S[k] + len * j / m, s1 = w.S[k] + len * (j + 1) / m;
          // 護欄位置跟著加寬的減速 / 加速車道往外移；中央護欄看中心(底寬 0.66)
          const ax = rl.side > 0 ? (w.auxR ? w.auxR[k] + (w.auxR[k + 1] - w.auxR[k]) * t : 0) : -(w.auxL ? w.auxL[k] + (w.auxL[k + 1] - w.auxL[k]) * t : 0);
          const o = rl.off(k) + (rl.off(k + 1) - rl.off(k)) * t + ax + (rl.side === 0 ? 0.33 : 0), r = w.seg[k];
          const p = [w.Pc[k][0] + (w.Pc[k + 1][0] - w.Pc[k][0]) * t + r[0] * o * w.fc, w.Pc[k][1] + (w.Pc[k + 1][1] - w.Pc[k][1]) * t + r[1] * o * w.fc];
          const h = w.H[k] + (w.H[k + 1] - w.H[k]) * t;
          const on = onDeck(p, h, w);
          const sm = (s0 + s1) / 2, planned = (w.skip || []).some((r) => sm >= r[0] && sm <= r[1]) || (w.hideX || []).some((x) => (x[0] === -1 && !w.link && w.oneway ? 0 : x[0]) === rl.side && sm >= x[1] && sm <= x[2]);
          if (on) { if (cur && Math.abs(cur[1] - s0) < 1e-6) cur[1] = s1; else { cur = [s0, s1]; out.push([rl.side, cur]); } if (!planned) hiddenM += s1 - s0; }
          else cur = null;
        }
      }
    }
    // 存成「占整條的比例 × 1e6」(手機每條路的比例尺跟電腦差一點點，用比例就一模一樣)
    // 交流道：本線那側、支線靠本線那側在槽化區前不畫(junctions 算好的)
    // 主線左邊是中央護欄(邊 0)
    (w.hideX || []).forEach((x) => out.push([x[0] === -1 && !w.link && w.oneway ? 0 : x[0], [Math.max(0, x[1]), Math.min(L, x[2])]]));
    w.hide = out.map(([side, r]) => [side, Math.round(r[0] / L * 1e6), Math.round(r[1] / L * 1e6)]);
  }
  return { hiddenKm: hiddenM / 1000 };
}

// ── 6. 中央分隔島(上下行同高度的地方) ──
//   每條主線每點找左邊的對向車道，量兩邊路面之間的空隙(前後平均，不會忽大忽小)：
//     空隙 5 公尺內：id 小的那條負責畫，立在空隙正中間、空隙鋪滿，另一條那段不畫自己的中央護欄
//       空隙不夠(< 1.32 公尺)或在橋上 → 一道護欄(兩面斜角)＋防眩板
//       空隙夠 → 固定寬度的花台：兩道護欄＋中間樹籬，不裝防眩板
//       一道 ↔ 兩道：split 0～1 在 30 公尺內慢慢變，兩道護欄斜斜地分開 / 合起來
//     空隙 5～30 公尺(在地面)：兩道護欄＋防眩板照舊，中間鋪草
const HEDGE_MAX = 5, MED_MAX = 30, PLANTER_MIN = 1.32;
function medians(ways) {
  const CELL = 50, grid = new Map();
  const mains = ways.filter((w) => w.ok && w.oneway && !w.link);
  for (const w of mains) for (let i = 0; i < w.Pc.length - 1; i++) {
    const a = w.Pc[i], b = w.Pc[i + 1];
    for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++)
      for (let y = Math.floor(Math.min(a[1], b[1]) / CELL); y <= Math.floor(Math.max(a[1], b[1]) / CELL); y++) {
        const k = x * 100003 + y; if (!grid.has(k)) grid.set(k, []); grid.get(k).push([w, i]);
      }
  }
  let drawM = 0, hedgeM = 0;
  for (const A of mains) {
    const n = A.P.length, mode = new Array(n).fill(0), gapV = new Array(n).fill(0);
    for (let k = 0; k < n; k++) {
      const sk = Math.min(k, n - 2), r = A.seg[sk], dir = [-r[1], r[0]], p = A.Pc[k];   // seg = 右手方向 → 前進方向
      const hwA = A.Wv[k] / 2 + (A.auxL ? A.auxL[k] : 0);
      let best = null;
      const R0 = 25 * A.fc;
      for (let x = Math.floor((p[0] - R0) / CELL); x <= Math.floor((p[0] + R0) / CELL); x++)
        for (let y = Math.floor((p[1] - R0) / CELL); y <= Math.floor((p[1] + R0) / CELL); y++)
          for (const [B, j] of grid.get(x * 100003 + y) || []) {
            if (B === A) continue;
            const P0 = B.Pc[j], P1 = B.Pc[j + 1], dx = P1[0] - P0[0], dy = P1[1] - P0[1], L2 = dx * dx + dy * dy;
            if (!L2) continue;
            if ((dx * dir[0] + dy * dir[1]) / Math.sqrt(L2) > -0.8) continue;   // 要方向相反
            const t = ((p[0] - P0[0]) * dx + (p[1] - P0[1]) * dy) / L2;
            if (t < 0 || t > 1) continue;
            const q = [P0[0] + dx * t, P0[1] + dy * t], lat = ((q[0] - p[0]) * r[0] + (q[1] - p[1]) * r[1]) / A.fc;
            if (lat >= 0) continue;   // 對向要在左邊
            const hB = B.H[j] + (B.H[j + 1] - B.H[j]) * t;
            if (Math.abs(hB - A.H[k]) > 0.6) continue;
            const hwB = (B.Wv[j] + (B.Wv[j + 1] - B.Wv[j]) * t) / 2 + (B.auxL ? B.auxL[j] + (B.auxL[j + 1] - B.auxL[j]) * t : 0);
            const gap = -lat - hwA - hwB;
            if (!best || -lat < best.d) best = { d: -lat, gap, B };
          }
      if (best && best.gap <= MED_MAX && best.gap >= -1) {
        const own = A.id < best.B.id, ground = A.H[k] < 1;
        if (best.gap <= (ground ? HEDGE_MAX : 1.2)) { mode[k] = own ? 2 : -2; gapV[k] = Math.max(0, best.gap); }
        else if (own && ground) { mode[k] = 1; gapV[k] = best.gap; }
      }
    }
    // 去掉一兩點的跳動(前後 2 點多數決)
    const m2 = mode.map((v, k) => { const c = { '2': 0, '-2': 0, '1': 0, '0': 0 }; for (let j = Math.max(0, k - 2); j <= Math.min(n - 1, k + 2); j++) c[mode[j]]++; return +Object.keys(c).sort((a, b) => c[b] - c[a])[0]; });
    // 中間那道 / 花台的空隙：前後 40 公尺平均(不會忽大忽小)；split：空隙夠、在地面 → 1，前後 15 公尺平均(30 公尺內斜斜變過去)
    const gS = gapV.map((_, k) => { if (m2[k] !== 2) return gapV[k]; let a = 0, c = 0; for (let j = k; j >= 0 && A.S[k] - A.S[j] <= 40; j--) if (m2[j] === 2) { a += gapV[j]; c++; } for (let j = k + 1; j < n && A.S[j] - A.S[k] <= 40; j++) if (m2[j] === 2) { a += gapV[j]; c++; } return a / c; });
    const want = gS.map((g, k) => (m2[k] === 2 && A.H[k] < 1 && g >= PLANTER_MIN ? 1 : 0));
    const split = want.map((_, k) => { let a = 0, c = 0; for (let j = k; j >= 0 && A.S[k] - A.S[j] <= 15; j--) { a += want[j]; c++; } for (let j = k + 1; j < n && A.S[j] - A.S[k] <= 15; j++) { a += want[j]; c++; } return a / c; });
    // 存成段落：草地 [起, 迄, 起點空隙, 迄點空隙]、中間那道 / 花台 [起, 迄, 起點空隙, 迄點空隙, 起點 split, 迄點 split](每段最多 25 公尺)、不畫 [起, 迄]
    const L = A.S[n - 1];
    A.medC = []; A.medH = []; A.medS = [];
    for (let k = 0; k < n - 1;) {
      const v = m2[k];
      let e = k + 1;
      while (e < n - 1 && m2[e] === v && (v <= 0 || A.S[e] - A.S[k] < 25)) e++;
      if (v === 1) { A.medC.push([A.S[k], A.S[e], gapV[k], m2[e] === 1 ? gapV[e] : gapV[e - 1]]); drawM += A.S[e] - A.S[k]; }
      else if (v === 2) { A.medH.push([A.S[k], A.S[e], gS[k], m2[e] === 2 ? gS[e] : gS[e - 1], split[k], split[e]]); hedgeM += (A.S[e] - A.S[k]) * (split[k] + split[e]) / 2; }   // 段落最後一點不是這種：空隙沿用前一點
      else if (v === -2) A.medS.push([A.S[k], A.S[e]]);
      k = e;
    }
    void L;
  }
  return { grassKm: drawM / 1000, hedgeKm: hedgeM / 1000 };
}

// opts.lanesDone：車道數已經推過了(第 1 階段先用全部的路推車道數，再只拿主線來做)
function run(ways, opts) {
  const lanes = opts && opts.lanesDone ? 0 : inferLanes(ways);
  const jitter = cleanJitter(ways);
  const round = roundNodes(ways);
  unifyNodes(ways);
  for (const w of ways) w._ll0 = w.ll.map((c) => c.slice());
  for (const w of ways) w._orig = w.ll;
  const sep = separate(ways);
  const sepL = separateLinks(ways);
  for (const w of ways) w.ll = w.ll.map((c) => [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6]);
  snapEnds(ways);   // 跟手機拿到的座標一樣(1e-6 度)
  const nodeIdx = geometry(ways);
  const clr = clearance(ways, nodeIdx);
  const junc = junctions(ways, nodeIdx);
  const hide = railHides(ways);
  const med = medians(ways);
  return { lanes, jitter, round, sep, sepL, clr, junc, hide, med };
}

module.exports = { CLEAR, lanesOf, unmerc, run, roundNodes, inferLanes, separate, geometry, clearance, railHides };
