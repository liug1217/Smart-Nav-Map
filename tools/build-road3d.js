// 產生 3D 道路資料(第 2 版引擎)：全台國道、快速道路、匝道。計算全部在電腦上做(tools/road3d2/)，手機(road_3d.js)只負責畫。
//
// 流程：路網(接成完整的路、等弧長取點、最小轉彎半徑) → 高度(橋 6 公尺、淨空 4.5 公尺) → 橫斷面 → 中央分隔島(共用走廊中心線) →
//       自動檢查(沒過的路不產生，超過 0.5% 整批停) → 槽化區 → 路面網格(重疊裁切、三角化) → 護欄、橋墩 → 切圖磚
//
// 資料來源：OpenStreetMap(Overpass API，要 out body geom 才有節點 id)。公開伺服器常常掛掉，所以先下載存檔再產生：
//   查詢：way[highway~"^(motorway|motorway_link|trunk|trunk_link)$"](南,西,北,東);out body geom qt;
//   目前存檔：C:\SmartNavData\road3d-src\
//
// 用法：先在 tools 資料夾 npm install(只在電腦上用的套件：polygon-clipping、earcut)
//       node --max-old-space-size=8192 tools/build-road3d.js <下載結果.json>
//
// 輸出：
//   road3d/index.json    有資料的圖磚 ["x_y", ...]
//   road3d/report.json   自動檢查報告(沒過的路、原因、位置)
//   road3d/13/x_y.json   { f: 3, o: [經度, 緯度](圖磚中心), d: 路面網格, p: 護欄路段, q: 橋墩, nd: 節點, ch: 路 }
//   座標是以圖磚中心為原點的地面公尺 × 100 的整數：x 往東、y 往南、z 往上(格式見下面的註解)

'use strict';

const fs = require('fs');
const path = require('path');
const G = require('./road3d2/geom');
const N = require('./road3d2/network');
const H = require('./road3d2/heights');
const K = require('./road3d2/corridor');
const D = require('./road3d2/deck');
const R = require('./road3d2/gore');
const F = require('./road3d2/features');
const V = require('./road3d2/validate');

const Z = 13;
const src = process.argv[2];
if (!src) { console.error('用法：node tools/build-road3d.js <overpass.json>'); process.exit(1); }
const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
const elements = Array.isArray(raw.elements) ? raw.elements : [].concat(...Object.values(raw));

let t0 = Date.now();
const lap = (name) => { console.log(`  ${name}  ${((Date.now() - t0) / 1000).toFixed(1)} 秒`); t0 = Date.now(); };
const chains = N.buildChains(N.parseWays(elements));
chains.forEach(N.prepChain);
const sm = N.smoothChains(chains);
lap(`路網：${chains.length} 條(太急的彎平滑 ${sm.smoothed} 條，平滑不完 ${sm.failed} 條)`);
const hr = H.computeHeights(chains);
lap(`高度：交叉 ${hr.crossings.length} 處`);
chains.forEach(K.sections);
const runs = K.corridors(chains);
lap(`中央分隔島：走廊 ${runs.length} 段`);
const check = V.validate(chains, runs, hr.crossings);
lap(`自動檢查：${check.failedChains} 條路有路段沒過，排除 ${check.badKm.toFixed(2)} / ${check.totalKm.toFixed(0)} 公里(${(check.ratio * 100).toFixed(3)}%)`);

const outDir = path.join(__dirname, '..', 'road3d');
const report = {
  generated: new Date().toISOString(), source: path.basename(src), total: check.total, failedChains: check.failedChains,
  excludedKm: +check.badKm.toFixed(3), totalKm: +check.totalKm.toFixed(1), ratio: +check.ratio.toFixed(5), limit: V.LIMIT, aborted: check.abort,
  counts: check.failures.reduce((m, f) => { m[f.check] = (m[f.check] || 0) + 1; return m; }, {}),
  failures: check.failures,
  warnings: check.warnings.slice(0, 300),   // 提醒(不排除)：曲率突然跳的地方，原始資料比較亂
  warningCount: check.warnings.length,
};
if (check.abort) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
  console.error(`✖ 排除的路段超過全台道路總長的 ${V.LIMIT * 100}%，整批停止(舊資料保留)。報告：road3d/report.json ` + JSON.stringify(report.counts));
  process.exit(2);
}

