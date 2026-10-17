// 產生一般道路的車道數資料(road3d-city/)：省道級(primary)、縣道級(secondary)、區道級(tertiary)中 OSM 有標 lanes 的路
// 手機(road_3d_city.js)把底圖的每條路對到最近、方向一樣的這些路，有就照車道數算路寬、畫車道線，沒有就用道路等級的預設值
//
// 用法：node tools/build-city-lanes.js
//   1. 從 Overpass(maps.mail.ru 鏡像站，一次一格 0.5 度、會限流所以慢慢抓、失敗重試)下載，存到 C:\SmartNavData\road3d-src\tw_osm_city_lanes_<日期>.json
//      (已經有今天的檔案就不重抓)
//   2. 輸出 road3d-city/13/x_y.json：{ w: [[車道數, 單行道 1 / 雙向 0, [經度, 緯度 × 1e6，第一點之後存差值]], ...] }
//      座標簡化到 3 公尺(只用來對路)；路經過的每塊圖磚都放一份
//      road3d-city/index.json：有資料的圖磚清單
'use strict';

const fs = require('fs');
const path = require('path');

const SRC_DIR = 'C:/SmartNavData/road3d-src';
const OUT = path.join(__dirname, '..', 'road3d-city');
const Z = 13;
const API = 'https://maps.mail.ru/osm/tools/overpass/api/interpreter';
const today = new Date().toISOString().slice(0, 10);
const srcFile = path.join(SRC_DIR, `tw_osm_city_lanes_${today}.json`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 只抓有陸地的格子：台灣本島(0.5 度一格)＋澎湖、金門、馬祖各一格(海上的格子 Overpass 常常不回，一直重試很浪費時間)
const cells = [];
for (let lat = 21.85; lat < 25.35; lat += 0.5) for (let lon = 119.95; lon < 122.05; lon += 0.5) cells.push([+lat.toFixed(2), +lon.toFixed(2), +Math.min(25.35, lat + 0.5).toFixed(2), +Math.min(122.05, lon + 0.5).toFixed(2)]);
cells.push([23.1, 119.3, 23.8, 119.75], [24.35, 118.15, 24.55, 118.5], [25.9, 119.85, 26.4, 120.55]);

// 每格抓完先存在 city-lanes-cells/(中斷了再跑會接著抓，不用從頭)
const CELL_DIR = path.join(SRC_DIR, 'city-lanes-cells');
async function download() {
  const all = new Map();
  fs.mkdirSync(CELL_DIR, { recursive: true });
  for (let i = 0; i < cells.length; i++) {
    const [s, w, n, e] = cells[i], cf = path.join(CELL_DIR, s + '_' + w + '.json');
    if (fs.existsSync(cf)) { JSON.parse(fs.readFileSync(cf, 'utf8')).forEach((el) => all.set(el.id, el)); console.log('  ' + (i + 1) + '/' + cells.length + ' 格(已經抓過)：累計 ' + all.size + ' 條'); continue; }
    const q = `[out:json][timeout:180];way[highway~"^(primary|secondary|tertiary)$"][lanes](${s},${w},${n},${e});out tags geom;`;
    let got = null;
    for (let t = 0; t < 4 && !got; t++) {
      try {
        const r = await fetch(API, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        const j = await r.json();
        if (Array.isArray(j.elements)) got = j.elements;
      } catch (err) { console.log('    第 ' + (i + 1) + ' 格第 ' + (t + 1) + ' 次失敗，等一下再試'); await wait(8000 * (t + 1)); }
    }
    if (!got) { console.error(`  第 ${i + 1} 格(${s},${w})抓不到，跳過`); continue; }
    got = got.filter((el) => el.type === 'way' && el.geometry);
    fs.writeFileSync(cf, JSON.stringify(got));
    got.forEach((el) => all.set(el.id, el));
    console.log(`  ${i + 1}/${cells.length} 格：${got.length} 條，累計 ${all.size} 條`);
    await wait(3000);
  }
  fs.writeFileSync(srcFile, JSON.stringify({ elements: [...all.values()] }));
  return [...all.values()];
}

// Douglas-Peucker(公尺)
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const kx = 111320 * Math.cos(pts[0][1] * Math.PI / 180), ky = 110540;
  const keep = new Array(pts.length).fill(false); keep[0] = keep[pts.length - 1] = true;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop();
    const ax = pts[a][0] * kx, ay = pts[a][1] * ky, bx = pts[b][0] * kx, by = pts[b][1] * ky, dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i][0] * kx - ax) * dy - (pts[i][1] * ky - ay) * dx) / L; if (d > md) { md = d; mi = i; } }
    if (md > tol) { keep[mi] = true; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const lon2x = (lon) => Math.floor((lon + 180) / 360 * Math.pow(2, Z));
const lat2y = (lat) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, Z)); };

(async () => {
  let els;
  if (fs.existsSync(srcFile)) { els = JSON.parse(fs.readFileSync(srcFile, 'utf8')).elements; console.log(`用已經下載的 ${srcFile}：${els.length} 條`); }
  else { console.log('下載 OSM 一般道路車道數…'); els = await download(); }
  const tiles = {};
  let n = 0;
  for (const el of els) {
    const t = el.tags || {}, lanes = parseInt(t.lanes, 10);
    if (!(lanes > 0 && lanes <= 12)) continue;
    let pts = el.geometry.filter((g) => g && isFinite(g.lon)).map((g) => [g.lon, g.lat]);
    if (pts.length < 2) continue;
    const one = t.oneway === 'yes' || t.oneway === '1' ? 1 : t.oneway === '-1' ? -1 : 0;
    if (one === -1) pts.reverse();
    pts = simplify(pts, 3);
    const flat = [Math.round(pts[0][0] * 1e6), Math.round(pts[0][1] * 1e6)];
    for (let i = 1; i < pts.length; i++) flat.push(Math.round(pts[i][0] * 1e6) - Math.round(pts[i - 1][0] * 1e6), Math.round(pts[i][1] * 1e6) - Math.round(pts[i - 1][1] * 1e6));
    const rec = [lanes, one ? 1 : 0, flat], keys = new Set();
    pts.forEach((p) => keys.add(lon2x(p[0]) + '_' + lat2y(p[1])));
    keys.forEach((k) => (tiles[k] = tiles[k] || []).push(rec));
    n++;
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, String(Z)), { recursive: true });
  let bytes = 0;
  for (const k of Object.keys(tiles)) { const s = JSON.stringify({ w: tiles[k] }); bytes += s.length; fs.writeFileSync(path.join(OUT, String(Z), k + '.json'), s); }
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(Object.keys(tiles).sort()));
  console.log(`輸出：${n} 條、圖磚 ${Object.keys(tiles).length} 塊、共 ${(bytes / 1e6).toFixed(1)} MB`);
})();
