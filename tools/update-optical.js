// 大學眼鏡：照 tools/optical-stores.tsv(官網門市表格)產生 optical_data.js。
// OpenStreetMap 上沒有大學眼鏡，所以不走 tools/update-stores.js。
// 座標：展開官網附的 Google 地圖短網址，取地點本身的座標(!3d緯度!4d經度)，沒有才用 /search/緯度,經度 或畫面中心 @緯度,經度。
// 之後要更新：node tools/update-optical.js

const fs = require('fs');
const path = require('path');
const { compactJs } = require('./compact-data');

const LIST = path.join(__dirname, 'optical-stores.tsv');

async function expand(url) {
  let u = url;
  for (let i = 0; i < 5; i++) { // 短網址可能轉好幾次
    if (/google\.[^/]+\/maps\//.test(u)) break;
    const r = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
    const loc = r.headers.get('location');
    if (!loc) break;
    u = new URL(loc, u).href;
  }
  const m = /!3d(-?[\d.]+)!4d(-?[\d.]+)/.exec(u) || /search\/(-?[\d.]+),(?:\+|%20)?(-?[\d.]+)/.exec(u) || /@(-?[\d.]+),(-?[\d.]+)/.exec(u);
  return m ? [+m[1], +m[2]] : null;
}

async function main() {
  const rows = fs.readFileSync(LIST, 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#')).map(l => l.split('\t'));
  const stores = [], bad = [];
  for (const [name, addr, url] of rows) {
    const ll = url ? await expand(url).catch(() => null) : null;
    if (!ll || !(ll[0] > 21.8 && ll[0] < 26.5 && ll[1] > 118 && ll[1] < 122.2)) { bad.push(name); continue; }
    stores.push({ lat: ll[0], lng: ll[1], name: '大學眼鏡 ' + name.trim(), addr: addr.trim().replace(/^\d{3}/, '') }); // 去掉郵遞區號
    await new Promise(r => setTimeout(r, 500)); // 不要連續狂打 Google
  }
  const r6 = v => Math.round(v * 1e6) / 1e6;
  const feats = stores.sort((a, b) => b.lat - a.lat)
    .map(s => ({ geometry: { coordinates: [r6(s.lng), r6(s.lat)] }, properties: { name: s.name, addr: s.addr } }));
  const out =
    `// 大學眼鏡：${stores.length} 家。由 tools/update-optical.js 產生，不要手動改(門市清單在 tools/optical-stores.tsv)\n` +
    `// 資料來源：大學眼鏡官網門市資訊 https://www.eyeglasses.com.tw/location\n` +
    `// 精簡格式(tools/compact-data.js)，每筆：[經度, 緯度, 名稱, 地址]\n` +
    compactJs('opticalData', ['name', 'addr'], feats);
  fs.writeFileSync(path.join(__dirname, '..', 'optical_data.js'), out);
  console.log(`大學眼鏡：${stores.length} 家(清單 ${rows.length} 筆)`);
  if (bad.length) console.log(`找不到座標、沒放上地圖的：${bad.join('、')}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
