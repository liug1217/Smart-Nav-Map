// 桃園市區即時路況：桃園市交通局公開的車輛偵測器(VD)資料(不用 TDX 金鑰)，每分鐘更新。
//   設備資訊(一天抓一次)：每支偵測器的位置、路名
//   動態資料(每分鐘)：每個車道、每種車的車速與車流量
// 桃園只給偵測器「點位」、沒有行車方向，所以只能把偵測器所在那一小格(約 150 公尺)的道路上色；
// 輸出格式同手機路況(方向 U = 不分方向，前端會對到那一格裡最近的道路)。

const { LEVELS, GEOHASH_PRECISION } = require('./config');
const { ghEncode } = require('./geohash');

const STATIC_URL = 'https://opendata.tycg.gov.tw/api/dataset/eee1cc30-aa46-4420-b099-5cd51fc0f1a4/resource/4cdc358d-dd7b-4087-83c5-46e4f3323036/download';
const LIVE_URL = 'https://opendata.tycg.gov.tw/api/dataset/6449c1a9-f99b-4c66-8498-062e159641d6/resource/c7ea1c3a-05ab-4ddd-b601-07d74f10f5b7/download';
const STATIC_TTL_MS = 24 * 3600 * 1000;
const LIVE_TTL_MS = 60 * 1000;
const LIVE_MAX_AGE_MS = 10 * 60 * 1000;

// 桃園沒有官方塞車等級：用市區道路的車速門檻
function levelFromKmh(v) {
  if (v >= 30) return 'free';
  if (v >= 20) return 'moderate';
  if (v >= 12) return 'slow';
  return 'congested';
}
const LEVEL_INFO = Object.fromEntries(LEVELS.map(l => [l.level, l]));

let devices = null;   // { at, byId: Map(VDID → { lat, lng, road }) }
let live = null;      // { at, points: [{ gh, lat, lng, road, speed, level }] }
let loadingStatic = null, loadingLive = null;

const tag = (b, n) => { const m = b.match(new RegExp('<' + n + '>([^<]*)</' + n + '>')); return m ? m[1].trim() : ''; };
const blocks = (xml, n) => xml.match(new RegExp('<' + n + '>[\\s\\S]*?</' + n + '>', 'g')) || [];

async function getText(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

function parseDevices(xml) {
  const byId = new Map();
  for (const b of blocks(xml, 'VD')) {
    const lat = Number(tag(b, 'PositionLat')), lng = Number(tag(b, 'PositionLon'));
    if (lat > 24.5 && lat < 25.2 && lng > 120.9 && lng < 121.5) byId.set(tag(b, 'VDID'), { lat, lng, road: tag(b, 'RoadName') });
  }
  return byId;
}

// 每支偵測器的車速 = 各車道車速依車流量加權平均(只用狀態正常、有車速的車道)
function parseLive(xml, byId) {
  const lanes = new Map(); // VDID → Map(LaneID → { sp, vol })
  for (const b of blocks(xml, 'VDLive')) {
    if (tag(b, 'Status') !== '0') continue;
    const id = tag(b, 'VDID'), lane = tag(b, 'LaneID'), sp = Number(tag(b, 'LaneSpeed'));
    if (!lanes.has(id)) lanes.set(id, new Map());
    const m = lanes.get(id), cur = m.get(lane) || { sp, vol: 0 };
    cur.vol += Number(tag(b, 'Volume')) || 0;
    m.set(lane, cur);
  }
  const points = [];
  for (const [id, m] of lanes) {
    const d = byId.get(id);
    if (!d) continue;
    let w = 0, s = 0;
    for (const l of m.values()) if (l.sp > 0) { const ww = Math.max(1, l.vol); w += ww; s += l.sp * ww; }
    if (!w) continue;
    const speed = Math.round(s / w), level = levelFromKmh(speed);
    if (level === 'free') continue; // 順暢的不送(前端本來就不畫)
    points.push({ gh: ghEncode(d.lat, d.lng, GEOHASH_PRECISION), lat: d.lat, lng: d.lng, road: d.road, speed, level });
  }
  return points;
}

async function ensureFresh(timeoutMs) {
  const now = Date.now(), jobs = [];
  if ((!devices || now - devices.at > STATIC_TTL_MS) && !loadingStatic) {
    loadingStatic = getText(STATIC_URL).then(x => { const byId = parseDevices(x); if (byId.size) devices = { at: Date.now(), byId }; })
      .catch(e => console.error('[taoyuan] 設備資訊', e.message)).finally(() => { loadingStatic = null; });
  }
  if (loadingStatic && !devices) jobs.push(loadingStatic);
  if (jobs.length) await Promise.race([Promise.all(jobs), new Promise(r => setTimeout(r, timeoutMs))]);
  if (!devices) return;
  if ((!live || Date.now() - live.at > LIVE_TTL_MS) && !loadingLive) {
    loadingLive = getText(LIVE_URL).then(x => { live = { at: Date.now(), points: parseLive(x, devices.byId) }; })
      .catch(e => console.error('[taoyuan] 動態資料', e.message)).finally(() => { loadingLive = null; });
  }
  if (loadingLive && !live) await Promise.race([loadingLive, new Promise(r => setTimeout(r, timeoutMs))]);
}

async function taoyuanFeatures({ north, south, east, west }, timeoutMs = 4000) {
  if (north < 24.5 || south > 25.2 || east < 120.9 || west > 121.5) return []; // 畫面不在桃園：不用抓
  try { await ensureFresh(timeoutMs); } catch (_) {}
  if (!live || Date.now() - live.at > LIVE_MAX_AGE_MS) return [];
  return live.points.filter(p => p.lat >= south && p.lat <= north && p.lng >= west && p.lng <= east).map(p => {
    const lv = LEVEL_INFO[p.level];
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: {
        segmentId: `${p.gh}:U`, direction: 'U', averageSpeed: p.speed,
        speedRatio: null, sampleCount: null, uniqueContributors: null, baselineSpeed: null, baselineSource: null,
        trafficLevel: p.level, color: lv.color, label: lv.label, confidence: 'high',
        source: 'taoyuan', sectionName: p.road, updatedAt: live.at,
      },
    };
  });
}

let polling = false, lastSig = null;
function startPolling(onChange) {
  if (polling) return;
  polling = true;
  const tick = async () => {
    try { await ensureFresh(30000); } catch (_) {}
    if (!live) return;
    const sig = live.points.map(p => p.gh + p.level).join(',');
    if (lastSig !== null && sig !== lastSig) { try { onChange(); } catch (_) {} }
    lastSig = sig;
  };
  tick();
  setInterval(tick, 30 * 1000).unref();
}

module.exports = { taoyuanFeatures, startPolling, parseDevices, parseLive, levelFromKmh };
