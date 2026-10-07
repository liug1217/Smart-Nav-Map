// 從 OpenStreetMap 抓全台的全家、全聯、中油、7-ELEVEN、OK、萊爾富、美廉社、Times、嘟嘟房、麥當勞、八方雲集，
// 跟手動加的店(tools/stores-manual.json)合併，產生各品牌的 *_data.js。
// 之後要更新店家：node tools/update-stores.js
// 資料來源 OpenStreetMap(ODbL)，地圖右下角已有「© OpenStreetMap」標示，不能拿掉。
//
// 手動的店：用分店名(1 公里內)或 60 公尺內同品牌、沒寫分店名的店比對；
//   對到 → 用 OpenStreetMap 的位置、保留手動的店名；對不到 → 照手動的位置保留。
// 加 --cache <資料夾> 可改讀之前下載好的 osm_fm.json / osm_px.json / osm_fuel.json / osm_parking.json / osm_food.json(不用再連網)
// 某一類資料抓不到時(伺服器太忙)，那幾個品牌的檔案維持原樣，其他照常更新

const fs = require('fs');
const path = require('path');
const { compactJs } = require('./compact-data');

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
  parking: `[out:json][timeout:180];nwr[amenity=parking]${BBOX};out center tags;`,
  // 餐廳全部抓太大，只抓要的品牌
  food: `[out:json][timeout:180];nwr[amenity][~"^(brand|name|name:zh|name:en|operator)$"~"麥當勞|McDonald|八方雲集",i]${BBOX};out center tags;`,
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
    .filter(e => e.lat != null && e.lng != null)
    // 查詢範圍為了包到馬祖會碰到福建沿海(福州、平潭…)：經度 119.9 以西、北緯 24 度以北都是中國，排除
    // (澎湖在北緯 24 度以南、馬祖在 119.9 以東，不受影響)
    .filter(e => !(e.lng < 119.9 && e.lat > 24));
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
    .replace(/^(地下|平面)?停車場[\-－]?/, '') // 「停車場-內湖行善站」→「內湖行善站」
    .replace(/加油站$/, '站')
    .replace(/\s+/g, '')
    .replace(/^[\-－]+|[\-－]+$/g, '');
  if (/^(站|店|門市|便利商店|超商|停車場)$/.test(n)) n = '';
  return /[一-鿿]/.test(n) ? n : '';
}

// 手動店名最後一段就是分店名(例如「全家便利商店 高雄聖德店」→「高雄聖德店」)
const manualBranch = name => name.split(/\s+/).pop();
const sameBranch = (a, b) => a && b && a.replace(/[店站]$/, '') === b.replace(/[店站]$/, '');

