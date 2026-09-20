// All traffic system constants — one place to tune.

module.exports = {
  // GPS quality thresholds
  MAX_ACCURACY_M:       150,   // reject if accuracy > this
  MAX_SPEED_KMH:        200,   // reject impossibly fast readings
  MIN_MOVING_KMH:       5,     // below this = stationary, skip sample
  MAX_JUMP_KMH:         250,   // implied speed between two points — reject as GPS jump

  // Rolling window
  ROLLING_WINDOW_MS:    10 * 60 * 1000,   // 10-min speed samples
  SAMPLE_TTL_S:         12 * 60,           // Redis key TTL for ts:{gh}:{dir}

  // Geohash
  GEOHASH_PRECISION:    7,      // ≈ 153m × 153m cells

  // Rate limiting for GPS upload (per session)
  RATE_LIMIT_MS:        4000,   // minimum interval between position uploads

  // Congestion level thresholds (speedRatio = currentSpeed / baseline)
  LEVELS: [
    { minRatio: 0.75, level: 'free',      color: '#00C853', label: '順暢' },
    { minRatio: 0.55, level: 'moderate',  color: '#FFD600', label: '車多' },
    { minRatio: 0.40, level: 'slow',      color: '#FF6D00', label: '緩慢' },
    { minRatio: 0.25, level: 'congested', color: '#D32F2F', label: '壅塞' },
    { minRatio: 0,   level: 'severe',    color: '#7B0000', label: '嚴重壅塞' },
  ],

  // Hysteresis: clear-traffic threshold is higher than enter-congestion threshold
  // (prevents flickering near the boundary)
  HYSTERESIS_BUFFER: 0.10,

  // Placeholder baseline until historical profiles are built
  BASELINE_KMH: 50,

  // Minimum contributors required to show any traffic color
  MIN_SAMPLES:           2,
  MIN_CONTRIBUTORS:      1,

  // Confidence thresholds (unique contributors)
  HIGH_CONF_CONTRIBUTORS:   8,
  MEDIUM_CONF_CONTRIBUTORS: 3,

  // Contributor badge TTL (trafficSources count)
  CONTRIB_TTL_MS:       5 * 60 * 1000,
};
