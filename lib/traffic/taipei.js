// 臺北市區即時路況：臺北市交通局公開的路段資料(不用 TDX 金鑰)，約每分鐘更新。
//   GetVD.xml.gz：每個路段的名稱、平均車速 AvgSpd、塞車等級 MOELevel、起點/終點經緯度
// 路段是「起點 → 終點」的一條線(方向就是行車方向)；跟國道一樣切成 geohash 小格，格式同手機路況。

const zlib = require('zlib');
const { LEVELS } = require('./config');
const { cutIntoCells } = require('./freeway');

const URL = 'https://tcgbusfs.blob.core.windows.net/blobtisv/GetVD.xml.gz';
const LIVE_TTL_MS = 60 * 1000;
const LIVE_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_SECTION_M = 3000; // 少數路段座標錯誤(長達上千公里)，超過 3 公里的不用

// 臺北市塞車等級只有三級：0 順暢、1 車多、2 壅塞(-1 = 沒資料)
const LEVEL_BY_MOE = { 0: 'free', 1: 'moderate', 2: 'congested' };
const LEVEL_INFO = Object.fromEntries(LEVELS.map(l => [l.level, l]));

let live = null;        // { at, cells: [{ gh, dir, coords, lat, lng, name, speed, level }] }
let loading = null;

const tag = (b, n) => { const m = b.match(new RegExp('<vd:' + n + '>([^<]*)</vd:' + n + '>')); return m ? m[1].trim() : ''; };

function parse(xml) {
  const cells = [];
  for (const b of xml.match(/<vd:SectionData>[\s\S]*?<\/vd:SectionData>/g) || []) {
    const level = LEVEL_BY_MOE[Number(tag(b, 'MOELevel'))];
    const speed = Math.round(Number(tag(b, 'AvgSpd')));
    if (!level || level === 'free' || !(speed > 0)) continue; // 順暢的不送(前端本來就不畫)
    const a = [Number(tag(b, 'StartWgsX')), Number(tag(b, 'StartWgsY'))];
    const z = [Number(tag(b, 'EndWgsX')), Number(tag(b, 'EndWgsY'))];
    if (![a[0], a[1], z[0], z[1]].every(isFinite)) continue;
    const len = Math.hypot((z[0] - a[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (z[1] - a[1]) * 110540);
    if (!(len > 10 && len <= MAX_SECTION_M)) continue;
    const name = tag(b, 'SectionName').replace(/\s+/g, ' ');
    for (const c of cutIntoCells([a, z])) cells.push({ ...c, name, speed, level });
  }
  return cells;
}

async function load() {
  const r = await fetch(URL, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('GetVD HTTP ' + r.status);
  const xml = zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8');
  live = { at: Date.now(), cells: parse(xml) };
}

async function ensureFresh(timeoutMs) {
  if ((!live || Date.now() - live.at > LIVE_TTL_MS) && !loading) {
    loading = load().catch(e => console.error('[taipei-traffic]', e.message)).finally(() => { loading = null; });
  }
  if (loading && !live) await Promise.race([loading, new Promise(r => setTimeout(r, timeoutMs))]);
}

async function taipeiFeatures({ north, south, east, west }, timeoutMs = 4000) {
  try { await ensureFresh(timeoutMs); } catch (_) {}
  if (!live || Date.now() - live.at > LIVE_MAX_AGE_MS) return [];
  const out = [];
  for (const c of live.cells) {
    if (c.lat < south || c.lat > north || c.lng < west || c.lng > east) continue;
    const lv = LEVEL_INFO[c.level];
    out.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: c.coords },
      properties: {
        segmentId: `${c.gh}:${c.dir}`, direction: c.dir, averageSpeed: c.speed,
        speedRatio: null, sampleCount: null, uniqueContributors: null, baselineSpeed: null, baselineSource: null,
        trafficLevel: c.level, color: lv.color, label: lv.label, confidence: 'high',
        source: 'taipei', sectionName: c.name, updatedAt: live.at,
      },
    });
  }
  return out;
}

// 背景定時更新；塞車狀況有變就通知手機重抓(同國道)
let polling = false, lastSig = null;
function startPolling(onChange) {
  if (polling) return;
  polling = true;
  const tick = async () => {
    try { await ensureFresh(30000); } catch (_) {}
    if (!live) return;
    const sig = live.cells.map(c => c.gh + c.dir + c.level).join(',');
    if (lastSig !== null && sig !== lastSig) { try { onChange(); } catch (_) {} }
    lastSig = sig;
  };
  tick();
  setInterval(tick, 30 * 1000).unref();
}

module.exports = { taipeiFeatures, startPolling, parse, LEVEL_BY_MOE };
