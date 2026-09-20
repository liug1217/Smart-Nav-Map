// POST /api/traffic/position
// Receives anonymous GPS data from every active 智行地圖 session that has
// valid location permission. No user opt-in — participation is automatic.
//
// Body: { sessionId, timestamp, latitude, longitude, speed (km/h), heading, accuracy, navigationActive }

const { corsHeaders, handlePreflight, ok, err, methodNotAllowed } = require('../../lib/response');
const { validateSessionId, validateCoords, validateTimestamp } = require('../../lib/validation');
const { checkRateLimit } = require('../../lib/rate-limit');
const { redisCmd } = require('../../lib/redis');
const { normalizeGps } = require('../../lib/traffic/normalize');
const { ROLLING_WINDOW_MS, SAMPLE_TTL_S, CONTRIB_TTL_MS, RATE_LIMIT_MS } = require('../../lib/traffic/config');

module.exports = async (req, res) => {
  corsHeaders(res);
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res);

  const { sessionId, timestamp, latitude, longitude, speed, heading, accuracy, navigationActive } = req.body || {};

  // ── Validate ──────────────────────────────────────────────────────────────
  const e1 = validateSessionId(sessionId);
  if (e1) return err(res, 400, e1, 'Invalid session ID');

  const e2 = validateCoords(latitude, longitude);
  if (e2) return err(res, 400, e2, 'Invalid coordinates');

  const e3 = validateTimestamp(timestamp, 120_000); // 2-min tolerance for GPS uploads
  if (e3) return err(res, 400, e3, 'Stale or invalid timestamp');

  try {
    // ── Rate limit ────────────────────────────────────────────────────────
    const limited = await checkRateLimit(sessionId, RATE_LIMIT_MS);
    if (limited) return err(res, 429, 'too_fast', 'Upload rate exceeded');

    // ── Load last known position for jump-check / speed derivation ────────
    const posKey    = `lastpos:${sessionId}`;
    const lastPosStr = await redisCmd('GET', posKey);
    let lastPos = null;
    try { if (lastPosStr) lastPos = JSON.parse(lastPosStr); } catch (_) {}

    // Browser provides speed in m/s — convert to km/h
    const speedKmh = typeof speed === 'number' ? speed * 3.6 : null;
    const now = Date.now();
    const ts  = Number(timestamp) || now;

    // ── Normalize & filter ────────────────────────────────────────────────
    const norm = normalizeGps({ latitude, longitude, speed: speedKmh, heading, accuracy, timestamp: ts }, lastPos);

    // Always update last-pos reference (even for filtered readings)
    await redisCmd('SETEX', posKey, '120', JSON.stringify({ lat: latitude, lng: longitude, ts }));

    if (norm.filtered) {
      return ok(res, { filtered: norm.filtered });
    }

    const { sample } = norm;
    const windowStart    = now - ROLLING_WINDOW_MS;
    const contribExpiry  = now + CONTRIB_TTL_MS;
    const member         = `${sessionId}:${ts}:${sample.speedKmh}`;

    // ── Write traffic sample to Redis ─────────────────────────────────────
    await Promise.all([
      // rolling window sorted set
      redisCmd('ZADD',             sample.segKey, String(ts), member),
      redisCmd('ZREMRANGEBYSCORE', sample.segKey, '-inf', String(windowStart)),
      redisCmd('EXPIRE',           sample.segKey, String(SAMPLE_TTL_S)),
      // mark segment as recently active
      redisCmd('ZADD', 'traffic:segs', String(now), `${sample.gh}|${sample.dir}`),
      // mark this session as a current traffic source (system-determined)
      redisCmd('ZADD', 'hb:contrib', String(contribExpiry), sessionId),
      // update moving status
      redisCmd('ZADD', 'hb:moving', String(contribExpiry), sessionId),
    ]);

    return ok(res, { segment: `${sample.gh}:${sample.dir}` });
  } catch (e) {
    console.error('[traffic/position]', e.message);
    return err(res, 503, 'service_unavailable', 'Redis error');
  }
};
