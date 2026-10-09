// 大樹藥局：從官網門市資訊(https://www.greattree.com.tw/stores)抓全台門市，產生 greattree_data.js。
// 官網只有地址、沒有座標：用 OpenStreetMap 的 Nominatim 把地址換成座標(結構化查詢：門牌＋路名、鄉鎮市區、縣市)。
//   - 只收查到門牌的(place / building / shop / amenity…)；只查到路名(road)的位置可能差很遠，不放
//   - 查過的地址記在 tools/greattree-geocode.json，下次只查新的/改過的(Nominatim 規定每秒最多 1 次)
//   - 只查到路名或查不到的店：手動在 Google 地圖查官網地址，把座標加到 tools/greattree-manual.tsv(優先用手動的)
// 之後要更新：node tools/update-greattree.js

const fs = require('fs');
const path = require('path');
const { compactJs } = require('./compact-data');

const PAGE = 'https://www.greattree.com.tw/stores';
const CACHE = path.join(__dirname, 'greattree-geocode.json');
const MANUAL = path.join(__dirname, 'greattree-manual.tsv');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
const NOMINATIM_UA = 'SmartNavMap/1.0 (https://github.com/liug1217/Smart-Nav-Map)';

function parseStores(html) {
  return html.split(/<li class=.address./).slice(1).map(b => {
    const name = ((/fcolor-main fwb">([^<]+)</.exec(b) || [])[1] || '').trim();
    const addr = ((/link-map[\s\S]*?<span>([^<]+)<\/span>/.exec(b) || [])[1] || '').trim();
    return { name, addr };
  }).filter(s => s.name && s.addr);
}

// 「臺北市士林區中正路280號」→ 縣市、鄉鎮市區、路名(含段)、門牌
function splitAddr(a) {
  const m = /^(.+?[縣市])(.+?[區鄉鎮市])?(.*?[里村鄰])?(.+?(?:路|街|大道|巷)(?:[一二三四五六七八九十]段)?)(.*?)(\d+(?:之\d+)?)號/.exec(a);
  return m && { state: m[1], city: m[2] || m[1], road: m[4], no: m[6] };
}

async function geocode(addr) {
  const p = splitAddr(addr);
  if (!p) return null;
  const q = { street: p.no + ' ' + p.road, city: p.city, state: p.state, countrycodes: 'tw', format: 'json', limit: 1 };
  const r = await fetch('https://nominatim.openstreetmap.org/search?' + new URLSearchParams(q), { headers: { 'User-Agent': NOMINATIM_UA } });
  const j = await r.json();
  return j[0] ? { lat: +j[0].lat, lng: +j[0].lon, type: j[0].addresstype } : { none: true };
}

async function main() {
  const r = await fetch(PAGE, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
  const stores = parseStores(await r.text());
  if (stores.length < 100) throw new Error(`官網門市只解析出 ${stores.length} 家，網頁可能改版了`);
  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
  const manual = {}; // 門市名稱 → [緯度, 經度]
  if (fs.existsSync(MANUAL)) {
    for (const l of fs.readFileSync(MANUAL, 'utf8').split(/\r?\n/)) {
      const [n, lat, lng] = l.split('\t');
      if (n && !n.startsWith('#') && +lat && +lng) manual[n.trim()] = [+lat, +lng];
    }
  }
  let asked = 0;
  for (const s of stores) {
    if (cache[s.addr] || manual[s.name]) continue;
    cache[s.addr] = await geocode(s.addr).catch(() => null) || { none: true };
    asked++;
    await new Promise(r => setTimeout(r, 1100));
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 0).replace(/},"/g, '},\n"'));

  const ok = [], road = [], none = [];
  let byHand = 0;
  for (const s of stores) {
    const g = cache[s.addr];
    if (manual[s.name]) { ok.push({ ...s, lat: manual[s.name][0], lng: manual[s.name][1] }); byHand++; }
    else if (!g || g.none || g.lat == null) none.push(s.name);
    else if (g.type === 'road') road.push(s.name);
    else ok.push({ ...s, lat: g.lat, lng: g.lng });
  }
  const r6 = v => Math.round(v * 1e6) / 1e6;
  const feats = ok.sort((a, b) => b.lat - a.lat || a.lng - b.lng)
    .map(s => ({ geometry: { coordinates: [r6(s.lng), r6(s.lat)] }, properties: { name: '大樹藥局 ' + s.name + (/店$/.test(s.name) ? '' : '店'), addr: s.addr } }));
  const out =
    `// 大樹藥局：${ok.length} 家。由 tools/update-greattree.js 產生，不要手動改\n` +
    `// 資料來源：大樹連鎖藥局官網門市資訊 https://www.greattree.com.tw/stores；座標：地址經 OpenStreetMap Nominatim 換算，查不準的手動補(tools/greattree-manual.tsv)\n` +
    `// 精簡格式(tools/compact-data.js)，每筆：[經度, 緯度, 名稱, 地址]\n` +
    compactJs('greatTreeData', ['name', 'addr'], feats);
  fs.writeFileSync(path.join(__dirname, '..', 'greattree_data.js'), out);
  console.log(`大樹藥局：${ok.length} 家放上地圖(官網 ${stores.length} 家，其中手動座標 ${byHand} 家；這次新查 ${asked} 個地址)`);
  console.log(`只查到路名、沒放的 ${road.length} 家：${road.join('、')}`);
  console.log(`查不到的 ${none.length} 家：${none.join('、')}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
