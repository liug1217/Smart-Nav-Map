// GET /api/stats/overview
// 統計網站一次要用的全部資料：現在在線 / 開車 / 分享位置的車友、每日與每小時使用統計、
// 路況資料量、伺服器運作狀態。只有人數與總量，沒有任何個人資料或位置。

const fs = require('fs');
const path = require('path');
const { corsHeaders, methodNotAllowed, ok, err } = require('../../lib/response');
const { redisCmd } = require('../../lib/redis');
const { getCounts } = require('../../lib/presence/presence');
const { summary } = require('../../lib/stats');
const { metrics } = require('../../lib/server-metrics');

const hv = (a, b) => {
  const R = 6371000, r = Math.PI / 180;
  const dLa = (b[1] - a[1]) * r, dLo = (b[0] - a[0]) * r;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

// 路況資料總量：只有資料存在本機時算得出來(要掃過所有資料)；結果快取 5 分鐘
let _trafficCache = null, _trafficCacheAt = 0;
function trafficTotals() {
  if (!process.env.SNM_DATA_DIR) return null;
  if (_trafficCache && Date.now() - _trafficCacheAt < 5 * 60 * 1000) return _trafficCache;
  const keys = require('../../lib/local-store')._keys;
  let segments = 0, samples = 0, meters = 0;
  const t = Date.now();
  for (const [k, e] of keys) {
    if (e.exp && e.exp <= t) continue;
    if (k.startsWith('geo:')) {
      segments++;
      try { const l = JSON.parse(e.value); for (let i = 1; i < l.length; i++) meters += hv(l[i - 1], l[i]); } catch (_) {}
    } else if (k.startsWith('ff:')) {
      try { samples += JSON.parse(e.value).n || 0; } catch (_) {}
    }
  }
  let storeKB = null;
  try { storeKB = Math.round(fs.statSync(path.join(process.env.SNM_DATA_DIR, 'store.json')).size / 1024); } catch (_) {}
  _trafficCache = { segments, speedSamples: samples, km: Math.round(meters / 100) / 10, storeKB };
  _trafficCacheAt = Date.now();
  return _trafficCache;
}

module.exports = async (req, res) => {
  corsHeaders(res);
  if (req.method !== 'GET') return methodNotAllowed(res);
  try {
    const now = Date.now();
    const [counts, sharing, activeSegs, stats] = await Promise.all([
      getCounts(),
      redisCmd('ZCOUNT', 'cars:active', String(now), '+inf'),
      redisCmd('ZCOUNT', 'traffic:segs', String(now - 30 * 60 * 1000), '+inf'),
      summary(14),
    ]);
    return ok(res, {
      now: { ...counts, sharingCars: Number(sharing) || 0 },
      stats,
      traffic: { activeSegments: Number(activeSegs) || 0, ...(trafficTotals() || {}) },
      server: metrics.startedAt
        ? { startedAt: new Date(metrics.startedAt).toISOString(), uptimeS: Math.round((now - metrics.startedAt) / 1000),
            requests: metrics.requests, errors: metrics.errors }
        : null,
      updatedAt: new Date(now).toISOString(),
    });
  } catch (e) {
    console.error('[stats/overview]', e.message);
    return err(res, 503, 'service_unavailable', 'Storage error');
  }
};
