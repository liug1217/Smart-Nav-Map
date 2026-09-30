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
const { markDriver } = require('../../lib/stats');
const { haversineKm } = require('../../lib/traffic/geohash');
const { ffKey, addSpeed, LEARN_TTL_S, rcKey, ROAD_INFO_TTL_S, encodeRoadInfo } = require('../../lib/traffic/baseline');
const { ROLLING_WINDOW_MS, SAMPLE_TTL_S, CONTRIB_TTL_MS, RATE_LIMIT_MS,
        GEO_MIN_M, GEO_MAX_M, GEO_MAX_GAP_MS, GEO_TTL_S, GEO_MAX_POINTS } = require('../../lib/traffic/config');

module.exports = async (req, res) => {
  corsHeaders(res);
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res);

  const { sessionId, timestamp, latitude, longitude, speed, heading, accuracy, navigationActive,
          roadClass, ramp, speedLimit } = req.body || {};

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

    markDriver(sessionId).catch(() => {}); // 使用統計：今天有開車的人數(只記匿名編號)
    require('../../lib/live').notify('traffic');  // 即時推送：路況有新資料
    require('../../lib/live').notify('presence'); // 開車中人數可能變了

    // ── 學習這段路的順暢車速(長期車速分布) ──────────────────────────────
    const fk = ffKey(sample.gh, sample.dir);
    const hist = await redisCmd('GET', fk);
    await redisCmd('SETEX', fk, String(LEARN_TTL_S), addSpeed(hist, sample.speedKmh));

    // ── 這段路的道路等級(OpenStreetMap 分類)與速限：還沒學到實際車速前，用它推估順暢車速 ──
    const roadInfo = encodeRoadInfo(roadClass, ramp, speedLimit);
    if (roadInfo) await redisCmd('SETEX', rcKey(sample.gh, sample.dir), String(ROAD_INFO_TTL_S), roadInfo);

    // ── 記下剛開過的這一小段軌跡，前端用它把路況畫成道路線段 ──────────────
    if (lastPos && ts - lastPos.ts > 0 && ts - lastPos.ts <= GEO_MAX_GAP_MS) {
      const dM = haversineKm(lastPos.lat, lastPos.lng, latitude, longitude) * 1000;
      if (dM >= GEO_MIN_M && dM <= GEO_MAX_M) {
        const gk   = `geo:${sample.gh}:${sample.dir}`;
        const from = [+lastPos.lng.toFixed(6), +lastPos.lat.toFixed(6)];
        const to   = [+longitude.toFixed(6), +latitude.toFixed(6)];
        let line = [from, to];
        // 同一台車在這一格裡接著開：把新的一小段接在原本線段後面，塞車時(每次只前進幾十公尺)才不會變成一截一截的虛線
        try {
          const prev = JSON.parse(await redisCmd('GET', gk) || 'null');
          const end  = Array.isArray(prev) && prev[prev.length - 1];
          if (end && haversineKm(end[1], end[0], from[1], from[0]) * 1000 < 5 && prev.length < GEO_MAX_POINTS) line = [...prev, to];
        } catch (_) {}
        await redisCmd('SETEX', gk, String(GEO_TTL_S), JSON.stringify(line));
      }
    }

    return ok(res, { segment: `${sample.gh}:${sample.dir}` });
  } catch (e) {
    console.error('[traffic/position]', e.message);
    return err(res, 503, 'service_unavailable', 'Redis error');
  }
};
