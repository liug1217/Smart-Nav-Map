// GET /api/cars/nearby?n=&s=&e=&w=&self=
// 畫面範圍內、有同意分享的其他車友(不含自己)。

const { corsHeaders, methodNotAllowed, ok, err } = require('../../lib/response');
const { parseBbox } = require('../../lib/validation');
const { carsInBbox } = require('../../lib/cars');

module.exports = async (req, res) => {
  corsHeaders(res);
  if (req.method !== 'GET') return methodNotAllowed(res);

  const bbox = parseBbox(req.query);
  if (bbox.error) return err(res, 400, bbox.error, 'n, s, e, w query params required');

  try {
    const cars = await carsInBbox(bbox, String(req.query.self || ''));
    return ok(res, { cars, updatedAt: Date.now() });
  } catch (e) {
    console.error('[cars/nearby]', e.message);
    return err(res, 503, 'service_unavailable', 'Storage error');
  }
};
