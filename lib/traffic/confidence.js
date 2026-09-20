// Compute confidence from unique contributor count.
const { HIGH_CONF_CONTRIBUTORS, MEDIUM_CONF_CONTRIBUTORS } = require('./config');

/**
 * Returns 'high' | 'medium' | 'low' based on how many unique
 * anonymous sessions contributed to this segment's sample.
 */
function computeConfidence(uniqueContributors) {
  if (uniqueContributors >= HIGH_CONF_CONTRIBUTORS)   return 'high';
  if (uniqueContributors >= MEDIUM_CONF_CONTRIBUTORS) return 'medium';
  return 'low';
}

module.exports = { computeConfidence };