const goreRes = R.gores(chains, hr.nodes);
lap(`槽化區：${goreRes.count} 處`);
const blocks = D.makeBlocks(chains, goreRes.fills);
const clip = D.clipBlocks(blocks);
const meshes = D.triangulate(blocks);
lap(`路面：${blocks.length} 塊，裁切 ${clip.clipped}(失敗 ${clip.failed})`);
const covered = F.makeCover(chains);
for (const ch of chains) { ch.R = F.features(ch, covered); ch.piers = F.piers(ch); }
lap('護欄、橋墩');

// ── 圖磚 ──
const tileOf = (X, Y) => {
  const [lon, lat] = G.unmerc(X, Y), r = lat * Math.PI / 180;
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
    const o = tileCenter(key), M = G.merc(o[0], o[1]);
    tiles.set(key, { key, o, X0: M[0], Y0: M[1], k0: G.kAtY(M[1]), dv: [], da: [], dg: [], di: [], p: [], q: [], nd: [], ch: [], chIdx: new Map() });
  }
  return tiles.get(key);
};
const cm = (m) => Math.round(m * 100);
const local = (T, X, Y) => [cm((X - T.X0) * T.k0), cm(-(Y - T.Y0) * T.k0)];
const chainIdx = (T, ch) => {
  if (!T.chIdx.has(ch.id)) { T.chIdx.set(ch.id, T.ch.length); T.ch.push([ch.id, ch.link ? 1 : 0, ch.oneway ? 1 : 0]); }
  return T.chIdx.get(ch.id);
};
const delta = (arr, stride) => { const out = arr.slice(); for (let i = out.length - 1; i >= stride; i--) out[i] -= arr[i - stride]; return out; };
const perVertex = (vals) => (vals.every((x) => x === vals[0]) ? vals[0] : delta(vals, 1));

