// GET /api/health
// 快速健康檢查端點，確認 API 服務正常。
// 可選擇性地 ping Redis，但不執行昂貴計算。

async function checkRedis() {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return 'not_configured';
  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(['PING']),
    });
    const d = await r.json();
    return d.result === 'PONG' ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') { res.status(405).end(); return; }

  const redis = await checkRedis().catch(() => 'error');
  const ok = redis === 'ok' || redis === 'not_configured';

  res.status(ok ? 200 : 503).json({
    ok,
    service:   'smart-nav-api',
    redis,
    timestamp: new Date().toISOString(),
  });
};
