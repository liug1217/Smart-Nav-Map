// 測速照相：從警政署「測速執法設置點」(政府資料開放平臺 dataset 7320)抓最新資料，產生 speed_camera_data.js。
// 之後官方有更新：node tools/update-speedcams.js
// 官方資料新增的會加進來、拿掉的會刪掉、改位置/速限/方向的跟著改。
// 官方座標明顯錯誤(例如漂到海裡)的，用下面 FIXES 的位置蓋過去(依地址比對)。
// 加 --cache <檔案> 可改讀之前下載好的 CSV

const fs = require('fs');
const path = require('path');

const URL = 'https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/EA5E6FCD-B82D-43B7-A5CF-E9893253187E/resource/1FBE57A8-4B79-4D89-B01D-35D3E4C52BE5/download';

// 官方座標錯誤、我們手動修正過的(地址 → 正確經緯度)
const FIXES = {
  '台1線104.9公里處': [120.83167, 24.645304],       // 官方緯度 26.6 → 跑到海上
  '187乙線17.33K': [120.49278, 22.488373],          // 官方位置在海上
  '臺灣大道八段與港埠路口': [120.53624, 24.25],      // 官方位置在海上
};

// 簡單 CSV 解析(欄位裡可能有用雙引號包起來的逗號)
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(c => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function main() {
  const i = process.argv.indexOf('--cache');
  const text = (i > 0
    ? fs.readFileSync(process.argv[i + 1], 'utf8')
    : await (await fetch(URL, { signal: AbortSignal.timeout(60000) })).text()).replace(/^﻿/, '');
  const rows = parseCsv(text);
  const head = rows[0].map(h => h.trim());
  const col = n => head.indexOf(n);
  const [cCity, cAddr, cLng, cLat, cDir, cLim] = ['CityName', 'Address', 'Longitude', 'Latitude', 'direct', 'limit'].map(col);
  if ([cCity, cAddr, cLng, cLat, cDir, cLim].some(c => c < 0)) throw new Error('欄位名稱變了：' + head.join(','));

  const cams = [];
  let fixed = 0, bad = 0;
  for (const r of rows.slice(1)) {
    const addr = (r[cAddr] || '').trim();
    if (!addr || r[cCity] === '設置縣市') continue; // 第二行是中文欄位說明
    let lng = parseFloat(r[cLng]), lat = parseFloat(r[cLat]);
    if (FIXES[addr]) { [lng, lat] = FIXES[addr]; fixed++; }
    if (!(lat > 21.5 && lat < 26.5 && lng > 118 && lng < 122.5)) { bad++; continue; } // 座標壞掉的不收
    cams.push({ lng, lat, limit: parseInt(r[cLim], 10) || 0, addr, city: (r[cCity] || '').trim(), dir: (r[cDir] || '').trim() });
  }
  const lines = cams.map(c => JSON.stringify({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
    properties: { limit: c.limit, addr: c.addr, city: c.city, dir: c.dir } }));
  const out = '﻿window.speedCameraData={"type":"FeatureCollection","features":[\n' + lines.join(',\n') + '\n]};\n';
  fs.writeFileSync(path.join(__dirname, '..', 'speed_camera_data.js'), out);
  console.log(`測速照相：${cams.length} 支(手動修正座標 ${fixed} 支、座標壞掉略過 ${bad} 支)`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
