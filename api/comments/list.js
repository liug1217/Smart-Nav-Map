// GET /api/comments/list?layer=&lat=&lng=&sid=
// → { count, avg, items:[{ id, t, nick, avatar, stars, text, photos:[{id, taken, up}], mine }] }(新的在前)

const { corsHeaders, ok, err, methodNotAllowed } = require('../../lib/response');
const { listComments } = require('../../lib/comments');

module.exports = async (req, res) => {
  corsHeaders(res);
  if (req.method !== 'GET') return methodNotAllowed(res);
  try {
    const r = await listComments(req.query);
    return r.error ? err(res, 400, r.error, 'Invalid place') : ok(res, r);
  } catch (e) {
    console.error('[comments/list]', e.message);
    return err(res, 503, 'service_unavailable', 'Storage error');
  }
};
