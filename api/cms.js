// GET /api/cms
// 國道電子看板(CMS,可變資訊標誌)即時訊息代理。
// 公路局伺服器沒有開放 CORS,瀏覽器不能直接抓,由這支後端代為抓取、合併位置後回傳。
//
// 資料來源(免金鑰):
//   即時訊息 CMSLive.xml  每 60 秒更新
//   看板位置 CMS.xml      每天更新
// 兩份用 CMSID 對起來,所有看板與訊息都原樣回傳,不做過濾。
//
// 回傳 { ok, data: { updateTime, count, items: [{ id, road, direction, mile, section,
//        lon, lat, status, messageStatus, collectedAt, messages: [{ text, type, priority }] }] } }

const { corsHeaders, handlePreflight, methodNotAllowed, ok, err } = require('../lib/response');

const BASE = 'https://tisvcloud.freeway.gov.tw/history/motc20';
const LIVE_URL = BASE + '/CMSLive.xml';
const STATIC_URL = BASE + '/CMS.xml';
const STATIC_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

let staticCache = null; // { at, map: { CMSID -> 位置資料 } }

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'));
  return m ? decodeXml(m[1].trim()) : '';
}

function blocks(xml, name) {
  return xml.match(new RegExp('<' + name + '>[\\s\\S]*?</' + name + '>', 'g')) || [];
}

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

async function getStaticMap() {
  const now = Date.now();
  if (staticCache && now - staticCache.at < STATIC_TTL_MS) return staticCache.map;
  const xml = await fetchText(STATIC_URL);
  const map = {};
  for (const b of blocks(xml, 'CMS')) {
    const id = tag(b, 'CMSID');
    if (!id) continue;
    map[id] = {
      lon: parseFloat(tag(b, 'PositionLon')),
      lat: parseFloat(tag(b, 'PositionLat')),
      road: tag(b, 'RoadName'),
      direction: tag(b, 'RoadDirection'),
      mile: tag(b, 'LocationMile'),
      section: tag(b, 'Start') + ' → ' + tag(b, 'End'),
    };
  }
  staticCache = { at: now, map };
  return map;
}

module.exports = async (req, res) => {
  corsHeaders(res);
  if (handlePreflight(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res);

  try {
    const [liveXml, positions] = await Promise.all([fetchText(LIVE_URL), getStaticMap()]);

    const items = blocks(liveXml, 'CMSLive').map((b) => {
      const id = tag(b, 'CMSID');
      const pos = positions[id] || {};
      return {
        id,
        road: pos.road || '',
        direction: pos.direction || '',
        mile: pos.mile || '',
        section: pos.section || '',
        lon: Number.isFinite(pos.lon) ? pos.lon : null,
        lat: Number.isFinite(pos.lat) ? pos.lat : null,
        status: tag(b, 'Status'),
        messageStatus: tag(b, 'MessageStatus'),
        collectedAt: tag(b, 'DataCollectTime'),
        messages: blocks(b, 'Message').map((m) => ({
          text: tag(m, 'Text'),
          type: tag(m, 'Type'),
          priority: tag(m, 'Priority'),
        })),
      };
    });

    return ok(res, {
      updateTime: tag(liveXml, 'UpdateTime'),
      count: items.length,
      items,
    }, { cache: 'public, s-maxage=30, stale-while-revalidate=60' });
  } catch (e) {
    console.error('[cms]', e.message);
    const cause = e.cause && (e.cause.code || e.cause.message);
    return err(res, 502, 'UPSTREAM_ERROR', '無法取得國道電子看板資料(' + e.message + (cause ? ' / ' + cause : '') + ')');
  }
};
