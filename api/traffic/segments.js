// GET /api/traffic/segments?n=&s=&e=&w=
// Returns a GeoJSON FeatureCollection of road segments with crowd-sourced
// traffic state within the given bounding box.
// "No data" ≠ free flow — segments with insufficient samples are omitted.

const { corsHeaders, methodNotAllowed, ok, err } = require('../../lib/response');
const { parseBbox } = require('../../lib/validation');
const { redisCmd, redisPipeline } = require('../../lib/redis');
const { ghDecode } = require('../../lib/traffic/geohash');
const { computeState } = require('../../lib/traffic/aggregator');
const { ROLLING_WINDOW_MS } = require('../../lib/traffic/config');
const { ffKey, rcKey, resolveBaseline } = require('../../lib/traffic/baseline');
const { freewayFeatures } = require('../../lib/traffic/freeway');

// 手機路況 + 國道官方路況合併：同一格同方向兩邊都有時，取比較塞的(寧可提早提醒)
const LEVEL_RANK = { free: 0, moderate: 1, slow: 2, congested: 3, severe: 4 };
function mergeTraffic(gps, freeway) {
  const byId = new Map();
  for (const f of freeway.concat(gps)) {
    const id = f.properties.segmentId, old = byId.get(id);
    if (!old || (LEVEL_RANK[f.properties.trafficLevel] || 0) > (LEVEL_RANK[old.properties.trafficLevel] || 0)) byId.set(id, f);
  }
  return [...byId.values()];
}
const SEG_ACTIVE_WINDOW_MS  = 30 * 60 * 1000;

// 路況要畫成道路線段：優先用使用者實際開過的軌跡；沒有軌跡時，
// 依行進方向在格子中心畫一小段(方向不明就只能畫成點)
const FALLBACK_HALF_M = 50;
function segmentGeometry(seg, geoJson) {
  if (geoJson) {
    try {
      const line = JSON.parse(geoJson);
      if (Array.isArray(line) && line.length >= 2) return { type: 'LineString', coordinates: line };
    } catch (_) {}
  }
  const dLat = FALLBACK_HALF_M / 110540;
  const dLng = FALLBACK_HALF_M / (111320 * Math.cos(seg.lat * Math.PI / 180));
  const c = [seg.lng, seg.lat];
  switch (seg.dir) {
    case 'N': return { type: 'LineString', coordinates: [[c[0], c[1] - dLat], [c[0], c[1] + dLat]] };
    case 'S': return { type: 'LineString', coordinates: [[c[0], c[1] + dLat], [c[0], c[1] - dLat]] };
    case 'E': return { type: 'LineString', coordinates: [[c[0] - dLng, c[1]], [c[0] + dLng, c[1]]] };
    case 'W': return { type: 'LineString', coordinates: [[c[0] + dLng, c[1]], [c[0] - dLng, c[1]]] };
    default:  return { type: 'Point', coordinates: c };
  }
}

module.exports = async (req, res) => {
  corsHeaders(res);
  if (req.method !== 'GET') return methodNotAllowed(res);

  const bbox = parseBbox(req.query);
  if (bbox.error) return err(res, 400, bbox.error, 'n, s, e, w query params required');
  const { north, south, east, west } = bbox;

  const now         = Date.now();
  const windowStart = now - ROLLING_WINDOW_MS;
  const activeFrom  = now - (30 * 60 * 1000);

  try {
    const members = await redisCmd('ZRANGEBYSCORE', 'traffic:segs', String(activeFrom), '+inf');

    const fw = await freewayFeatures(bbox);
    if (!members || members.length === 0) {
      return ok(res, { type: 'FeatureCollection', features: fw, updatedAt: now }, { cache: 'public, max-age=15' });
    }

    // Filter to bbox and deduplicate
    const inBbox = [];
    const seen   = new Set();
    for (const m of members) {
      const [gh, dir] = m.split('|');
      if (!gh || !dir) continue;
      const key = `${gh}|${dir}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { lat, lng } = ghDecode(gh);
      if (lat < south || lat > north || lng < west || lng > east) continue;
      inBbox.push({ gh, dir, lat, lng, segKey: `ts:${gh}:${dir}` });
    }

    if (inBbox.length === 0) {
      return ok(res, { type: 'FeatureCollection', features: fw, updatedAt: now }, { cache: 'public, max-age=15' });
    }

    // 一次批次取回：每段的近期車速樣本、學到的順暢車速、實際開過的道路軌跡
    const N = 4; // 每段取 4 筆：車速樣本、學到的順暢車速、軌跡、道路等級/速限
    const cmds = inBbox.flatMap(seg => [
      ['ZRANGEBYSCORE', seg.segKey, String(windowStart), '+inf'],
      ['GET', ffKey(seg.gh, seg.dir)],
      ['GET', `geo:${seg.gh}:${seg.dir}`],
      ['GET', rcKey(seg.gh, seg.dir)],
    ]);
    const results = await redisPipeline(cmds);
    const at = i => results[i] && results[i].result;

    const features = [];
    for (let i = 0; i < inBbox.length; i++) {
      const seg      = inBbox[i];
      const samples  = at(i * N);
      const base     = resolveBaseline(at(i * N + 1), at(i * N + 3));
      const state    = computeState(samples, base.kmh, base.source);
      if (!state) continue;

      features.push({
        type: 'Feature',
        geometry:   segmentGeometry(seg, at(i * N + 2)),
        properties: {
          segmentId:          `${seg.gh}:${seg.dir}`,
          direction:          seg.dir,
          averageSpeed:       Math.round(state.medianSpeed),
          speedRatio:         state.speedRatio,
          sampleCount:        state.totalSamples,
          uniqueContributors: state.uniqueContributors,
          baselineSpeed:      state.baseline,          // null = 這段路還在學習順暢車速
          baselineSource:     state.baselineSource,
          trafficLevel:       state.level.level,
          color:              state.level.color,
          label:              state.level.label,
          confidence:         state.confidence,
        },
      });
    }

    return ok(res, { type: 'FeatureCollection', features: mergeTraffic(features, fw), updatedAt: now }, { cache: 'public, max-age=15' });
  } catch (e) {
    console.error('[traffic/segments]', e.message);
    return err(res, 503, 'service_unavailable', 'Redis error');
  }
};
