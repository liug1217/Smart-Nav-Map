// 產生 3D 道路用的資料(road3d/)：全台國道、快速道路、匝道的路線、車道數、單行道、橋梁。
// 資料來源：OpenStreetMap(Overpass API)。公開的 Overpass 伺服器常常很慢或掛掉，所以不在 App 裡即時查，
// 改成先下載一次、切成 zoom 13 圖磚的小檔案(一塊約 4.9 公里)放在網站上，App 只抓畫面附近那幾塊。
//
// 用法：node tools/build-road3d.js <overpass 下載結果.json>
//   下載結果格式：{ "任意 key": [Overpass elements...], ... }(分區下載後合併；也可以直接是一份 Overpass 回應)
//   Overpass 查詢：way[highway~"^(motorway|motorway_link|trunk|trunk_link)$"](南,西,北,東);out body geom qt;
//
// 輸出：
//   road3d/index.json      有資料的圖磚清單 ["x_y", ...]
//   road3d/13/x_y.json     { w: [[id, flags, lanes, layer, [lon0, lat0, dlon1, dlat1, ...]], ...] }
//     flags：1 匝道、2 快速道路(否則國道)、4 單行道、8 橋梁；座標 = 度 × 1e6 的整數，第一點之後存差值(檔案比較小)
//     單行道 oneway=-1 已經反轉成行車方向；隧道不畫，不收

const fs = require('fs');
const path = require('path');

const Z = 13;
const src = process.argv[2];
if (!src) { console.error('用法：node tools/build-road3d.js <overpass.json>'); process.exit(1); }
const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
const elements = Array.isArray(raw.elements) ? raw.elements : [].concat(...Object.values(raw));

const lon2x = (lon) => Math.floor((lon + 180) / 360 * 2 ** Z);
const lat2y = (lat) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** Z); };

const seen = new Set(), tiles = {};
let nWays = 0;
for (const e of elements) {
  if (e.type !== 'way' || !e.geometry || e.geometry.length < 2 || seen.has(e.id)) continue;
  seen.add(e.id);
  const t = e.tags || {};
  if (/^(yes|building_passage|culvert)$/.test(t.tunnel || '') || t.covered === 'yes' && t.tunnel) continue;
  const hw = t.highway || '', link = /_link$/.test(hw), cls = hw.replace('_link', '');
  if (cls !== 'motorway' && cls !== 'trunk') continue;
  let pts = e.geometry.filter((g) => g && isFinite(g.lon) && isFinite(g.lat)).map((g) => [Math.round(g.lon * 1e6), Math.round(g.lat * 1e6)]);
  if (pts.length < 2) continue;
  const oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === '-1' || (t.oneway !== 'no' && (cls === 'motorway' || t.junction === 'roundabout'));
  if (t.oneway === '-1') pts.reverse();
  const lanes = Math.max(0, Math.min(8, parseInt(t.lanes, 10) || 0));   // 0 = 沒標，App 用一般值
  const bridge = !!t.bridge && t.bridge !== 'no';
  const layer = Math.max(0, Math.min(5, parseInt(t.layer, 10) || 0));
  const flags = (link ? 1 : 0) | (cls === 'trunk' ? 2 : 0) | (oneway ? 4 : 0) | (bridge ? 8 : 0);
  const flat = [pts[0][0], pts[0][1]];
  for (let i = 1; i < pts.length; i++) flat.push(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const rec = [e.id, flags, lanes, layer, flat];
  // 路經過的每塊圖磚都放一份(App 用 id 去重)
  const keys = new Set();
  for (let i = 0; i < pts.length; i++) {
    keys.add(lon2x(pts[i][0] / 1e6) + '_' + lat2y(pts[i][1] / 1e6));
    if (i) {   // 兩點中間也看一下，長的一段不會漏掉中間的圖磚
      const mx = (pts[i][0] + pts[i - 1][0]) / 2e6, my = (pts[i][1] + pts[i - 1][1]) / 2e6;
      keys.add(lon2x(mx) + '_' + lat2y(my));
    }
  }
  for (const k of keys) (tiles[k] = tiles[k] || []).push(rec);
  nWays++;
}

const outDir = path.join(__dirname, '..', 'road3d');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, String(Z)), { recursive: true });
let bytes = 0;
for (const [k, list] of Object.entries(tiles)) {
  const s = JSON.stringify({ w: list });
  bytes += s.length;
  fs.writeFileSync(path.join(outDir, String(Z), k + '.json'), s);
}
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(Object.keys(tiles).sort()));
console.log(`道路 ${nWays} 條、圖磚 ${Object.keys(tiles).length} 塊、共 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
