// 產生 3D 道路資料(road3d/)：全台國道、快速道路、匝道。計算全部在這裡做完(見 tools/road3d-core.js)，
// 手機(road_3d.js)只負責把算好的路面、標線、護欄、槽化線畫出來。
//
// 資料來源：OpenStreetMap(Overpass API)，要 out body geom(有節點 id，才知道哪些路接在一起)。
// 公開的 Overpass 伺服器常常很慢或掛掉，所以先下載一次存成檔案再來產生。
//   查詢：way[highway~"^(motorway|motorway_link|trunk|trunk_link)$"](南,西,北,東);out body geom qt;
//
// 用法：node tools/build-road3d.js <下載結果.json>
//   下載結果：{ "任意 key": [Overpass elements...], ... }(分區下載後合併)，或直接是一份 Overpass 回應
//
// 輸出(zoom 13 圖磚，一塊約 4.9 公里)：
//   road3d/index.json   有資料的圖磚 ["x_y", ...]
//   road3d/13/x_y.json  { f: 2, o: [經度, 緯度](圖磚中心), p: [路段...], g: [槽化線四邊形...], c: [圓形路面...] }
//   座標是以圖磚中心為原點的地面公尺 × 100 的整數：x 往東、y 往南、z 往上；格式見 encodePiece

'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./road3d-core');

const Z = 13;
const src = process.argv[2];
if (!src) { console.error('用法：node tools/build-road3d.js <overpass.json>'); process.exit(1); }
const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
const elements = Array.isArray(raw.elements) ? raw.elements : [].concat(...Object.values(raw));

