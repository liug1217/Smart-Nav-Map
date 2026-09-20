// GET /api/traffic/status
// System-wide overview: presence counts + active segment count.
// { online, moving, trafficSources, trafficSegments, updatedAt }

const { corsHeaders, methodNotAllowed, ok, err } = require('../../lib/response');
const { getCounts } = require('../../lib/presence/presence');
const { redisCmd } = require('../../lib/redis');

const SEG_ACTIVE_MS = 30 * 60 * 1000;

module.exports = async (req, res) => {
  corsHeaders(res);
  if (req.method !== 'GET') return methodNotAllowed(res);

  const now        = Date.now();
  const activeFrom = String(now - SEG_ACTIVE_MS);

  try {
    const [counts, rawSegs] = await Promise.all([
      getCounts(),
      redisCmd('ZCOUNT', 'traffic:segs', activeFrom, '+inf'),
    ]);

    return ok(res, {
      ...counts,
      trafficSegments: Number(rawSegs) || 0,
      updatedAt:       new Date(now).toISOString(),
    }, { cache: 'public, max-age=20' });
  } catch (e) {
    console.error('[traffic/status]', e.message);
    return err(res, 503, 'service_unavailable', 'Redis error');
  }
};
