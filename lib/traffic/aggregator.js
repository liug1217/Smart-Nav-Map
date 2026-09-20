// Aggregate rolling-window traffic samples into a segment state object.
// Implements "median of per-contributor medians" to prevent a single session
// with many samples from dominating the result.

const { MIN_SAMPLES, MIN_CONTRIBUTORS, BASELINE_KMH, MAX_SPEED_KMH } = require('./config');
const { levelFromRatio } = require('./congestion');
const { computeConfidence } = require('./confidence');

/**
 * Parse raw Redis ZRANGEBYSCORE members and compute the segment traffic state.
 *
 * Sample member format: `{sessionId}:{timestamp}:{speedKmh}`
 * sessionId is a UUID (no colons), so we split from the right.
 *
 * @param {string[]} samples   - raw sorted-set members
 * @param {number}   [baseline=BASELINE_KMH] - road-type speed baseline
 * @returns {object|null}      - null if insufficient data
 */
function computeState(samples, baseline = BASELINE_KMH) {
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
  const speedRatio   = medianSpeed / baseline;
  const level        = levelFromRatio(speedRatio);
  const confidence   = computeConfidence(contributors.length);

  return {
    medianSpeed,
    speedRatio:         Math.round(speedRatio * 100) / 100,
    totalSamples,
    uniqueContributors: contributors.length,
    level,
    confidence,
  };
}

module.exports = { computeState };
