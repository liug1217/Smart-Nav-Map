// GET /api/traffic/status
// 回傳系統整體狀態：在線人數 + 活躍 traffic segment 數量。
// { online, moving, trafficContributors, trafficSegments, updatedAt }

async function redisCmd(...args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis 未設定');
  const r = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(args),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

const SEG_ACTIVE_MS = 30 * 60 * 1000; // 30 分鐘

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') { res.status(405).end(); return; }

  const now = Date.now();

  try {
    const expired    = String(now - 1);
    const activeFrom = String(now - SEG_ACTIVE_MS);

    // 清除過期 + 同時統計
    await Promise.all([
      redisCmd('ZREMRANGEBYSCORE', 'hb:sessions', '-inf', expired),
      redisCmd('ZREMRANGEBYSCORE', 'hb:moving',   '-inf', expired),
      redisCmd('ZREMRANGEBYSCORE', 'hb:contrib',  '-inf', expired),
      redisCmd('ZREMRANGEBYSCORE', 'traffic:segs','-inf', activeFrom),
    ]);

    const [online, moving, trafficContributors, trafficSegments] = await Promise.all([
      redisCmd('ZCOUNT', 'hb:sessions',  String(now), '+inf'),
      redisCmd('ZCOUNT', 'hb:moving',    String(now), '+inf'),
      redisCmd('ZCOUNT', 'hb:contrib',   String(now), '+inf'),
      redisCmd('ZCOUNT', 'traffic:segs', activeFrom,  '+inf'),
    ]);

    res.setHeader('Cache-Control', 'public, max-age=20');
    res.json({
      online:              Number(online)              || 0,
      moving:              Number(moving)              || 0,
      trafficContributors: Number(trafficContributors) || 0,
      trafficSegments:     Number(trafficSegments)     || 0,
      updatedAt:           new Date(now).toISOString(),
    });
  } catch (e) {
    console.error('[traffic/status]', e.message);
    res.status(503).json({ error: 'service_unavailable' });
  }
};
