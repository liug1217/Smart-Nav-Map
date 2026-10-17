// 產生 3D 道路資料(road3d/)。第 3 階段(真的高架)：國道、快速道路的主線＋匝道、交流道(分流、匯流、槽化區)
// 電腦把全部都算好，手機(road_3d.js)只照著畫：
//   1. 讀 OpenStreetMap 的國道、快速道路(主線＋匝道)；車道數沒標的用接點車道數守恆推
//   2. 同一個點每條路的座標統一、很近的頭尾接起來；接點、接縫先改成曲線
//   3. 對向車道疊在一起：兩個方向各往外推一半，中間留 0.8 公尺放中央護欄；匝道跟別條路平行疊在一起也推開
//   3b. 交流道：匝道還疊在本線上的那段不畫、本線加寬(減速 / 加速車道，有漸變段)、分開後到尖端是槽化區
//   4. 曲線：向心 Catmull-Rom 樣條換成三次貝茲曲線(road_3d_shape.js)，通過每個原始點、沒有折角、跨路段也平順
//   5. 每點的路寬(車道數不同時漸變)、高度(橋每層 6 公尺，上下交叉保證淨空)、會落在別條路上的護欄段落
//   6. 全台體檢(折角、頭尾沒接上、路面疊在一起、邊線折回)，寫進 road3d/report.json
//
// 用法：node --max-old-space-size=8192 tools/build-road3d.js <overpass 下載結果.json>
//   Overpass 查詢：way[highway~"^(motorway|motorway_link|trunk|trunk_link)$"](南,西,北,東);out body geom qt;
//   目前存檔：C:\SmartNavData\road3d-src\
//
// 輸出：
//   road3d/index.json      有資料的圖磚清單 ["x_y", ...]
//   road3d/report.json     體檢報告
//   road3d/13/x_y.json     { v: 4, w: [[id, flags, 車道數, layer, [曲線點：經度, 緯度 × 1e6，第一點之後存差值], 細節], ...] }
//     flags：1 匝道、2 快速道路(否則國道)、4 單行道、8 橋梁
//     細節：w 每點路寬(公分；一個數字 = 整條一樣，陣列 = 差值)、z 每點高度(公分，同上，沒有 = 平地)、
//           d [前一條在接縫的方向 x, y, 下一條的方向 x, y](× 1e4，東、北；沒有接續的路是 0)、
//           h [邊, 起, 迄, ...] 這幾段護欄不畫(邊 1 右、-1 左、0 中央；起迄 = 占整條的比例 × 1e6)、
//           aL / aR 每點往左 / 右加寬(減速、加速車道，公分)、x [起, 迄, ...] 這幾段不畫(匝道還疊在本線上)、
//           g [{ l: 本線邊緣的點, r: 匝道邊緣的點, z: 高度 }] 槽化區、
//           mg [起, 迄, 起點空隙, 迄點空隙, ...] 中央分隔島草地：從這條路的路面左緣鋪到對向路面左緣(空隙公分)、
//           mh [起, 迄, 起點空隙, 迄點空隙, 起點 split, 迄點 split(× 100), ...] 窄分隔島立在正中間(這條負責畫)：
//             split 0 = 一道護欄(兩面斜角)＋防眩板、1 = 花台(兩道護欄＋樹籬)，中間慢慢分開；ms [起, 迄, ...] 這段中央護欄不畫(對向那條畫)

'use strict';

const fs = require('fs');
const path = require('path');
const FIX = require('./road3d-fix');
const SH = require('../road_3d_shape');

const Z = 13;
const src = process.argv[2];
if (!src) { console.error('用法：node tools/build-road3d.js <overpass.json>'); process.exit(1); }
const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
const elements = Array.isArray(raw.elements) ? raw.elements : [].concat(...Object.values(raw));
let t0 = Date.now();
const lap = (msg) => { console.log(`  ${msg}  ${((Date.now() - t0) / 1000).toFixed(1)} 秒`); t0 = Date.now(); };

