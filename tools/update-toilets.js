// 從環境部「全國公廁建檔資料」(政府資料開放平臺 dataset 30794，政府資料開放授權條款第 1 版)
// 抓全台公共廁所，跟手動加的(tools/toilets-manual.json)合併，產生 toilet_data.js。
// 之後要更新：node tools/update-toilets.js
//
// 官方資料是「每間廁所一筆」(同一地點的男廁、女廁、無障礙廁所各一筆)，這裡合併成一個地點。
// 金鑰是政府資料開放平臺下載連結上公開的；大家共用，每天有呼叫上限，用完會自動換下一把。
// 加 --cache <檔案> 可改讀之前下載好的 JSON 陣列(不用再連網)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API = 'https://data.moenv.gov.tw/api/v2/fac_p_07';
const KEYS = ['b7df779e-71a6-4148-8379-5afbd441d803', 'e75b1660-e564-4107-aad5-a8be1f905dd9'];
const MATCH_M = 50;

async function fetchAll() {
  for (const key of KEYS) {
    const all = [];
    try {
      for (let offset = 0; ; offset += 1000) {
        const r = await fetch(`${API}?api_key=${key}&limit=1000&offset=${offset}&format=JSON`, { signal: AbortSignal.timeout(60000) });
        const text = await r.text();
        if (!text.startsWith('[') && !text.startsWith('{')) throw new Error(text.slice(0, 60));
        const d = JSON.parse(text);
        const rows = Array.isArray(d) ? d : (d.records || []);
        all.push(...rows);
        if (rows.length < 1000) return all;
      }
    } catch (e) {
      console.error(`金鑰 ${key.slice(0, 8)}… 失敗：${e.message}`);
    }
  }
  throw new Error('環境部資料抓不到(可能今天的呼叫次數用完了)，明天再跑一次');
}

function distM(aLat, aLng, bLat, bLng) {
  const r = Math.PI / 180;
  const x = Math.sin((bLat - aLat) * r / 2) ** 2 +
            Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin((bLng - aLng) * r / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(x));
}

// 「中油鶯歌加油站-男廁」→「中油鶯歌加油站」
const placeName = n => (n || '')
  .replace(/[\s\-－_—(（]*(男|女|無障礙|親子|混合|性別友善|性平|友善|殘障|身障|哺乳)[^\-－(（]*$/, '')
  .replace(/[\s\-－(（]+$/, '').trim() || n;

async function main() {
  const i = process.argv.indexOf('--cache');
  const rows = i > 0 ? JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8')) : await fetchAll();
  const manual = JSON.parse(fs.readFileSync(path.join(__dirname, 'toilets-manual.json'), 'utf8')).toilets;

  // 同一管理單位、同一位置(約 10 公尺)的廁所合併成一個地點
  const places = new Map();
  for (const r of rows) {
    const lat = +r.latitude, lng = +r.longitude;
    if (!(lat > 21 && lat < 27 && lng > 118 && lng < 123)) continue; // 座標缺漏或填錯
    const key = `${r.exec || ''}|${lat.toFixed(4)}|${lng.toFixed(4)}`;
    let p = places.get(key);
    if (!p) {
      p = { name: placeName(r.name), lat, lng, addr: r.address || '', cat: r.type2 || '', types: new Set(), diaper: false, grades: new Set() };
      places.set(key, p);
    }
    p.types.add(r.type);
    if (+r.diaper > 0) p.diaper = true;
    if (r.grade) p.grades.add(r.grade);
  }
  const list = [...places.values()];

  let matched = 0, added = 0;
  for (const m of manual) {
    let hit = null, best = MATCH_M;
    for (const p of list) {
      const d = distM(m.lat, m.lng, p.lat, p.lng);
      if (d < best) { best = d; hit = p; }
    }
    if (m.removed) { if (hit) hit.removed = true; continue; } // 已經沒了：從地圖拿掉
    if (hit) {
      hit.name = m.name;
      if (m.fixed) { hit.lat = m.lat; hit.lng = m.lng; }
      matched++;
    } else {
      list.push({ name: m.name, lat: m.lat, lng: m.lng, addr: '', cat: '', types: new Set(), diaper: false, grades: new Set() });
      added++;
    }
  }

  // 設施標籤：無障礙、親子、性別友善、尿布台；等級不是特優才標出來
  const tags = p => {
    const t = [];
    if (p.types.has('無障礙廁所')) t.push('無障礙');
    if (p.types.has('親子廁所')) t.push('親子');
    if (p.types.has('性別友善廁所')) t.push('性別友善');
    if (p.diaper) t.push('尿布台');
    const g = ['不合格', '普通級', '優等級'].find(x => p.grades.has(x));
    if (g) t.push(g);
    return t.join('、');
  };
  const r6 = v => Math.round(v * 1e6) / 1e6;
  const rowsOut = list.filter(p => !p.removed)
    .sort((a, b) => b.lat - a.lat || a.lng - b.lng)
    .map(p => JSON.stringify([r6(p.lng), r6(p.lat), p.name, p.addr, p.cat, tags(p)]));
  const out =
    `// 全台公共廁所：${list.length} 個地點。由 tools/update-toilets.js 產生，不要手動改(手動的請加在 tools/toilets-manual.json)\n` +
    `// 資料來源：環境部 全國公廁建檔資料(政府資料開放授權條款第 1 版)＋手動加入\n` +
    `// 每筆：[經度, 緯度, 名稱, 地址, 場所類別, 設施]\n` +
    `window.toiletData = (function (rows) {\n` +
    `  return { type: 'FeatureCollection', features: rows.map(function (a) {\n` +
    `    return { type: 'Feature', geometry: { type: 'Point', coordinates: [a[0], a[1]] },\n` +
    `             properties: { name: a[2], addr: a[3], cat: a[4], tags: a[5] } };\n` +
    `  }) };\n` +
    `})([\n${rowsOut.join(',\n')}\n]);\n`;
  fs.writeFileSync(path.join(ROOT, 'toilet_data.js'), out);
  console.log(`公共廁所：${list.length} 個地點(官方 ${rows.length} 間合併；手動的 ${matched} 個對到官方資料、${added} 個新加入)`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
