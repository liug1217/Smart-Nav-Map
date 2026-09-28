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

  // Congestion level thresholds (speedRatio = currentSpeed / 這段路學到的順暢車速)
  // 順暢用導航路線的淺藍色(用戶指定)
  LEVELS: [
    { minRatio: 0.75, level: 'free',      color: '#4783fe', label: '順暢' },
    { minRatio: 0.55, level: 'moderate',  color: '#FFB300', label: '車多' },
    { minRatio: 0.40, level: 'slow',      color: '#FF6D00', label: '緩慢' },
    { minRatio: 0.25, level: 'congested', color: '#E53935', label: '壅塞' },
    { minRatio: 0,   level: 'severe',    color: '#8B0000', label: '嚴重壅塞' },
  ],

  // 這段路還沒學到順暢車速時，改用保守的絕對車速門檻，避免把市區小路正常的 25~30 km/h 誤判成塞車
  ABS_CONGESTED_KMH: 10,   // 低於此 = 壅塞
  ABS_SLOW_KMH:      20,   // 低於此 = 緩慢，其他 = 順暢

  // Hysteresis: clear-traffic threshold is higher than enter-congestion threshold
  // (prevents flickering near the boundary)
  HYSTERESIS_BUFFER: 0.10,

  // 舊版的全台共用基準車速，現在只給沒有傳入順暢車速的舊呼叫端相容用
  BASELINE_KMH: 50,

  // 道路軌跡(畫路況線用)：兩次上傳間距在這範圍內才記錄成線段
  GEO_MIN_M:   10,
  GEO_MAX_M:   400,
  GEO_MAX_GAP_MS: 60 * 1000,
  GEO_TTL_S:   7 * 24 * 3600,
  GEO_MAX_POINTS: 12,      // 一格裡的軌跡最多接幾個點

  // Minimum contributors required to show any traffic color
  MIN_SAMPLES:           2,
  MIN_CONTRIBUTORS:      1,

  // Confidence thresholds (unique contributors)
  HIGH_CONF_CONTRIBUTORS:   8,
  MEDIUM_CONF_CONTRIBUTORS: 3,

  // Contributor badge TTL (trafficSources count)
  CONTRIB_TTL_MS:       5 * 60 * 1000,
};
