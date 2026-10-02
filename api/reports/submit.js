// POST /api/reports/submit
// 使用者回報地標有問題。Body: { sessionId, layer, name, lat, lng, reason, note }
// reason：gone(已經沒了) / duplicate(重複) / position(位置不對) / name(名稱不對) / other

const { corsHeaders, handlePreflight, ok, err, methodNotAllowed } = require('../../lib/response');
const { checkRateLimit } = require('../../lib/rate-limit');
const { cleanReport, addReport } = require('../../lib/reports');

module.exports = async (req, res) => {
  corsHeaders(res);
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res);

  const r = cleanReport(req.body);
  if (typeof r === 'string') return err(res, 400, r, 'Invalid report');

  try {
    if (await checkRateLimit('report:' + r.sid, 5000)) return err(res, 429, 'too_fast', 'Please wait a moment');
    const e = await addReport(r);
    if (e) return err(res, 429, e, 'Too many reports today');
    return ok(res, { ok: true });
  } catch (e) {
    console.error('[reports/submit]', e.message);
    return err(res, 503, 'service_unavailable', 'Storage error');
  }
};
