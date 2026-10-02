// POST /api/comments/photo?sessionId=...            原圖(image/jpeg，不壓縮)→ { id, taken }
// POST /api/comments/photo?sessionId=...&thumbOf=id  同一張照片的縮圖(列表用)
// 伺服器會拿掉照片裡的 GPS 等資料(畫質不動)，拍攝日期另外記下來

const { corsHeaders, handlePreflight, ok, err, methodNotAllowed } = require('../../lib/response');
const { savePhoto, saveThumb, logFail } = require('../../lib/comments');

module.exports = async (req, res) => {
  corsHeaders(res);
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res);
  const sid = req.query.sessionId;
  const info = () => ({ type: req.headers['content-type'], bytes: Buffer.isBuffer(req.body) ? req.body.length : typeof req.body,
    head: Buffer.isBuffer(req.body) ? req.body.subarray(0, 8).toString('hex') : '', ua: String(req.headers['user-agent'] || '').slice(0, 80) });
  try {
    if (req.query.thumbOf) {
      const e = await saveThumb(sid, req.query.thumbOf, req.body);
      if (e) { logFail('thumb', e, info()); return err(res, 400, e, 'Invalid thumbnail'); }
      return ok(res, { ok: true });
    }
    const r = await savePhoto(sid, req.body);
    if (r.error) { logFail('photo', r.error, info()); return err(res, 400, r.error, 'Invalid photo'); }
    return ok(res, r);
  } catch (e) {
    console.error('[comments/photo]', e.message);
    return err(res, 503, 'service_unavailable', 'Storage error');
  }
};
