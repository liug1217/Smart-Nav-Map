// POST /api/comments/add
// Body: { sessionId, nick, avatar, layer, name, lat, lng, stars(1～5 必填), text, photos:[照片編號] }

const { corsHeaders, handlePreflight, ok, err, methodNotAllowed } = require('../../lib/response');
const { addComment, logFail } = require('../../lib/comments');

module.exports = async (req, res) => {
  corsHeaders(res);
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res);
  try {
    const r = await addComment(req.body);
    if (r.error) {
      const b = req.body || {};
      logFail('add', r.error, { layer: b.layer, stars: b.stars, photos: Array.isArray(b.photos) ? b.photos.length : typeof b.photos, sid: typeof b.sessionId === 'string' ? b.sessionId.length : typeof b.sessionId });
      return err(res, 400, r.error, 'Invalid comment');
    }
    return ok(res, r);
  } catch (e) {
    console.error('[comments/add]', e.message);
    return err(res, 503, 'service_unavailable', 'Storage error');
  }
};
