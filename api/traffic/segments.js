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
const SEG_ACTIVE_WINDOW_MS  = 30 * 60 * 1000;

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

    if (!members || members.length === 0) {
      return ok(res, { type: 'FeatureCollection', features: [], updatedAt: now }, { cache: 'public, max-age=15' });
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
      return ok(res, { type: 'FeatureCollection', features: [], updatedAt: now }, { cache: 'public, max-age=15' });
    }

    // Batch-fetch samples via pipeline
    const cmds    = inBbox.map(seg => ['ZRANGEBYSCORE', seg.segKey, String(windowStart), '+inf']);
    const results = await redisPipeline(cmds);

    const features = [];
    for (let i = 0; i < inBbox.length; i++) {
      const seg     = inBbox[i];
      const samples = results[i] && results[i].result;
      const state   = computeState(samples);
      if (!state) continue;

      features.push({
        type: 'Feature',
        geometry:   { type: 'Point', coordinates: [seg.lng, seg.lat] },
        properties: {
          segmentId:          `${seg.gh}:${seg.dir}`,
          direction:          seg.dir,
          averageSpeed:       Math.round(state.medianSpeed),
          speedRatio:         state.speedRatio,
          sampleCount:        state.totalSamples,
          uniqueContributors: state.uniqueContributors,
          trafficLevel:       state.level.level,
          color:              state.level.color,
          label:              state.level.label,
          confidence:         state.confidence,
        },
      });
    }

    return ok(res, { type: 'FeatureCollection', features, updatedAt: now }, { cache: 'public, max-age=15' });
  } catch (e) {
    console.error('[traffic/segments]', e.message);
    return err(res, 503, 'service_unavailable', 'Redis error');
  }
};
