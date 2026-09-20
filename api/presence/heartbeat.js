// POST /api/presence/heartbeat
// Called every ~15 s to keep a session alive (TTL = 45 s in presence/ttl.js).
// moving: true when device is travelling > MIN_MOVING_KMH (determined by the caller).
// No user opt-in — all sessions with GPS participate automatically.

const { corsHeaders, handlePreflight, ok, err, methodNotAllowed } = require('../../lib/response');
const { validateSessionId, validateTimestamp } = require('../../lib/validation');
const { refreshPresence } = require('../../lib/presence/presence');

module.exports = async (req, res) => {
  corsHeaders(res);
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res);

  const { sessionId, moving, timestamp } = req.body || {};

  const e1 = validateSessionId(sessionId);
  if (e1) return err(res, 400, e1, 'Invalid session ID format');

  const e2 = validateTimestamp(timestamp);
  if (e2) return err(res, 400, e2, 'Timestamp too far from server time');

  try {
    // isTrafficSource is maintained by position.js; heartbeat only updates moving flag
    await refreshPresence(sessionId, !!moving, false);
    return ok(res, { ts: Date.now() });
  } catch (e) {
    console.error('[heartbeat]', e.message);
    return err(res, 503, 'service_unavailable', 'Redis error');
  }
};