// 路面網格：每個三角形放到中心所在的圖磚
//   d：二進位(base64)陣列，每點 x、y(Int32 公分)、z、u(Int16 公分)、S(Int32 公寸)、路(Int16)；i 三角形索引(Uint16 或 Uint32)
//      g = 槽化區的點 [[點, gu, g0, g1](公分)](只有少數點有，另外存)；車道外緣 a、b 手機用路段資料(p.e)查
let triCount = 0;
for (const m of meshes) {
  const seen = new Map();   // (圖磚, 原頂點) → 圖磚裡的索引
  for (let t = 0; t < m.tris.length; t += 3) {
    const vs = [m.verts[m.tris[t]], m.verts[m.tris[t + 1]], m.verts[m.tris[t + 2]]];
    const T = tile(tileOf((vs[0].X + vs[1].X + vs[2].X) / 3, (vs[0].Y + vs[1].Y + vs[2].Y) / 3));
    for (let q = 0; q < 3; q++) {
      const vi = m.tris[t + q], key = T.key + ':' + vi;
      if (!seen.has(key)) {
        const v = vs[q], [x, y] = local(T, v.X, v.Y);
        seen.set(key, T.dv.length / 3);
        const vi2 = T.dv.length / 3;
        T.dv.push(x, y, cm(v.z));
        T.da.push(cm(v.u), Math.round(v.S * 10), chainIdx(T, v.ch));
        if (v.g0 || v.g1) T.dg.push([vi2, cm(v.gu), cm(v.g0), cm(v.g1)]);   // 槽化區(含前後寬度 0 的過渡點)
      }
      T.di.push(seen.get(key));
    }
    triCount++;
  }
}
// 護欄路段：路(減點後)的每一段放到中點所在的圖磚，連續同一塊的合成一個路段；頭尾多帶一點(算方向用)
//   p: { c: 路, v: [x, y, z](差值), n: [nx, ny](法向量 × 10000，直接存，前後圖磚接縫完全一樣), s: [沿路距離 cm](差值),
//        e: [eL, eR, a, b](路面左右緣、最左右車道外緣), R: [{ t, sd, o, o2?, v: [s0, s1, ...] }], pre, post }
//   q(橋墩): [x, y, 頂高, 寬, 切線 x × 10000, 切線 y × 10000]
//   nd(節點): [OSM 節點 id, 路, 沿路距離(公寸)]
for (const ch of chains) {
  const K2 = ch.keep, P = ch.g.P;
  const mid = (j) => { const a = P[K2[j]], b = P[K2[j + 1]]; return tileOf((a[0] + b[0]) / 2, (a[1] + b[1]) / 2); };
  let j0 = 0;
  for (let j = 0; j < K2.length - 1; j++) {
    const key = mid(j), nextKey = j + 1 < K2.length - 1 ? mid(j + 1) : null;
    if (nextKey !== key) { const T = tile(key); T.p.push(encodePiece(T, ch, j0, j + 1)); j0 = j + 1; }
  }
  for (const pr of ch.piers) {
    const n = G.normalOf(ch.g.T[pr.i]), k = G.kAtY(pr.P[1]), c = [pr.P[0] + n[0] * pr.off / k, pr.P[1] + n[1] * pr.off / k];
    const T = tile(tileOf(c[0], c[1])), [x, y] = local(T, c[0], c[1]);
    T.q.push([x, y, cm(pr.z), cm(pr.w), Math.round(ch.g.T[pr.i][0] * 10000), Math.round(-ch.g.T[pr.i][1] * 10000)]);
  }
  ch.node.forEach((id, i) => {
    if (id == null) return;
    const T = tile(tileOf(P[i][0], P[i][1]));
    T.nd.push([id, chainIdx(T, ch), Math.round(ch.g.S[i] * 10)]);
  });
}
function encodePiece(T, ch, ja, jb) {
  const K2 = ch.keep, lo = Math.max(0, ja - 1), hi = Math.min(K2.length - 1, jb + 1), idx = [];
  for (let j = lo; j <= hi; j++) idx.push(K2[j]);
  const xyz = [], nrm = [];
  idx.forEach((i) => {
    const [x, y] = local(T, ch.g.P[i][0], ch.g.P[i][1]);
    xyz.push(x, y, cm(ch.z[i]));
    const n = G.normalOf(ch.g.T[i]);
    nrm.push(Math.round(n[0] * 10000), Math.round(-n[1] * 10000));   // y 往南
  });
  const sMin = ch.g.S[K2[ja]], sMax = ch.g.S[K2[jb]];
  const clip = (vis) => { const out = []; for (const r of vis) { const a = Math.max(r[0], sMin), b = Math.min(r[1], sMax); if (b - a > 0.05) out.push(cm(a), cm(b)); } return out; };
  const offs = (fn) => perVertex(idx.map((i) => cm(fn(i))));
  const Rs = [];
  for (const r of ch.R) {
    const vis = clip(r.vis);
    if (!vis.length) continue;
    const item = { t: r.t, sd: r.side, o: offs(r.off), v: vis };
    if (r.off2) item.o2 = offs(r.off2);
    Rs.push(item);
  }
  return { c: chainIdx(T, ch), v: delta(xyz, 3), n: nrm, s: delta(idx.map((i) => cm(ch.g.S[i])), 1),
    e: [offs((i) => ch.eL[i]), offs((i) => ch.eR[i]), offs((i) => ch.a[i]), offs((i) => ch.b[i])], R: Rs, pre: lo < ja ? 1 : 0, post: hi > jb ? 1 : 0 };
}