const t0 = Date.now();
const ways = C.parseWays(elements);
const chains = C.buildChains(ways);
chains.forEach(C.prepChain);
C.heights(chains);
chains.forEach(C.sections);
C.medians(chains);
const covered = C.makeCover(chains);
chains.forEach((ch) => { ch.feat = C.features(ch, covered); });
const goreList = C.gores(chains);
console.log(`道路 ${ways.length} 條 → 接成 ${chains.length} 條，計算 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

// ── 圖磚 ──
const tileOf = (X, Y) => {
  const [lon, lat] = C.unmerc(X, Y), r = lat * Math.PI / 180;
  return Math.floor((lon + 180) / 360 * 2 ** Z) + '_' + Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** Z);
};
const tileCenter = (key) => {
  const [x, y] = key.split('_').map(Number), n = 2 ** Z;
  const lon = (x + 0.5) / n * 360 - 180, yy = Math.PI - 2 * Math.PI * (y + 0.5) / n;
  return [lon, 180 / Math.PI * Math.atan(0.5 * (Math.exp(yy) - Math.exp(-yy)))];
};
const tiles = new Map();
const tile = (key) => {
  if (!tiles.has(key)) {
    const o = tileCenter(key), M = C.merc(o[0], o[1]);
    tiles.set(key, { key, o, X0: M[0], Y0: M[1], k0: C.cosAtY(M[1]), p: [], g: [], c: [] });
  }
  return tiles.get(key);
};
const cm = (m) => Math.round(m * 100);
const local = (T, X, Y) => [cm((X - T.X0) * T.k0), cm(-(Y - T.Y0) * T.k0)];
// 數列存成差值(檔案小很多)
const delta = (arr, stride) => { const out = arr.slice(); for (let i = out.length - 1; i >= stride; i--) out[i] -= arr[i - stride]; return out; };
// 每點的值全部一樣就只存一個數
const perVertex = (vals) => (vals.every((x) => x === vals[0]) ? vals[0] : delta(vals, 1));

// 一條路切成圖磚：每一段(相鄰兩點)放到中點所在的圖磚，連續同一塊的合成一個路段；頭尾多帶一點(算斷面方向用，前後兩塊算出來才會一樣)
for (const ch of chains) {
  const v = ch.v, n = v.length;
  // 直路上的點拿掉(誤差 3 公分內)；keep = 留下的原始索引，下面的 a、b 都是 keep 裡的位置
  const keep = C.simplifyIdx(ch, 0.03), K = keep.length;
  const mid = (j) => { const p = v[keep[j]].P, q = v[keep[j + 1]].P; return tileOf((p[0] + q[0]) / 2, (p[1] + q[1]) / 2); };
  let j0 = 0;
  for (let j = 0; j < K - 1; j++) {
    const key = mid(j), nextKey = j + 1 < K - 1 ? mid(j + 1) : null;
    if (nextKey !== key) { tile(key).p.push(encodePiece(tile(key), ch, keep, j0, j + 1)); j0 = j + 1; }
  }
  // 頭尾圓形路面(分岔、匯流處接縫平順)
  [0, n - 1].forEach((i) => {
    const o = v[i], T = tile(tileOf(o.P[0], o.P[1])), [x, y] = local(T, o.P[0], o.P[1]);
    T.c.push([x, y, cm(o.z + 0.03), cm((o.eR - o.eL) / 2), cm((o.eL + o.eR) / 2)]);
  });
}
// 路段格式：
//   v  [x, y, z, ...]   點(差值)，pre / post = 頭 / 尾多帶的那一點(只用來算方向，不畫)
//   s  [...]            每點沿路距離(差值)：虛線、看得到的區間都用這個
//   e  [eL, a, b, eR]   路面左緣、最左車道外緣、最右車道外緣、路面右緣(每項是數字或每點的差值數列)
//   L  標線 [{ t: 顏色, w: 寬, d: 虛線, o: 偏移, v: 看得到的區間 [s0, s1, s0, s1, ...] }]
//   R  護欄 [{ t: wb 鋼板 / nj 紐澤西 / pp 橋上混凝土 / ag 防眩板 / hg 分隔島灌木(o 到 o2 之間), sd: 往哪邊長, o, v }]
function encodePiece(T, ch, keep, ja, jb) {
  const v = ch.v, lo = Math.max(0, ja - 1), hi = Math.min(keep.length - 1, jb + 1);
  const idx = []; for (let j = lo; j <= hi; j++) idx.push(keep[j]);
  const a = keep[ja], b = keep[jb];
  const xyz = [];
  idx.forEach((i) => { const [x, y] = local(T, v[i].P[0], v[i].P[1]); xyz.push(x, y, cm(v[i].z)); });
  const sMin = v[a].S, sMax = v[b].S;
  const clip = (runs) => {
    const out = [];
    for (const r of runs) { const s0 = Math.max(r[0], sMin), s1 = Math.min(r[1], sMax); if (s1 - s0 > 0.05) out.push(cm(s0), cm(s1)); }
    return out;
  };
  const offs = (fn) => perVertex(idx.map((i) => cm(fn(i))));
  const L = [], R = [];
  for (const l of ch.feat.lines) { const vis = clip(l.vis); if (vis.length) L.push({ t: l.t, w: cm(l.w), d: l.dash, o: offs(l.off), v: vis }); }
  for (const r of ch.feat.rails) {
    const vis = clip(r.vis);
    if (!vis.length) continue;
    const item = { t: r.t, sd: r.side, o: offs(r.off), v: vis };
    if (r.off2) item.o2 = offs(r.off2);   // 灌木：另一邊的邊緣
    R.push(item);
  }
  return {
    v: delta(xyz, 3), pre: lo < ja ? 1 : 0, post: hi > jb ? 1 : 0,
    s: delta(idx.map((i) => cm(v[i].S)), 1),
    e: [offs((i) => v[i].eL), offs((i) => v[i].a), offs((i) => v[i].b), offs((i) => v[i].eR)],
    lk: v.some((o) => o.link) ? 1 : 0, ow: ch.oneway ? 1 : 0,
    L, R,
  };
}
// 槽化線：放在第一個點所在的圖磚
for (const g of goreList) {
  for (const q of C.goreQuads(g)) {
    const T = tile(tileOf(q[0][0], q[0][1]));
    const flat = [];
    q.forEach((p) => { const [x, y] = local(T, p[0], p[1]); flat.push(x, y, cm(p[2])); });
    T.g.push(flat);
  }
}

const outDir = path.join(__dirname, '..', 'road3d');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, String(Z)), { recursive: true });
let bytes = 0;
for (const T of tiles.values()) {
  const s = JSON.stringify({ f: 2, o: T.o.map((x) => +x.toFixed(7)), p: T.p, g: T.g, c: T.c });
  bytes += s.length;
  fs.writeFileSync(path.join(outDir, String(Z), T.key + '.json'), s);
}
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify([...tiles.keys()].sort()));
console.log(`圖磚 ${tiles.size} 塊、共 ${(bytes / 1024 / 1024).toFixed(1)} MB、槽化區 ${goreList.length} 處，總共 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