// ── 1. 讀道路 ──
const seen = new Set(), all = [];
for (const e of elements) {
  if (e.type !== 'way' || !e.geometry || e.geometry.length < 2 || seen.has(e.id)) continue;
  seen.add(e.id);
  const t = e.tags || {};
  if (/^(yes|building_passage|culvert)$/.test(t.tunnel || '') || t.covered === 'yes' && t.tunnel) continue;
  const hw = t.highway || '', link = /_link$/.test(hw), cls = hw.replace('_link', '');
  if (cls !== 'motorway' && cls !== 'trunk') continue;
  const ok = e.geometry.map((g, i) => (g && isFinite(g.lon) && isFinite(g.lat) ? i : -1)).filter((i) => i >= 0);
  if (ok.length < 2) continue;
  let ll = ok.map((i) => [e.geometry[i].lon, e.geometry[i].lat]), nodes = ok.map((i) => (e.nodes ? e.nodes[i] : null));
  const oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === '-1' || (t.oneway !== 'no' && (cls === 'motorway' || t.junction === 'roundabout'));
  if (t.oneway === '-1') { ll.reverse(); nodes.reverse(); }
  const lanes = Math.max(0, Math.min(8, parseInt(t.lanes, 10) || 0));
  const bridge = !!t.bridge && t.bridge !== 'no';
  const layer = Math.max(0, Math.min(5, parseInt(t.layer, 10) || 0));
  all.push({ id: e.id, link, cls, oneway, bridge, layer, lanes, ll, nodes });
}
const inferred = FIX.inferLanes(all);
const mains = all;   // 第 2 階段：主線＋匝道都做
lap(`讀道路：${all.length} 段(主線 ${all.filter((w) => !w.link).length}、匝道 ${all.filter((w) => w.link).length})，推出車道數 ${inferred} 段`);

// ── 2～5. 修正、曲線、路寬、高度、護欄 ──
const rep = FIX.run(mains, { lanesDone: true });
lap(`修正：清掉雜訊小折點 ${rep.jitter} 個；接點曲線 ${rep.round.nodes} 處；對向推開 ${rep.sep.pushed} 段(最多 ${rep.sep.maxPush.toFixed(2)} 公尺)；匝道推開 ${rep.sepL.pushed} 段(最多 ${rep.sepL.maxPush.toFixed(2)} 公尺)；交流道分流 / 匯流 ${rep.junc.count} 處(槽化區沒到尖端 ${rep.junc.partial}、整段疊在本線上 ${rep.junc.covered}、沒取樣到 ${rep.junc.skipped} 處)；上下交叉 ${rep.clr.crossings} 處(抬高 ${rep.clr.bumped} 次，淨空還不夠 ${rep.clr.left} 處)；護欄不畫 ${rep.hide.hiddenKm.toFixed(1)} 公里；分隔島花台 ${rep.med.hedgeKm.toFixed(1)} 公里、草地 ${rep.med.grassKm.toFixed(1)} 公里`);

