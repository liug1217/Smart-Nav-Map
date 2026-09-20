// Presence logic — heartbeat writes and count reads.
// "trafficSources" = sessions with a recent valid traffic sample (system-determined, not user-chosen).
const { redisCmd } = require('../redis');
const { HEARTBEAT_TTL_MS, SEG_ACTIVE_MS } = require('./ttl');

/**
 * Refresh a session's presence in Redis.
 *
 * @param {string}  sessionId
 * @param {boolean} moving          - speed > MOVING_THRESHOLD (set by position handler)
 * @param {boolean} isTrafficSource - system determined: GPS valid + map-matched + moving
 */
async function refreshPresence(sessionId, moving, isTrafficSource) {
  const now        = Date.now();
  const expiry     = now + HEARTBEAT_TTL_MS;
  const expiryStr  = String(expiry);

  const ops = [
    redisCmd('ZADD', 'hb:sessions', expiryStr, sessionId),
  ];

  if (moving) {
    ops.push(redisCmd('ZADD', 'hb:moving', expiryStr, sessionId));
  } else {
    // Not moving — remove from both moving and trafficSources sets
    ops.push(redisCmd('ZREM', 'hb:moving',  sessionId));
    ops.push(redisCmd('ZREM', 'hb:contrib', sessionId));
  }

  // trafficSources maintained by position.js when a sample is accepted;
  // heartbeat only clears it when stopped moving.
  await Promise.all(ops);
}

/**
 * Get current online / moving / trafficSources counts.
 * Prunes expired entries as a side-effect (lazy GC).
 */
async function getCounts() {
  const now       = Date.now();
  const expired   = String(now - 1);
  const activeFrom = String(now - SEG_ACTIVE_MS);

  await Promise.all([
    redisCmd('ZREMRANGEBYSCORE', 'hb:sessions', '-inf', expired),
    redisCmd('ZREMRANGEBYSCORE', 'hb:moving',   '-inf', expired),
    redisCmd('ZREMRANGEBYSCORE', 'hb:contrib',  '-inf', expired),
  ]);

  const [online, moving, trafficSources] = await Promise.all([
    redisCmd('ZCOUNT', 'hb:sessions', String(now), '+inf'),
    redisCmd('ZCOUNT', 'hb:moving',   String(now), '+inf'),
    redisCmd('ZCOUNT', 'hb:contrib',  String(now), '+inf'),
  ]);

  return {
    online:         Number(online)         || 0,
    moving:         Number(moving)         || 0,
    trafficSources: Number(trafficSources) || 0,
  };
}

module.exports = { refreshPresence, getCounts };
