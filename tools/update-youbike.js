// YouBike 2.0 全台站點：從 YouBike 官方站點資料抓，產生 youbike_data.js(精簡格式，見 tools/compact-data.js)。
// 之後要更新(新站、撤站、改名)：node tools/update-youbike.js
// 地圖上只放站點位置；點開站點時網頁會再向官方查「目前可借幾台、可還幾個空位」(即時)。
// 加 --cache <檔案> 可改讀之前下載好的 station-yb2.json

const fs = require('fs');
const path = require('path');
const { compactJs } = require('./compact-data');

const URL = 'https://apis.youbike.com.tw/json/station-yb2.json';

async function main() {
  const i = process.argv.indexOf('--cache');
  const text = (i > 0
    ? fs.readFileSync(process.argv[i + 1], 'utf8')
    : await (await fetch(URL, { signal: AbortSignal.timeout(120000) })).text()).replace(/^﻿/, '');
  const all = JSON.parse(text);
  if (!Array.isArray(all) || !all.length) throw new Error('官方資料格式變了');
  const r6 = v => Math.round(v * 1e6) / 1e6;
  let stopped = 0, bad = 0;
  const list = [];
  for (const s of all) {
    if (Number(s.status) !== 1) { stopped++; continue; } // 暫停營運/撤站的不放
    const lat = parseFloat(s.lat), lng = parseFloat(s.lng);
    if (!(lat > 21.5 && lat < 26.5 && lng > 118 && lng < 122.5)) { bad++; continue; }
    const name = String(s.name_tw || '').replace(/^YouBike2\.0_/, '').trim();
    list.push({ lat: r6(lat), lng: r6(lng), name: 'YouBike ' + name, no: String(s.station_no),
                addr: (String(s.district_tw || '') + String(s.address_tw || '')).trim() });
  }
  list.sort((a, b) => b.lat - a.lat || a.lng - b.lng);
  const feats = list.map(s => ({ geometry: { coordinates: [s.lng, s.lat] }, properties: { name: s.name, no: s.no, addr: s.addr } }));
  const out =
    `// YouBike 2.0：${list.length} 站。由 tools/update-youbike.js 產生，不要手動改\n` +
    `// 資料來源：YouBike 微笑單車官方站點資料\n` +
    `// 精簡格式(tools/compact-data.js)，每筆：[經度, 緯度, 站名, 站點代號, 地址]\n` +
    compactJs('youbikeData', ['name', 'no', 'addr'], feats);
  fs.writeFileSync(path.join(__dirname, '..', 'youbike_data.js'), out);
  console.log(`YouBike：${list.length} 站(暫停營運略過 ${stopped} 站、座標壞掉略過 ${bad} 站)`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
