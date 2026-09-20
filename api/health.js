// GET /api/health
// Quick connectivity check. Pings Redis; does not run expensive queries.

const { corsHeaders, methodNotAllowed } = require('../lib/response');
const { redisPing } = require('../lib/redis');

module.exports = async (req, res) => {
  corsHeaders(res);
  if (req.method !== 'GET') return methodNotAllowed(res);

  const redis = await redisPing();
  const configured = !!process.env.UPSTASH_REDIS_REST_URL;
  const ok = redis === 'ok' || (!configured && redis === 'error');

  res.status(ok ? 200 : 503).json({
    ok,
    service:   'smart-nav-api',
    redis:     configured ? redis : 'not_configured',
    timestamp: new Date().toISOString(),
  });
};