// 接縫檢查：同一條路被切到不同圖磚，接縫兩邊存的法向量要一樣(差 < 0.5 度)
{
  const ends = new Map();   // 路 id → [{ s, n }]
  for (const T of tiles.values()) for (const p of T.p) {
    const gid = T.ch[p.c][0], s = []; let acc = 0; for (const x of p.s) { acc += x; s.push(acc); }
    const list = ends.get(gid) || []; ends.set(gid, list);
    for (let k = 0; k < s.length; k++) list.push({ s: s[k], n: [p.n[k * 2], p.n[k * 2 + 1]] });
  }
  let seams = 0, bad = 0;
  for (const [gid, list] of ends) {
    list.sort((a, c) => a.s - c.s);
    for (let k = 1; k < list.length; k++) {
      if (list[k].s !== list[k - 1].s) continue;   // 同一點出現在兩塊圖磚 = 接縫
      seams++;
      const a = list[k - 1].n, c = list[k].n;
      const cos = (a[0] * c[0] + a[1] * c[1]) / (Math.hypot(a[0], a[1]) * Math.hypot(c[0], c[1]) || 1);   // 存成整數後長度不一定剛好 10000，要除以實際長度
      const deg = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
      if (deg >= 0.5) { bad++; report.failures.push({ check: 'seam', chain: gid, detail: { deg: +deg.toFixed(3) } }); }
    }
  }
  report.seams = { checked: seams, bad };
  lap(`接縫檢查：${seams} 處，沒過 ${bad} 處`);
}
const outTmp = outDir + '.tmp';
fs.rmSync(outTmp, { recursive: true, force: true });
fs.mkdirSync(path.join(outTmp, String(Z)), { recursive: true });
let bytes = 0;
for (const T of tiles.values()) {
  const nv = T.dv.length / 3, b64 = (Arr, fn) => { const a = new Arr(nv); for (let i = 0; i < nv; i++) a[i] = fn(i); return Buffer.from(a.buffer).toString('base64'); };
  const idx = T.dv.length / 3 > 65535 ? new Uint32Array(T.di) : new Uint16Array(T.di);
  const deck = { n: nv, x: b64(Int32Array, (i) => T.dv[i * 3]), y: b64(Int32Array, (i) => T.dv[i * 3 + 1]), z: b64(Int16Array, (i) => T.dv[i * 3 + 2]),
    u: b64(Int16Array, (i) => T.da[i * 3]), s: b64(Int32Array, (i) => T.da[i * 3 + 1]), c: b64(Int16Array, (i) => T.da[i * 3 + 2]),
    i: Buffer.from(idx.buffer).toString('base64'), it: idx instanceof Uint32Array ? 32 : 16, g: T.dg };
  const s = JSON.stringify({ f: 3, o: T.o.map((x) => +x.toFixed(7)), d: deck, p: T.p, q: T.q, nd: T.nd, ch: T.ch });
  bytes += s.length;
  fs.writeFileSync(path.join(outTmp, String(Z), T.key + '.json'), s);
}
fs.writeFileSync(path.join(outTmp, 'index.json'), JSON.stringify([...tiles.keys()].sort()));
fs.writeFileSync(path.join(outTmp, 'report.json'), JSON.stringify(report, null, 1));
// 全部寫好才換掉舊資料(中途失敗不會留下一半)
fs.rmSync(outDir, { recursive: true, force: true });
try { fs.renameSync(outTmp, outDir); }
catch (e) {   // Windows 上資料夾被鎖住(OneDrive 同步、開著的伺服器)時改名會失敗：改用複製
  fs.cpSync(outTmp, outDir, { recursive: true });
  fs.rmSync(outTmp, { recursive: true, force: true });
}
lap(`輸出：圖磚 ${tiles.size} 塊、三角形 ${triCount}、共 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`排除路段 ${check.badKm.toFixed(2)} 公里(${(check.ratio * 100).toFixed(3)}%)：` + JSON.stringify(report.counts) + `，提醒 ${report.warningCount} 條`);