function build({ osm, manual, prefix, brandRe, suffix, plain }) {
  const stores = osm.map(e => {
    let branch = branchOf(e.t, brandRe);
    if (branch && !/(店|站|門市)$/.test(branch) && !branch.endsWith(suffix)) branch += suffix; // 例如「新基隆一」→「新基隆一店」
    return { lat: e.lat, lng: e.lng, branch, name: branch ? `${prefix(e.t)} ${branch}` : (plain || prefix(e.t)), manual: false };
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
    // removed: true = 這家已經沒了(使用者回報、確認過)：從地圖拿掉
    if (m.removed) { if (hit) hit.removed = true; continue; }
    if (hit && m.fixed) { hit.name = m.name; hit.lat = m.lat; hit.lng = m.lng; hit.manual = true; kept++; }
    else if (hit) { hit.name = m.name; hit.manual = true; moved++; }
    else { uniq.push({ lat: m.lat, lng: m.lng, name: m.name, manual: true }); kept++; }
  }
  return { list: uniq.filter(s => !s.removed), moved, kept };
}

function writeData(file, varName, title, list) {
  const r6 = v => Math.round(v * 1e6) / 1e6;
  const feats = list
    .sort((a, b) => b.lat - a.lat || a.lng - b.lng)
    .map(s => ({ geometry: { coordinates: [r6(s.lng), r6(s.lat)] }, properties: { name: s.name } }));
  const out =
    `// ${title}：${list.length} 家。由 tools/update-stores.js 產生，不要手動改(手動的店請加在 tools/stores-manual.json)\n` +
    `// 資料來源：© OpenStreetMap 貢獻者(ODbL)＋手動加入\n` +
    `// 精簡格式(tools/compact-data.js)，每筆：[經度, 緯度, 名稱]\n` +
    compactJs(varName, ['name'], feats);
  fs.writeFileSync(path.join(ROOT, file), out);
}

async function main() {
  const manual = JSON.parse(fs.readFileSync(path.join(__dirname, 'stores-manual.json'), 'utf8'));
  // 每類資料各自抓；抓不到的記成 null，用到它的品牌就跳過
  const src = {};
  for (const k of Object.keys(QUERIES)) {
    try { src[k] = await load(k); } catch (e) { src[k] = null; console.error(`${k} 資料抓不到：${e.message}`); }
  }
  const cv = src.fm, sm = src.px, fu = src.fuel, pk = src.parking, fd = src.food;

  const isFm = e => e.t.brand === '全家便利商店' || e.t['brand:wikidata'] === 'Q10891564' ||
                    (!e.t.brand && /^全家/.test(e.t.name || ''));
  const isPx = e => /全聯/.test(e.t.brand || '') || (!e.t.brand && /全聯/.test(e.t.name || ''));
  const isCpc = e => /中油|^CPC$/i.test(e.t.brand || '') || (!e.t.brand && /中油/.test(e.t.name || ''));
  const isSeven = e => e.t.brand === '7-Eleven' || e.t['brand:wikidata'] === 'Q259340' ||
                       (!e.t.brand && /7-?ELEVEN|7-11|統一超商/i.test(e.t.name || ''));
  const isOk = e => e.t.brand === 'OK超商' || e.t['brand:wikidata'] === 'Q10851968' ||
                    (!e.t.brand && /^OK/i.test(e.t.name || ''));
  const isTimes = e => /times|タイムズ|普客二四|park ?24/i.test([e.t.brand, e.t.operator, e.t.name, e.t['name:en']].filter(Boolean).join(' '));
  const txt = e => [e.t.brand, e.t.operator, e.t.name, e.t['name:zh'], e.t['name:en']].filter(Boolean).join(' ');
  const isSimple = e => /美廉社|simple ?mart/i.test(txt(e));
  const isDodo = e => /嘟嘟房|dodohome/i.test(txt(e));
  const isMcd = e => e.t['brand:wikidata'] === 'Q38076' || /麥當勞|McDonald/i.test(txt(e));
  const isBafang = e => /八方雲集/.test(txt(e));
  // 家樂福 2026 年改名：量販店 → 萬家福、超市/便利購 → 樂家康(OpenStreetMap 上多半還寫家樂福)
  const isCfSmall = e => /家樂福超市|便利購|樂家康|Carrefour\s*(Market|Express)/i.test(txt(e));
  const isWjf = e => /萬家福|家樂福|Carrefour/i.test(txt(e)) && !isCfSmall(e);
  const isLjk = e => isCfSmall(e);
  const isShowba = e => /小北百貨|小北/.test(txt(e));
  const isHilife = e => e.t.brand === '萊爾富' || e.t['brand:wikidata'] === 'Q11326216' ||
                        (!e.t.brand && /萊爾富|Hi-?Life/i.test(e.t.name || ''));

  const jobs = [
    { file: 'family_mart_data.js', v: 'familyMartData', title: '全家便利商店', osm: [cv, isFm], manual: manual.familyMart,
      prefix: () => '全家便利商店', suffix: '店', brandRe: /全家便利商店|全家|FamilyMart/gi },
    { file: 'pxmart_data.js', v: 'pxmartData', title: '全聯／大全聯', osm: [sm, isPx], manual: manual.pxmart,
      suffix: '店', prefix: t => /大全聯/.test(t.brand || t.name || '') ? '大全聯' : '全聯福利中心', brandRe: /大全聯|全聯福利中心|全聯|PX ?Mart/gi },
    { file: 'cpc_data.js', v: 'cpcData', title: '台灣中油加油站', osm: [fu, isCpc], manual: manual.cpc,
      prefix: () => '台灣中油', suffix: '站', brandRe: /[台臺]灣中油股份有限公司|[台臺]灣中油|中油加油站|中油|CPC/gi },
    { file: 'seven_data.js', v: 'sevenData', title: '7-ELEVEN', osm: [cv, isSeven], manual: manual.seven || [],
      prefix: () => '7-ELEVEN', suffix: '門市', brandRe: /7-?ELEVEN|7-11|統一超商/gi },
    { file: 'okmart_data.js', v: 'okmartData', title: 'OK超商', osm: [cv, isOk], manual: manual.okmart || [],
      prefix: () => 'OK超商', suffix: '店', brandRe: /OK超商|OK ?mart|OK/gi },
    { file: 'hilife_data.js', v: 'hilifeData', title: '萊爾富', osm: [cv, isHilife], manual: manual.hilife || [],
      prefix: () => '萊爾富', suffix: '店', brandRe: /萊爾富便利商店|萊爾富|Hi-?Life/gi },
    { file: 'times_data.js', v: 'timesData', title: 'Times 停車場', osm: [pk, isTimes], manual: manual.times || [],
      prefix: () => 'Times', plain: 'Times 停車場', suffix: '停車場', brandRe: /台灣普客二四股份有限公司|普客二四停車場股份有限公司|普客二四|Times ?24 ?h?|24 ?h ?Times|Times|タイムズ|parking lot/gi },
    { file: 'simplemart_data.js', v: 'simplemartData', title: '美廉社', osm: [sm, isSimple], manual: manual.simplemart || [],
      prefix: () => '美廉社', suffix: '店', brandRe: /三商企業集團|美廉社|Simple ?Mart/gi },
    { file: 'dodohome_data.js', v: 'dodohomeData', title: '嘟嘟房', osm: [pk, isDodo], manual: manual.dodohome || [],
      prefix: () => '嘟嘟房', plain: '嘟嘟房停車場', suffix: '停車場', brandRe: /寶盛國際股份有限公司|嘟嘟房|dodohome|parking lot/gi },
    { file: 'mcd_data.js', v: 'mcdData', title: '麥當勞', osm: [fd, isMcd], manual: manual.mcd || [],
      prefix: () => '麥當勞', suffix: '店', brandRe: /台灣麥當勞|麥當勞|McDonald'?s?|得來速|餐廳/gi },
    { file: 'bafang_data.js', v: 'bafangData', title: '八方雲集', osm: [fd, isBafang], manual: manual.bafang || [],
      prefix: () => '八方雲集', suffix: '店', brandRe: /八方雲集鍋貼水餃專賣店|八方雲集|鍋貼水餃專賣店|鍋貼水餃/gi },
    { file: 'wanjiafu_data.js', v: 'wanjiafuData', title: '萬家福', osm: [sm, isWjf], manual: manual.wanjiafu || [],
      prefix: () => '萬家福', suffix: '店', brandRe: /萬家福|家樂福量販店|家樂福|Carrefour/gi },
    { file: 'lejiakang_data.js', v: 'lejiakangData', title: '樂家康', osm: [sm, isLjk], manual: manual.lejiakang || [],
      prefix: () => '樂家康', suffix: '店', brandRe: /家樂福超市|家樂福便利購|便利購|家樂福|樂家康|Carrefour\s*(Market|Express)?/gi },
    { file: 'showba_data.js', v: 'showbaData', title: '小北百貨', osm: [sm, isShowba], manual: manual.showba || [],
      prefix: () => '小北百貨', suffix: '店', brandRe: /小北百貨|小北/gi },
  ];
  for (const j of jobs) {
    if (!j.osm[0]) { console.log(`${j.title}: 這次沒抓到資料，檔案維持原樣`); continue; }
    j.osm = j.osm[0].filter(j.osm[1]);
    const { list, moved, kept } = build(j);
    writeData(j.file, j.v, j.title, list);
    console.log(`${j.title}: ${list.length} 家(手動的店 ${moved} 家改用 OpenStreetMap 位置、${kept} 家對不到照原位置保留)`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
