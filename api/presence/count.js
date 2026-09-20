// GET /api/presence/count
// 回傳目前在線人數、移動中人數、提供路況資料人數。
// { online, moving, trafficContributors, updatedAt }

async function redisCmd(...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL / TOKEN 未設定');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') { res.status(405).end(); return; }

  const now = Date.now();

  try {
    // 先清除過期的 session（score < now 表示已過期）
    const expired = String(now - 1);
    await Promise.all([
      redisCmd('ZREMRANGEBYSCORE', 'hb:sessions', '-inf', expired),
      redisCmd('ZREMRANGEBYSCORE', 'hb:moving',   '-inf', expired),
      redisCmd('ZREMRANGEBYSCORE', 'hb:contrib',  '-inf', expired),
    ]);

    // 統計各集合中還有效的成員（score >= now 表示尚未過期）
    const [online, moving, trafficContributors] = await Promise.all([
      redisCmd('ZCOUNT', 'hb:sessions', String(now), '+inf'),
      redisCmd('ZCOUNT', 'hb:moving',   String(now), '+inf'),
      redisCmd('ZCOUNT', 'hb:contrib',  String(now), '+inf'),
    ]);

    res.setHeader('Cache-Control', 'public, max-age=15');
    res.json({
      online:              Number(online)              || 0,
      moving:              Number(moving)              || 0,
      trafficContributors: Number(trafficContributors) || 0,
      updatedAt:           new Date(now).toISOString(),
    });
  } catch (e) {
    console.error('[presence/count]', e.message);
    res.status(503).json({ error: 'service_unavailable' });
  }
};
