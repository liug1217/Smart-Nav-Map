// Rate limiting via Redis for per-session upload throttle.
const { redisCmd } = require('./redis');

// Returns true if this request should be rate-limited (too soon since last).
// Also updates the timestamp on a successful pass.
async function checkRateLimit(sessionId, limitMs) {
  const key  = `rl:pos:${sessionId}`;
  const now  = Date.now();
  const last = await redisCmd('GET', key);
  if (last && (now - Number(last)) < limitMs) return true;
  // Carry the timestamp forward; TTL 60s (well beyond any realistic limit window)
  await redisCmd('SETEX', key, '60', String(now));
  return false;
}

module.exports = { checkRateLimit };
