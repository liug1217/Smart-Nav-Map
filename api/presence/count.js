// GET /api/presence/count
// Returns { online, moving, trafficSources, updatedAt }.
// "trafficSources" = sessions with a recent system-validated traffic sample
// (system-determined, NOT user-selected opt-in).

const { corsHeaders, methodNotAllowed, ok, err } = require('../../lib/response');
const { getCounts } = require('../../lib/presence/presence');

module.exports = async (req, res) => {
  corsHeaders(res);
  if (req.method !== 'GET') return methodNotAllowed(res);

  try {
    const counts = await getCounts();
    return ok(res, { ...counts, updatedAt: new Date().toISOString() }, { cache: 'public, max-age=15' });
  } catch (e) {
    console.error('[presence/count]', e.message);
    return err(res, 503, 'service_unavailable', 'Redis error');
  }
};
