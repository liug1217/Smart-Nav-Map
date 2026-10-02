// 從 OpenStreetMap 抓全台的全家、全聯、中油、7-ELEVEN、OK、萊爾富，跟手動加的店(tools/stores-manual.json)合併，
// 產生 family_mart_data.js / pxmart_data.js / cpc_data.js / seven_data.js / okmart_data.js / hilife_data.js。
// 之後要更新店家：node tools/update-stores.js
// 資料來源 OpenStreetMap(ODbL)，地圖右下角已有「© OpenStreetMap」標示，不能拿掉。
//
// 手動的店：用分店名(1 公里內)或 60 公尺內同品牌、沒寫分店名的店比對；
//   對到 → 用 OpenStreetMap 的位置、保留手動的店名；對不到 → 照手動的位置保留。
// 加 --cache <資料夾> 可改讀之前下載好的 osm_fm.json / osm_px.json / osm_fuel.json(不用再連網)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BBOX = '(21.8,119.3,26.5,122.2)'; // 台澎金馬
const MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const QUERIES = {
  fm:   `[out:json][timeout:180];nwr[shop=convenience]${BBOX};out center tags;`,
  px:   `[out:json][timeout:180];nwr[shop~"supermarket|convenience"]${BBOX};out center tags;`,
  fuel: `[out:json][timeout:180];nwr[amenity=fuel]${BBOX};out center tags;`,
};
const MATCH_NEAR_M = 60, MATCH_NAME_M = 1000, DEDUPE_M = 15, DEDUPE_NAMED_M = 300;

async function overpass(query) {
  for (let round = 0; round < 3; round++) {
    for (const url of MIRRORS) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SmartNavMap/1.0' },
          body: 'data=' + encodeURIComponent(query),
          signal: AbortSignal.timeout(200000),
        });
        const text = await r.text();
        if (r.ok && text.startsWith('{')) return JSON.parse(text);
      } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 10000));
  }
  throw new Error('OpenStreetMap 伺服器都在忙，等一下再跑一次');
}

async function load(key) {
  const i = process.argv.indexOf('--cache');
  const json = i > 0
    ? JSON.parse(fs.readFileSync(path.join(process.argv[i + 1], `osm_${key}.json`), 'utf8'))
    : await overpass(QUERIES[key]);
  return json.elements
    .map(e => ({ lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon, t: e.tags || {} }))
    .filter(e => e.lat != null && e.lng != null);
}

function distM(aLat, aLng, bLat, bLng) {
  const r = Math.PI / 180;
  const x = Math.sin((bLat - aLat) * r / 2) ** 2 +
            Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin((bLng - aLng) * r / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(x));
}

// 分店名：優先用 branch，其次是 name；去掉品牌字、括號註記、直營/加盟/自助，「XX加油站」統一成「XX站」
function branchOf(t, brandRe) {
  let n = (t.branch || t['name:zh'] || t.name || '')
    .replace(brandRe, '')
    .replace(/[(（][^)）]*[)）]/g, '')
    .replace(/直營|加盟|自助|\+/g, '')
    .replace(/加油站$/, '站')
    .replace(/\s+/g, '')
    .replace(/^[\-－]+|[\-－]+$/g, '');
  if (/^(站|店|門市|便利商店|超商)$/.test(n)) n = '';
  return /[一-鿿]/.test(n) ? n : '';
}

// 手動店名最後一段就是分店名(例如「全家便利商店 高雄聖德店」→「高雄聖德店」)
const manualBranch = name => name.split(/\s+/).pop();
const sameBranch = (a, b) => a && b && a.replace(/[店站]$/, '') === b.replace(/[店站]$/, '');

function build({ osm, manual, prefix, brandRe, suffix }) {
  const stores = osm.map(e => {
    let branch = branchOf(e.t, brandRe);
    if (branch && !/(店|站|門市)$/.test(branch)) branch += suffix; // 例如「新基隆一」→「新基隆一店」
    return { lat: e.lat, lng: e.lng, branch, name: branch ? `${prefix(e.t)} ${branch}` : prefix(e.t), manual: false };
  });
  // 同一家店有時同時標成點和建築(重複)：有分店名的 300 公尺內同名只留一個，沒分店名的 15 公尺內
  const uniq = [];
  for (const s of stores) {
    const lim = s.branch ? DEDUPE_NAMED_M : DEDUPE_M;
    if (!uniq.some(u => u.name === s.name && distM(u.lat, u.lng, s.lat, s.lng) < lim)) uniq.push(s);
  }
  let moved = 0, kept = 0;
  for (const m of manual) {
    const br = manualBranch(m.name);
    // 先找同分店名的；找不到才找附近沒寫分店名的
    const find = test => {
      let hit = null, best = Infinity;
      for (const s of uniq) {
        if (s.manual) continue;
        const d = distM(m.lat, m.lng, s.lat, s.lng);
        if (test(s, d) && d < best) { best = d; hit = s; }
      }
      return hit;
    };
    const hit = find((s, d) => sameBranch(s.branch, br) && d < MATCH_NAME_M) ||
                find((s, d) => !s.branch && d < MATCH_NEAR_M);
    // fixed: true = 位置以手動為準(自己校正過的店，OpenStreetMap 的位置不覆蓋)
    if (hit && m.fixed) { hit.name = m.name; hit.lat = m.lat; hit.lng = m.lng; hit.manual = true; kept++; }
    else if (hit) { hit.name = m.name; hit.manual = true; moved++; }
    else { uniq.push({ lat: m.lat, lng: m.lng, name: m.name, manual: true }); kept++; }
  }
  return { list: uniq, moved, kept };
}

