// POST /api/cars/stop
// 使用者關閉分享、或關掉 App 時呼叫：立刻從別人的地圖上移除。
// 關 App 時用 navigator.sendBeacon 送出(跨網域只能用 text/plain)，所以 body 可能是字串。

const { corsHeaders, handlePreflight, ok, err, methodNotAllowed } = require('../../lib/response');
const { validPubId, removeCar } = require('../../lib/cars');

module.exports = async (req, res) => {
  corsHeaders(res);
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res);

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
  const pubId = body && body.pubId;
  if (!validPubId(pubId)) return err(res, 400, 'invalid_id', 'Invalid car id');

  try {
    await removeCar(pubId);
    return ok(res, { ok: true });
  } catch (e) {
    console.error('[cars/stop]', e.message);
    return err(res, 503, 'service_unavailable', 'Storage error');
  }
};
