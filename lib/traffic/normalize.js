// Normalize a raw GPS payload into a validated TrafficSample,
// or return a {filtered} reason code if the reading should be skipped.
//
// This layer does NOT do map-matching (geohash is the placeholder).
// Caller (position.js) gets { sample } or { filtered } or { error }.

const { ghEncode, headingToDir, haversineKm } = require('./geohash');
const {
  MAX_ACCURACY_M, MAX_SPEED_KMH, MIN_MOVING_KMH, MAX_JUMP_KMH, GEOHASH_PRECISION,
} = require('./config');

/**
 * @param {object} input
 *   latitude, longitude, speed (km/h or null), heading, accuracy, timestamp
 * @param {object|null} lastPos   - { lat, lng, ts } from Redis lastpos:{sessionId}
 * @returns {{ sample } | { filtered: string } | { error: string }}
 */
function normalizeGps(input, lastPos) {
  const { latitude, longitude, speed, heading, accuracy, timestamp } = input;
  const now = Date.now();
  const ts  = Number(timestamp) || now;

  // GPS accuracy filter
  if (typeof accuracy === 'number' && accuracy > MAX_ACCURACY_M) {
    return { filtered: 'accuracy_poor' };
  }

  // Speed in km/h (browser provides m/s, caller must have converted already)
  let speedKmh = (typeof speed === 'number') ? speed : null;
  if (speedKmh !== null && (speedKmh < 0 || speedKmh > MAX_SPEED_KMH)) {
    return { filtered: 'speed_invalid' };
  }

  // Position-jump check and derived speed
  if (lastPos) {
    try {
      const dtMs = ts - lastPos.ts;
      if (dtMs > 0 && dtMs < 120000) {
        const distKm    = haversineKm(lastPos.lat, lastPos.lng, latitude, longitude);
        const impliedKmh = (distKm / dtMs) * 3_600_000;
        if (impliedKmh > MAX_JUMP_KMH) {
          return { filtered: 'position_jump' };
        }
        // Derive speed from displacement when browser didn't provide it
        if ((speedKmh === null || speedKmh === 0) && distKm > 0.005) {
          speedKmh = impliedKmh;
        }
      }
    } catch (_) {}
  }

  // Stationary filter — don't add 0 km/h to road stats
  const effectiveSpeed = speedKmh !== null ? speedKmh : 0;
  if (effectiveSpeed < MIN_MOVING_KMH) {
    return { filtered: 'stationary' };
  }

  const gh  = ghEncode(latitude, longitude, GEOHASH_PRECISION);
  const dir = headingToDir(heading);

  return {
    sample: {
      latitude, longitude, ts,
      speedKmh: Math.round(effectiveSpeed),
      gh, dir,
      segKey: `ts:${gh}:${dir}`,
    },
  };
}

module.exports = { normalizeGps };
