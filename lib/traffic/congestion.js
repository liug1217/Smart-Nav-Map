// Compute congestion level from a speed ratio.
const { LEVELS } = require('./config');

/**
 * Returns the matching level object { minRatio, level, color, label }
 * for the given speedRatio (currentSpeed / baseline).
 */
function levelFromRatio(speedRatio) {
  for (const lvl of LEVELS) {
    if (speedRatio >= lvl.minRatio) return lvl;
  }
  return LEVELS[LEVELS.length - 1];
}

module.exports = { levelFromRatio };
