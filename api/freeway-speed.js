// GET /api/freeway-speed
// 國道各路段(交流道之間)即時車速代理，給監視器頁畫車道用。
// 高公局伺服器沒有開放 CORS，瀏覽器不能直接抓，由這支後端代為抓取、合併路段資料後回傳。
//
// 資料來源(免金鑰)：
//   即時車速 LiveTraffic.xml  每分鐘更新(照上游實際更新時間抓，跟地圖國道路況共用一份，見 lib/upstream.js)
//   路段資料 Section.xml      每天更新
//
// 回傳 { ok, data: { updateTime, nextUpdateIn, items: [{ road, dir, s, e, from, to, speed, level, limit }] } }
//   s/e 起訖里程(公尺)、speed 車速(km/h，-1 = 沒資料)、level 壅塞等級(1 順暢 ~ 5 壅塞)

const { corsHeaders, handlePreflight, methodNotAllowed, ok, err } = require('../lib/response');
const { feed } = require('../lib/upstream');

const BASE = 'https://tisvcloud.freeway.gov.tw/history/motc20';
const STATIC_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;

let sectionCache = null; // { at, map: { SectionID -> 路段 } }
const liveFeed = feed(BASE + '/LiveTraffic.xml', { periodMs: 60 * 1000 });
let liveCache = null;    // { version, data }：上游沒更新就不重新解析

function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'));
  return m ? m[1].trim() : '';
}
function blocks(xml, name) {
  return xml.match(new RegExp('<' + name + '>[\\s\\S]*?</' + name + '>', 'g')) || [];
}
const mileM = (s) => { const m = String(s).match(/(\d+)K\+(\d+)/i); return m ? (+m[1]) * 1000 + (+m[2]) : null; };

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

async function getSections() {
  const now = Date.now();
  if (sectionCache && now - sectionCache.at < STATIC_TTL_MS) return sectionCache.map;
  const xml = await fetchText(BASE + '/Section.xml');
  const map = {};
  for (const b of blocks(xml, 'Section')) {
    const id = tag(b, 'SectionID');
    const s = mileM(tag(b, 'StartKM')), e = mileM(tag(b, 'EndKM'));
    if (!id || s == null || e == null) continue;
    map[id] = { road: tag(b, 'RoadName'), dir: tag(b, 'RoadDirection'), s, e,
      from: tag(b, 'Start'), to: tag(b, 'End'), limit: +tag(b, 'SpeedLimit') || null };
  }
  sectionCache = { at: now, map };
  return map;
}

async function getLive() {
  const [lf, sections] = await Promise.all([liveFeed.get(3000), getSections()]);
  if (liveCache && liveCache.version === lf.version) return liveCache.data;
  const xml = lf.body;
  const items = [];
  for (const b of blocks(xml, 'LiveTraffic')) {
    const sec = sections[tag(b, 'SectionID')];
    if (!sec) continue;
    const speed = parseInt(tag(b, 'TravelSpeed'), 10);
    items.push(Object.assign({}, sec, { speed: Number.isFinite(speed) ? speed : -1, level: +tag(b, 'CongestionLevel') || 0 }));
  }
  const data = { updateTime: tag(xml, 'UpdateTime'), items };
  liveCache = { version: lf.version, data };
  return data;
}

module.exports = async (req, res) => {
  corsHeaders(res);
  if (handlePreflight(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res);
  try {
    return ok(res, Object.assign({ nextUpdateIn: liveFeed.nextUpdateIn }, await getLive()), { cache: 'no-cache' });
  } catch (e) {
    console.error('[freeway-speed]', e.message);
    if (liveCache) return ok(res, Object.assign({ nextUpdateIn: liveFeed.nextUpdateIn }, liveCache.data)); // 上游暫時連不到就先給上一次的
    return err(res, 502, 'UPSTREAM_ERROR', '無法取得國道路段車速(' + e.message + ')');
  }
};