function writeData(file, varName, title, list) {
  const r6 = v => Math.round(v * 1e6) / 1e6;
  const feats = list
    .sort((a, b) => b.lat - a.lat || a.lng - b.lng)
    .map(s => `{type:'Feature',geometry:{type:'Point',coordinates:[${r6(s.lng)},${r6(s.lat)}]},properties:{name:${JSON.stringify(s.name)}}}`);
  const out =
    `// ${title}：${list.length} 家。由 tools/update-stores.js 產生，不要手動改(手動的店請加在 tools/stores-manual.json)\n` +
    `// 資料來源：© OpenStreetMap 貢獻者(ODbL)＋手動加入\n` +
    `window.${varName} = {\n  type: 'FeatureCollection',\n  features: [\n    ${feats.join(',\n    ')}\n  ]\n};\n`;
  fs.writeFileSync(path.join(ROOT, file), out);
}

async function main() {
  const manual = JSON.parse(fs.readFileSync(path.join(__dirname, 'stores-manual.json'), 'utf8'));
  const [cv, sm, fu] = [await load('fm'), await load('px'), await load('fuel')];

  const isFm = e => e.t.brand === '全家便利商店' || e.t['brand:wikidata'] === 'Q10891564' ||
                    (!e.t.brand && /^全家/.test(e.t.name || ''));
  const isPx = e => /全聯/.test(e.t.brand || '') || (!e.t.brand && /全聯/.test(e.t.name || ''));
  const isCpc = e => /中油|^CPC$/i.test(e.t.brand || '') || (!e.t.brand && /中油/.test(e.t.name || ''));
  const isSeven = e => e.t.brand === '7-Eleven' || e.t['brand:wikidata'] === 'Q259340' ||
                       (!e.t.brand && /7-?ELEVEN|7-11|統一超商/i.test(e.t.name || ''));
  const isOk = e => e.t.brand === 'OK超商' || e.t['brand:wikidata'] === 'Q10851968' ||
                    (!e.t.brand && /^OK/i.test(e.t.name || ''));
  const isHilife = e => e.t.brand === '萊爾富' || e.t['brand:wikidata'] === 'Q11326216' ||
                        (!e.t.brand && /萊爾富|Hi-?Life/i.test(e.t.name || ''));

  const jobs = [
    { file: 'family_mart_data.js', v: 'familyMartData', title: '全家便利商店', osm: cv.filter(isFm), manual: manual.familyMart,
      prefix: () => '全家便利商店', suffix: '店', brandRe: /全家便利商店|全家|FamilyMart/gi },
    { file: 'pxmart_data.js', v: 'pxmartData', title: '全聯／大全聯', osm: sm.filter(isPx), manual: manual.pxmart,
      suffix: '店', prefix: t => /大全聯/.test(t.brand || t.name || '') ? '大全聯' : '全聯福利中心', brandRe: /大全聯|全聯福利中心|全聯|PX ?Mart/gi },
    { file: 'cpc_data.js', v: 'cpcData', title: '台灣中油加油站', osm: fu.filter(isCpc), manual: manual.cpc,
      prefix: () => '台灣中油', suffix: '站', brandRe: /[台臺]灣中油股份有限公司|[台臺]灣中油|中油加油站|中油|CPC/gi },
    { file: 'seven_data.js', v: 'sevenData', title: '7-ELEVEN', osm: cv.filter(isSeven), manual: manual.seven || [],
      prefix: () => '7-ELEVEN', suffix: '門市', brandRe: /7-?ELEVEN|7-11|統一超商/gi },
    { file: 'okmart_data.js', v: 'okmartData', title: 'OK超商', osm: cv.filter(isOk), manual: manual.okmart || [],
      prefix: () => 'OK超商', suffix: '店', brandRe: /OK超商|OK ?mart|OK/gi },
    { file: 'hilife_data.js', v: 'hilifeData', title: '萊爾富', osm: cv.filter(isHilife), manual: manual.hilife || [],
      prefix: () => '萊爾富', suffix: '店', brandRe: /萊爾富便利商店|萊爾富|Hi-?Life/gi },
  ];
  for (const j of jobs) {
    const { list, moved, kept } = build(j);
    writeData(j.file, j.v, j.title, list);
    console.log(`${j.title}: ${list.length} 家(手動的店 ${moved} 家改用 OpenStreetMap 位置、${kept} 家對不到照原位置保留)`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
