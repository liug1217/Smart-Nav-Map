// POST /api/comments/add
// Body: { sessionId, nick, avatar, layer, name, lat, lng, stars(1～5 必填), text, photos:[照片編號] }

const { corsHeaders, handlePreflight, ok, err, methodNotAllowed } = require('../../lib/response');
const { addComment } = require('../../lib/comments');

module.exports = async (req, res) => {
  corsHeaders(res);
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res);
  try {
    const r = await addComment(req.body);
    return r.error ? err(res, 400, r.error, 'Invalid comment') : ok(res, r);
  } catch (e) {
    console.error('[comments/add]', e.message);
    return err(res, 503, 'service_unavailable', 'Storage error');
  }
};
