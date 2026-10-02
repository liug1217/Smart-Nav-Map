// POST /api/comments/delete   Body: { sessionId, layer, lat, lng, id }
// 只能刪自己的留言(同一支手機)；照片檔一起刪掉

const { corsHeaders, handlePreflight, ok, err, methodNotAllowed } = require('../../lib/response');
const { deleteComment } = require('../../lib/comments');

module.exports = async (req, res) => {
  corsHeaders(res);
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res);
  try {
    const e = await deleteComment(req.body);
    return e ? err(res, e === 'not_owner' ? 403 : 400, e, 'Cannot delete') : ok(res, { ok: true });
  } catch (e) {
    console.error('[comments/delete]', e.message);
    return err(res, 503, 'service_unavailable', 'Storage error');
  }
};
