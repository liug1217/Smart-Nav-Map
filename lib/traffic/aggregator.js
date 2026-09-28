// Aggregate rolling-window traffic samples into a segment state object.
// Implements "median of per-contributor medians" to prevent a single session
// with many samples from dominating the result.

const { MIN_SAMPLES, MIN_CONTRIBUTORS, BASELINE_KMH, MAX_SPEED_KMH, LEVELS,
        ABS_CONGESTED_KMH, ABS_SLOW_KMH } = require('./config');
const { levelFromRatio } = require('./congestion');
const { computeConfidence } = require('./confidence');

const byLevel = name => LEVELS.find(l => l.level === name);

// 還沒學到這段路的順暢車速時：只用很低的絕對車速判定塞車，其他都算順暢
function levelFromAbsolute(speedKmh) {
  if (speedKmh < ABS_CONGESTED_KMH) return byLevel('congested');
  if (speedKmh < ABS_SLOW_KMH)      return byLevel('slow');
  return byLevel('free');
}

/**
 * Parse raw Redis ZRANGEBYSCORE members and compute the segment traffic state.
 *
 * Sample member format: `{sessionId}:{timestamp}:{speedKmh}`
 * sessionId is a UUID (no colons), so we split from the right.
 *
 * @param {string[]} samples   - raw sorted-set members
 * @param {number|null} [freeFlow] - 這段路學到的順暢車速；null = 還沒學到(改用絕對門檻)；
 *                                   省略 = 舊行為(全台共用 BASELINE_KMH)
 * @returns {object|null}      - null if insufficient data
 */
function computeState(samples, freeFlow) {
  if (!samples || samples.length < MIN_SAMPLES) return null;

  const speedBySession = {};
  for (const m of samples) {
    const last = m.lastIndexOf(':');
    const prev = m.lastIndexOf(':', last - 1);
    if (prev < 0) continue;
    const sId = m.slice(0, prev);
    const spd = parseInt(m.slice(last + 1), 10);
    if (isNaN(spd) || spd < 0 || spd > MAX_SPEED_KMH) continue;
    (speedBySession[sId] = speedBySession[sId] || []).push(spd);
  }

  const contributors = Object.keys(speedBySession);
  if (contributors.length < MIN_CONTRIBUTORS) return null;

  // One median per contributor → median of those medians
  const perContrib = contributors
    .map(id => {
      const s = [...speedBySession[id]].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    })
    .sort((a, b) => a - b);

  const medianSpeed  = perContrib[Math.floor(perContrib.length / 2)];
  const totalSamples = contributors.reduce((acc, id) => acc + speedBySession[id].length, 0);
  const learned      = typeof freeFlow === 'number' && freeFlow > 0;
  const baseline     = learned ? freeFlow : BASELINE_KMH;
  const speedRatio   = medianSpeed / baseline;
  const level        = (learned || freeFlow === undefined) ? levelFromRatio(speedRatio) : levelFromAbsolute(medianSpeed);
  const confidence   = computeConfidence(contributors.length);

  return {
    medianSpeed,
    baseline:           learned ? Math.round(freeFlow) : null,
    baselineSource:     learned ? 'learned' : 'none',
    speedRatio:         Math.round(speedRatio * 100) / 100,
    totalSamples,
    uniqueContributors: contributors.length,
    level,
    confidence,
  };
}

module.exports = { computeState };
