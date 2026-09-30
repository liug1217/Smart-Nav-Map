// POST /api/cars/position
// 使用者同意「分享我的車給其他車友看」後才會呼叫，約每 5 秒一次。
// Body: { pubId, timestamp, latitude, longitude, heading, speed (km/h) }

const { corsHeaders, handlePreflight, ok, err, methodNotAllowed } = require('../../lib/response');
const { validateCoords, validateTimestamp } = require('../../lib/validation');
const { checkRateLimit } = require('../../lib/rate-limit');
const { validPubId, upsertCar } = require('../../lib/cars');

module.exports = async (req, res) => {
  corsHeaders(res);
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res);

  const { pubId, timestamp, latitude, longitude, heading, speed } = req.body || {};
  if (!validPubId(pubId)) return err(res, 400, 'invalid_id', 'Invalid car id');
  const e1 = validateCoords(latitude, longitude);
  if (e1) return err(res, 400, e1, 'Invalid coordinates');
  const e2 = validateTimestamp(timestamp, 120_000);
  if (e2) return err(res, 400, e2, 'Stale or invalid timestamp');

  try {
    if (await checkRateLimit('car:' + pubId, 2000)) return err(res, 429, 'too_fast', 'Upload rate exceeded');
    await upsertCar(pubId, {
      lat:     +latitude.toFixed(6),
      lng:     +longitude.toFixed(6),
      heading: typeof heading === 'number' && isFinite(heading) ? Math.round(((heading % 360) + 360) % 360) : null,
      speed:   typeof speed === 'number' && isFinite(speed) && speed >= 0 && speed < 250 ? Math.round(speed) : null,
      ts:      Date.now(),
    });
    require('../../lib/live').notify('cars'); // 即時推送：車友位置更新
    return ok(res, { ok: true });
  } catch (e) {
    console.error('[cars/position]', e.message);
    return err(res, 503, 'service_unavailable', 'Storage error');
  }
};
