// Shared input validation helpers.
// Each function returns null on success, or an error code string on failure.

const SESSION_RE = /^[a-zA-Z0-9\-_]{8,128}$/;
const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000; // 5 minutes

function validateSessionId(id) {
  if (!id || typeof id !== 'string' || !SESSION_RE.test(id)) return 'invalid_session';
  return null;
}

function validateCoords(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return 'invalid_coords';
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180)  return 'invalid_coords';
  return null;
}

// toleranceMs defaults to 5 minutes; position uploads use 2 minutes
function validateTimestamp(timestamp, toleranceMs = MAX_TIMESTAMP_SKEW_MS) {
  const ts  = Number(timestamp);
  if (!isFinite(ts)) return 'invalid_timestamp';
  if (Math.abs(Date.now() - ts) > toleranceMs) return 'timestamp_out_of_range';
  return null;
}

// speed in km/h; null means unknown (not provided by browser)
function validateSpeed(speedKmh, maxKmh = 200) {
  if (speedKmh === null) return null;
  if (speedKmh < 0 || speedKmh > maxKmh) return 'speed_invalid';
  return null;
}

function validateAccuracy(accuracy, maxM = 150) {
  if (typeof accuracy !== 'number') return null;
  if (accuracy > maxM) return 'accuracy_poor';
  return null;
}

// Parse bbox query params (n, s, e, w) → null on success, error code on failure
function parseBbox(query) {
  const n = parseFloat(query.n), s = parseFloat(query.s);
  const e = parseFloat(query.e), w = parseFloat(query.w);
  if ([n, s, e, w].some(isNaN)) return { error: 'bbox_required' };
  return { north: n, south: s, east: e, west: w };
}

module.exports = { validateSessionId, validateCoords, validateTimestamp, validateSpeed, validateAccuracy, parseBbox };