// ── 6. 體檢 ──
const ang = (a, b, c) => { const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]], lu = Math.hypot(u[0], u[1]), lv = Math.hypot(v[0], v[1]); return lu && lv ? Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (lu * lv)))) * 180 / Math.PI : 0; };
const report = { generated: new Date().toISOString(), stage: 3, ways: mains.length, kinks: { '6-10': 0, '10-20': 0, '>20': 0 }, kinkExamples: [], folds: 0, gaps: 0, overlapKm: 0 };
report.junctions = { count: rep.junc.count, partial: rep.junc.partial, covered: rep.junc.covered, partialExamples: rep.junc.exPartial, coveredExamples: rep.junc.exCovered };
const ll6 = (w, i) => { const p = w.P[i], m = [w.m0[0] + p[0] / w.k, w.m0[1] + p[1] / w.k]; return FIX.unmerc(m[0], m[1]).map((v) => +v.toFixed(5)); };
for (const w of mains) {
  if (!w.ok) continue;
  for (let i = 1; i < w.P.length - 1; i++) {
    const l1 = Math.hypot(w.P[i][0] - w.P[i - 1][0], w.P[i][1] - w.P[i - 1][1]), l2 = Math.hypot(w.P[i + 1][0] - w.P[i][0], w.P[i + 1][1] - w.P[i][1]);
    if (l1 < 0.8 || l2 < 0.8) continue;
    const a = ang(w.P[i - 1], w.P[i], w.P[i + 1]);
    if (a < 6) continue;
    report.kinks[a < 10 ? '6-10' : a < 20 ? '10-20' : '>20']++;
    if (report.kinkExamples.length < 20) report.kinkExamples.push({ way: w.id, deg: +a.toFixed(1), at: ll6(w, i) });
  }
  // 邊線折回：路面外緣的點要沿著路往前
  for (let i = 0; i < w.P.length - 1; i++) {
    const dx = w.P[i + 1][0] - w.P[i][0], dy = w.P[i + 1][1] - w.P[i][1];
    for (const sd of [-1, 1]) {
      const o0 = sd * w.Wv[i] / 2, o1 = sd * w.Wv[i + 1] / 2;
      const ex = (w.P[i + 1][0] + w.R[i + 1][0] * o1) - (w.P[i][0] + w.R[i][0] * o0), ey = (w.P[i + 1][1] + w.R[i + 1][1] * o1) - (w.P[i][1] + w.R[i][1] * o0);
      if (ex * dx + ey * dy <= 0) { report.folds++; if ((report.foldExamples = report.foldExamples || []).length < 30) report.foldExamples.push({ way: w.id, at: ll6(w, i), seg: +Math.hypot(dx, dy).toFixed(2), width: +w.Wv[i].toFixed(1) }); break; }
    }
  }
}
// 頭尾差一點點沒接上
{
  const ends = [], grid = new Map(), K = 1e5;
  for (const w of mains) [0, w.ll.length - 1].forEach((i) => { const c = w.ll[i], g = Math.floor(c[0] * K) + ',' + Math.floor(c[1] * K); ends.push([c, w]); if (!grid.has(g)) grid.set(g, []); grid.get(g).push([c, w]); });
  for (const [c, w] of ends) {
    const gx = Math.floor(c[0] * K), gy = Math.floor(c[1] * K);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const [q, o] of grid.get((gx + a) + ',' + (gy + b)) || []) {
      if (o === w) continue;
      const d = Math.hypot((q[0] - c[0]) * 102000, (q[1] - c[1]) * 110540);
      if (d > 0 && d < 0.5) report.gaps++;
    }
  }
  report.gaps /= 2;
}
fs.mkdirSync(path.join(__dirname, '..', 'road3d'), { recursive: true });
lap(`體檢：折角 6～10 度 ${report.kinks['6-10']}、10～20 度 ${report.kinks['10-20']}、20 度以上 ${report.kinks['>20']}；邊線折回 ${report.folds}；頭尾沒接上 ${report.gaps}`);

