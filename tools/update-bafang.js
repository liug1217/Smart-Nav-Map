// 八方雲集：從官網門市查詢(https://www.8way.com.tw/store)抓全台門市，產生 bafang_data.js。
// OpenStreetMap 上幾乎沒有八方雲集，所以不走 tools/update-stores.js。
// 之後要更新：node tools/update-bafang.js
// 官網有擋非瀏覽器的連線(回 403)：抓不到時在瀏覽器打開官網門市頁，主控台執行下面這段，存成 JSON 檔，再
//   node tools/update-bafang.js --cache <那個 JSON 檔>
//   (async()=>{const a=[];for(let p=1;p<=10;p++){const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},
//    body:JSON.stringify({...BODY,pageIndex:p})});const L=(await r.json()).data.dataList;a.push(...L);if(L.length<200)break}
//    copy(JSON.stringify(a))})()   ← API、BODY 換成下面的值
// 座標在每筆的 url(Google 地圖連結 .../place/緯度,經度)裡。

const fs = require('fs');
const path = require('path');
const { compactJs } = require('./compact-data');

const API = 'https://www.8way.com.tw/8WayApi/Controllers/Web/WebShops/ApiWebShops/GetWebShopList';
const BODY = { keyword: '', city: '', area: '', isSurfaceClass: false, isQuickclick: false, paymentId: [], activityName: [], pageSize: 200 };

async function fetchAll() {
  const all = [];
  for (let p = 1; p <= 20; p++) {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.8way.com.tw/store' },
      body: JSON.stringify({ ...BODY, pageIndex: p }),
      signal: AbortSignal.timeout(60000),
    });
    const text = await r.text();
    if (!r.ok || !text.startsWith('{')) throw new Error(`官網回 ${r.status}(擋掉了)，請照檔案開頭的說明用 --cache`);
    const L = JSON.parse(text).data.dataList || [];
    all.push(...L);
    if (L.length < BODY.pageSize) break;
  }
  return all;
}

async function main() {
  const i = process.argv.indexOf('--cache');
  const rows = i > 0 ? JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8')) : await fetchAll();
  const stores = [];
  const bad = [];
  for (const s of rows) {
    const m = /place\/(-?[\d.]+),\s*(-?[\d.]+)/.exec(s.url || ''); // 有的店逗號後面多一個空格
    const lat = m ? +m[1] : NaN, lng = m ? +m[2] : NaN;
    // 台澎金馬範圍外的(官網座標填錯，例如經度填成緯度)不要
    if (!(lat > 21.8 && lat < 26.5 && lng > 118 && lng < 122.2)) { bad.push(`${s.name}(${s.url || '沒有座標'})`); continue; }
    const name = String(s.name || '').trim();
    stores.push({ lat, lng, name: '八方雲集 ' + name, addr: String(s.address || '').trim(), hours: String(s.businessHours || '').trim() });
  }
  const r6 = v => Math.round(v * 1e6) / 1e6;
  const feats = stores.sort((a, b) => b.lat - a.lat || a.lng - b.lng)
    .map(s => ({ geometry: { coordinates: [r6(s.lng), r6(s.lat)] }, properties: { name: s.name, addr: s.addr, hours: s.hours } }));
  const out =
    `// 八方雲集：${stores.length} 家。由 tools/update-bafang.js 產生，不要手動改\n` +
    `// 資料來源：八方雲集官網門市查詢 https://www.8way.com.tw/store\n` +
    `// 精簡格式(tools/compact-data.js)，每筆：[經度, 緯度, 名稱, 地址, 營業時間]\n` +
    compactJs('bafangData', ['name', 'addr', 'hours'], feats);
  fs.writeFileSync(path.join(__dirname, '..', 'bafang_data.js'), out);
  console.log(`八方雲集：${stores.length} 家(官網 ${rows.length} 筆)`);
  if (bad.length) console.log(`座標不對、沒放上地圖的 ${bad.length} 家：\n  ` + bad.join('\n  '));
}

main().catch(e => { console.error(e.message); process.exit(1); });
