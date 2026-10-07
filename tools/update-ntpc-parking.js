// 新北市公有停車場：從新北市資料開放平臺「新北市路外公共停車場資訊」抓，產生 ntpc_parking_data.js。
// 之後要更新：node tools/update-ntpc-parking.js
// 資料集：https://data.ntpc.gov.tw/datasets/b1464ef0-9c7c-4a6f-abf7-6bdf32847e68(政府資料開放授權條款)
// TYPE 1 = 公有(市場、捷運站、公園…)，TYPE 2 = 民營或建築物附設，只取 1。
// 座標是 TWD97 二度分帶(TM2，中央經線 121 度)，換算成經緯度。

const fs = require('fs');
const path = require('path');
const { compactJs } = require('./compact-data');

const API = 'https://data.ntpc.gov.tw/api/datasets/b1464ef0-9c7c-4a6f-abf7-6bdf32847e68/json';

// TWD97 TM2 → WGS84(GRS80 橢球；TWD97 與 WGS84 差距在公分等級，直接當同一個)
function tm2ToLatLng(x, y) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9999, lon0 = 121 * Math.PI / 180, dx = 250000;
  const e2 = f * (2 - f), e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2)), ep2 = e2 / (1 - e2);
  const M = y / k0;
  const mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
           + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const C1 = ep2 * Math.cos(p1) ** 2, T1 = Math.tan(p1) ** 2;
  const N1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2), R1 = a * (1 - e2) / (1 - e2 * Math.sin(p1) ** 2) ** 1.5;
  const D = (x - dx) / (N1 * k0);
  const lat = p1 - (N1 * Math.tan(p1) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
            + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
  const lng = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / Math.cos(p1);
  return [lng * 180 / Math.PI, lat * 180 / Math.PI];
}

async function fetchAll() {
  const all = [];
  for (let page = 0; page < 20; page++) {
    const r = await fetch(`${API}?page=${page}&size=1000`, { signal: AbortSignal.timeout(60000) });
    const rows = await r.json();
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}

async function main() {
  const rows = await fetchAll();
  const lots = rows.filter(r => String(r.TYPE) === '1' && +r.TW97X > 0 && +r.TW97Y > 0).map(r => {
    const [lng, lat] = tm2ToLatLng(+r.TW97X, +r.TW97Y);
    const name = String(r.NAME || '').trim().replace(/^新北市/, ''); // 前面已經有「新北市公有停車場」，不要重複
    return { lng, lat, name: '新北市公有停車場 ' + name, addr: String(r.ADDRESS || '').trim(),
             fee: String(r.PAYEX || '').replace(/;+$/, '').trim(), hours: String(r.SERVICETIME || '').trim() };
  }).filter(l => l.lat > 24.6 && l.lat < 25.4 && l.lng > 121.2 && l.lng < 122.1); // 新北市範圍外的(座標填錯)不要
  const r6 = v => Math.round(v * 1e6) / 1e6;
  const feats = lots.sort((a, b) => b.lat - a.lat)
    .map(l => ({ geometry: { coordinates: [r6(l.lng), r6(l.lat)] }, properties: { name: l.name, addr: l.addr, fee: l.fee, hours: l.hours } }));
  const out =
    `// 新北市公有停車場：${lots.length} 處。由 tools/update-ntpc-parking.js 產生，不要手動改\n` +
    `// 資料來源：新北市政府 新北市路外公共停車場資訊(政府資料開放授權條款)\n` +
    `// 精簡格式(tools/compact-data.js)，每筆：[經度, 緯度, 名稱, 地址, 收費, 營業時間]\n` +
    compactJs('ntpcParkingData', ['name', 'addr', 'fee', 'hours'], feats);
  fs.writeFileSync(path.join(__dirname, '..', 'ntpc_parking_data.js'), out);
  console.log(`新北市公有停車場：${lots.length} 處(官方資料 ${rows.length} 筆，取公有的)`);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { tm2ToLatLng };