// ── 輸出圖磚 ──
const lon2x = (lon) => Math.floor((lon + 180) / 360 * 2 ** Z);
const lat2y = (lat) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** Z); };
const cmArr = (arr) => { const v = arr.map((x) => Math.round(x * 100)); if (v.every((x) => x === v[0])) return v[0]; const o = [v[0]]; for (let i = 1; i < v.length; i++) o.push(v[i] - v[i - 1]); return o; };
const tiles = {};
for (const w of mains) {
  if (!w.ok) continue;
  const pts = w.P.map((p) => { const m = [w.m0[0] + p[0] / w.k, w.m0[1] + p[1] / w.k], q = FIX.unmerc(m[0], m[1]); return [Math.round(q[0] * 1e6), Math.round(q[1] * 1e6)]; });
  const flat = [pts[0][0], pts[0][1]];
  for (let i = 1; i < pts.length; i++) flat.push(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const ext = { w: cmArr(w.Wv) };
  const z = cmArr(w.H); if (z !== 0) ext.z = z;
  if (w.dirB || w.dirA) ext.d = [w.dirB ? Math.round(w.dirB[0] * 1e4) : 0, w.dirB ? Math.round(w.dirB[1] * 1e4) : 0, w.dirA ? Math.round(w.dirA[0] * 1e4) : 0, w.dirA ? Math.round(w.dirA[1] * 1e4) : 0];
  if (w.hide && w.hide.length) ext.h = [].concat(...w.hide);
  const L = w.S[w.S.length - 1];
  if (w.auxL && w.auxL.some((v) => v > 0.01)) ext.aL = cmArr(w.auxL);   // 減速 / 加速車道往左加寬(公尺 → 公分)
  if (w.auxR && w.auxR.some((v) => v > 0.01)) ext.aR = cmArr(w.auxR);   // 往右加寬
  if (w.skip && w.skip.length) ext.x = [].concat(...w.skip.map((r) => [Math.round(Math.max(0, r[0]) / L * 1e6), Math.round(Math.min(L, r[1]) / L * 1e6)]));   // 這幾段不畫(還疊在本線上)
  // 分隔島草地：這條路負責鋪的段落 [起, 迄 (比例 × 1e6), 起點空隙, 迄點空隙 (公分)]
  const rng = (list) => [].concat(...list.map((r) => [Math.round(r[0] / L * 1e6), Math.round(r[1] / L * 1e6)].concat(r.length > 2 ? [Math.round(r[2] * 100), Math.round(r[3] * 100)] : []).concat(r.length > 4 ? [Math.round(r[4] * 100), Math.round(r[5] * 100)] : [])));
  if (w.medH && w.medH.length) ext.mh = rng(w.medH);   // 中間那道護欄 / 花台(這條負責畫)
  if (w.medS && w.medS.length) ext.ms = rng(w.medS);   // 這段中央護欄不畫(對向那條畫花台)
  if (w.medC && w.medC.length) ext.mg = [].concat(...w.medC.map((r) => [Math.round(r[0] / L * 1e6), Math.round(r[1] / L * 1e6), Math.round(r[2] * 100), Math.round(r[3] * 100)]));
  if (w.gores && w.gores.length) ext.g = w.gores.map((g) => { const f = (pts) => { const o = [Math.round(pts[0][0] * 1e6), Math.round(pts[0][1] * 1e6)]; for (let i = 1; i < pts.length; i++) o.push(Math.round(pts[i][0] * 1e6) - Math.round(pts[i - 1][0] * 1e6), Math.round(pts[i][1] * 1e6) - Math.round(pts[i - 1][1] * 1e6)); return o; }; return { l: f(g.l), r: f(g.r), z: g.z.map((v) => Math.round(v * 100)) }; });   // 槽化區
  const flags = (w.link ? 1 : 0) | (w.cls === 'trunk' ? 2 : 0) | (w.oneway ? 4 : 0) | (w.bridge ? 8 : 0);
  const rec = [w.id, flags, FIX.lanesOf(w), w.layer, flat, ext];
  const keys = new Set();
  for (let i = 0; i < pts.length; i++) keys.add(lon2x(pts[i][0] / 1e6) + '_' + lat2y(pts[i][1] / 1e6));
  for (const k of keys) (tiles[k] = tiles[k] || []).push(rec);
}
const outDir = path.join(__dirname, '..', 'road3d');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, String(Z)), { recursive: true });
let bytes = 0;
for (const [k, list] of Object.entries(tiles)) {
  const s = JSON.stringify({ v: 4, w: list });
  bytes += s.length;
  fs.writeFileSync(path.join(outDir, String(Z), k + '.json'), s);
}
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(Object.keys(tiles).sort()));
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
lap(`輸出：主線 ${mains.filter((w) => w.ok).length} 條、圖磚 ${Object.keys(tiles).length} 塊、共 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
