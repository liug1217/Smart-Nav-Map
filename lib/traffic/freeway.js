// 國道即時路況：高速公路局公開資料(不用 TDX 金鑰)，每分鐘更新。
//   路段定義 Section.xml、路段形狀 SectionShape.xml(一天抓一次)
//   路段即時路況 LiveTraffic.xml(每分鐘)：每段的平均車速 TravelSpeed、塞車等級 CongestionLevel
// 國道路段一段好幾公里；這裡把它切成跟手機回傳路況一樣的 geohash 小格(約 150 公尺)，
// 輸出格式跟手機路況完全一樣(segmentId = 格子:方向)，前端對齊道路、上色的程式不用改。

const fs = require('fs');
const path = require('path');
const { ghEncode, headingToDir } = require('./geohash');
const { LEVELS, GEOHASH_PRECISION } = require('./config');

const BASE = 'https://tisvcloud.freeway.gov.tw/history/motc20/';
const SECTIONS_TTL_MS = 24 * 3600 * 1000; // 路段形狀一天更新一次
const LIVE_TTL_MS = 60 * 1000;            // 即時路況每分鐘
const LIVE_MAX_AGE_MS = 10 * 60 * 1000;   // 抓不到新資料時，舊的最多再用 10 分鐘
const STEP_M = 15;                        // 切格子前先把路線每 15 公尺補一個點

// 官方塞車等級 → 我們的等級(0 = 沒資料，不畫)。實測：1 ≥75、2 60~79、3 40~59、4 20~39、5 <20 km/h
const LEVEL_BY_OFFICIAL = { 1: 'free', 2: 'moderate', 3: 'slow', 4: 'congested', 5: 'severe' };
const LEVEL_INFO = Object.fromEntries(LEVELS.map(l => [l.level, l]));

let sections = null;   // { at, pieces: [{ sec, name, limit, gh, dir, coords, lat, lng }] }
let live = null;       // { at, bySec: Map(sectionId → { speed, level }) }
let loadingSections = null, loadingLive = null;

const tag = (block, name) => { const m = block.match(new RegExp('<' + name + '>([^<]*)</' + name + '>')); return m ? m[1].trim() : ''; };
const blocks = (xml, name) => xml.match(new RegExp('<' + name + '>[\\s\\S]*?</' + name + '>', 'g')) || [];

async function getText(file) {
  const r = await fetch(BASE + file, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(file + ' HTTP ' + r.status);
  return r.text();
}

// WKT LINESTRING / MULTILINESTRING → [[lng,lat],...] 的陣列
function parseWkt(wkt) {
  const parts = wkt.replace(/^\s*MULTI/i, '').match(/\(([^()]+)\)/g) || [];
  return parts.map(p => p.slice(1, -1).split(',').map(xy => xy.trim().split(/\s+/).map(Number)))
    .filter(line => line.length >= 2 && line.every(c => isFinite(c[0]) && isFinite(c[1])));
}

// 一條路線切成 geohash 小格：每格一段(接上前一格最後一點，線才連續)，方向取這一小段的走向
function cutIntoCells(line) {
  const pts = [];
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1], [x1, y1] = line[i];
    const kx = 111320 * Math.cos(y0 * Math.PI / 180), ky = 110540;
    const d = Math.hypot((x1 - x0) * kx, (y1 - y0) * ky);
    const n = Math.max(1, Math.ceil(d / STEP_M));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) pts.push([x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n]);
  }
  const out = [];
  let cur = null, curGh = null, prev = null;
  for (const p of pts) {
    const gh = ghEncode(p[1], p[0], GEOHASH_PRECISION);
    if (gh !== curGh) {
      cur = { gh, coords: prev ? [prev, p] : [p] };
      out.push(cur); curGh = gh;
    } else cur.coords.push(p);
    prev = p;
  }
  return out.filter(c => c.coords.length >= 2).map(c => {
    const a = c.coords[0], b = c.coords[c.coords.length - 1];
    const brg = (Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI + 360) % 360;
    const r5 = v => Math.round(v * 1e5) / 1e5;
    return { gh: c.gh, dir: headingToDir(brg), coords: c.coords.map(q => [r5(q[0]), r5(q[1])]), lat: a[1], lng: a[0] };
  });
}

function cacheFile() {
  const dir = process.env.SNM_DATA_DIR;
  return dir ? path.join(dir, 'freeway-sections.json') : null;
}

