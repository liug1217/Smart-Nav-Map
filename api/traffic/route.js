// GET /api/traffic/route?coords=[[lng,lat],...]
// Returns traffic state for all geohash cells along a navigation route.
// Used by the frontend to warn of congestion ahead on the active route.

const { corsHeaders, methodNotAllowed, ok, err } = require('../../lib/response');
const { redisPipeline } = require('../../lib/redis');
const { ghEncode } = require('../../lib/traffic/geohash');
const { computeState } = require('../../lib/traffic/aggregator');
const { ROLLING_WINDOW_MS, GEOHASH_PRECISION } = require('../../lib/traffic/config');

const DIRS = ['N', 'E', 'S', 'W', 'U'];

module.exports = async (req, res) => {
  corsHeaders(res);
  if (req.method !== 'GET') return methodNotAllowed(res);

  let coords;
  try   { coords = JSON.parse(req.query.coords || '[]'); }
  catch { return err(res, 400, 'invalid_coords_json', 'coords must be a valid JSON array'); }

  if (!Array.isArray(coords) || coords.length < 2) {
    return err(res, 400, 'need_at_least_2_coords', 'provide at least 2 [lng, lat] pairs');
  }

  const now         = Date.now();
  const windowStart = now - ROLLING_WINDOW_MS;

  try {
    const ghSet = new Set();
    for (const [lng, lat] of coords) {
      if (typeof lat === 'number' && typeof lng === 'number') {
        ghSet.add(ghEncode(lat, lng, GEOHASH_PRECISION));
      }
    }

    const ghList  = [...ghSet];
    const segKeys = ghList.flatMap(gh => DIRS.map(dir => `ts:${gh}:${dir}`));
    const cmds    = segKeys.map(k => ['ZRANGEBYSCORE', k, String(windowStart), '+inf']);
    const results = await redisPipeline(cmds);

    const segments = [];
    for (let i = 0; i < segKeys.length; i++) {
      const samples = results[i] && results[i].result;
      const state   = computeState(samples);
      if (!state) continue;
      const ghIdx  = Math.floor(i / DIRS.length);
      const dirIdx = i % DIRS.length;
      segments.push({
        segmentId:          `${ghList[ghIdx]}:${DIRS[dirIdx]}`,
        direction:          DIRS[dirIdx],
        averageSpeed:       Math.round(state.medianSpeed),
        speedRatio:         state.speedRatio,
        sampleCount:        state.totalSamples,
        uniqueContributors: state.uniqueContributors,
        trafficLevel:       state.level.level,
        color:              state.level.color,
        label:              state.level.label,
        confidence:         state.confidence,
      });
    }

    return ok(res, { segments, updatedAt: now }, { cache: 'public, max-age=15' });
  } catch (e) {
    console.error('[traffic/route]', e.message);
    return err(res, 503, 'service_unavailable', 'Redis error');
  }
};