async function loadSections() {
  const [secXml, shapeXml] = await Promise.all([getText('Section.xml'), getText('SectionShape.xml')]);
  const info = new Map();
  for (const b of blocks(secXml, 'Section')) {
    info.set(tag(b, 'SectionID'), { name: tag(b, 'SectionName'), limit: Number(tag(b, 'SpeedLimit')) || null });
  }
  const pieces = [];
  for (const b of blocks(shapeXml, 'SectionShape')) {
    const sec = tag(b, 'SectionID'), meta = info.get(sec) || {};
    for (const line of parseWkt(tag(b, 'Geometry'))) {
      for (const c of cutIntoCells(line)) pieces.push({ sec, name: meta.name || '', limit: meta.limit, ...c });
    }
  }
  if (!pieces.length) throw new Error('國道路段形狀是空的');
  sections = { at: Date.now(), pieces };
  const f = cacheFile();
  if (f) { try { fs.writeFileSync(f, JSON.stringify(sections)); } catch (_) {} }
}

async function loadLive() {
  const xml = await getText('LiveTraffic.xml');
  const bySec = new Map();
  for (const b of blocks(xml, 'LiveTraffic')) {
    const level = LEVEL_BY_OFFICIAL[Number(tag(b, 'CongestionLevel'))];
    const speed = Number(tag(b, 'TravelSpeed'));
    if (level && speed > 0) bySec.set(tag(b, 'SectionID'), { speed, level });
  }
  live = { at: Date.now(), bySec };
}

// 需要時才更新(同一時間只抓一次)；第一次會等(最多 timeoutMs)，之後都在背景更新、直接用手上的資料
async function ensureFresh(timeoutMs) {
  const now = Date.now();
  if (!sections) {
    const f = cacheFile();
    if (f) { try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); if (c && c.pieces && c.pieces.length) sections = c; } catch (_) {} }
  }
  const jobs = [];
  if ((!sections || now - sections.at > SECTIONS_TTL_MS) && !loadingSections) {
    loadingSections = loadSections().catch(e => console.error('[freeway] 路段形狀', e.message)).finally(() => { loadingSections = null; });
  }
  if (loadingSections && !sections) jobs.push(loadingSections);
  if ((!live || now - live.at > LIVE_TTL_MS) && !loadingLive) {
    loadingLive = loadLive().catch(e => console.error('[freeway] 即時路況', e.message)).finally(() => { loadingLive = null; });
  }
  if (loadingLive && !live) jobs.push(loadingLive);
  if (jobs.length) await Promise.race([Promise.all(jobs), new Promise(r => setTimeout(r, timeoutMs))]);
}

// bbox 內的國道路況(格式同手機路況)；拿不到資料就回空陣列，不影響手機路況
async function freewayFeatures({ north, south, east, west }, timeoutMs = 4000) {
  try { await ensureFresh(timeoutMs); } catch (_) {}
  if (!sections || !live || Date.now() - live.at > LIVE_MAX_AGE_MS) return [];
  const out = [];
  for (const p of sections.pieces) {
    if (p.lat < south || p.lat > north || p.lng < west || p.lng > east) continue;
    const s = live.bySec.get(p.sec);
    // 順暢的不送：前端順暢路段本來就不另外畫(道路就是綠色)，全送的話台北一小塊就上千格，手機流量太大
    if (!s || s.level === 'free') continue;
    const lv = LEVEL_INFO[s.level];
    out.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: p.coords },
      properties: {
        segmentId: `${p.gh}:${p.dir}`,
        direction: p.dir,
        averageSpeed: s.speed,
        speedRatio: p.limit ? Math.round(s.speed / p.limit * 100) / 100 : null,
        sampleCount: null,
        uniqueContributors: null,
        baselineSpeed: p.limit,
        baselineSource: 'limit',
        trafficLevel: s.level,
        color: lv.color,
        label: lv.label,
        confidence: 'high',
        source: 'freeway',
        sectionName: p.name,
        updatedAt: live.at,
      },
    });
  }
  return out;
}

// 伺服器啟動後在背景定時更新；國道塞車狀況有變(哪段塞、塞多嚴重)就呼叫 onChange，
// 讓已連線的手機重抓路況(手機平常只在有人回報車速時才重抓，國道官方資料每分鐘會變)
let polling = false, lastSig = null;
function startPolling(onChange) {
  if (polling) return;
  polling = true;
  const tick = async () => {
    try { await ensureFresh(30000); } catch (_) {}
    if (!live) return;
    const sig = [...live.bySec].filter(([, v]) => v.level !== 'free').map(([k, v]) => k + v.level).join(',');
    if (lastSig !== null && sig !== lastSig) { try { onChange(); } catch (_) {} }
    lastSig = sig;
  };
  tick();
  setInterval(tick, 30 * 1000).unref(); // 每 30 秒看一次(實際下載是資料超過 1 分鐘才抓)
}

module.exports = { freewayFeatures, startPolling, cutIntoCells, parseWkt, LEVEL_BY_OFFICIAL };
