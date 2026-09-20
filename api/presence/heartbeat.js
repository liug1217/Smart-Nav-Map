// POST /api/presence/heartbeat
// 每 15 秒由前端呼叫，維持 session 在線狀態（TTL=45s）。
// Body: { sessionId, timestamp, moving, navigationActive }

const HEARTBEAT_TTL = 45; // seconds

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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).end(); return; }

  const body = req.body || {};
  const { sessionId, moving, navigationActive, timestamp } = body;

  // 驗證 sessionId（只允許 UUID / 字母數字格式）
  if (!sessionId || typeof sessionId !== 'string' ||
      !/^[a-zA-Z0-9\-_]{8,128}$/.test(sessionId)) {
    res.status(400).json({ error: 'invalid_session' }); return;
  }

  const now = Date.now();
  const ts = Number(timestamp) || now;
  // 拒絕超過 5 分鐘偏差的 timestamp
  if (Math.abs(now - ts) > 300000) {
    res.status(400).json({ error: 'timestamp_out_of_range' }); return;
  }

  try {
    const expiryScore = now + HEARTBEAT_TTL * 1000;

    // 更新在線集合（sorted set，score = 過期時間戳 ms）
    const ops = [
      redisCmd('ZADD', 'hb:sessions', String(expiryScore), sessionId),
    ];

    // 更新移動狀態（moving = 速度 > 5 km/h）
    if (moving) {
      ops.push(redisCmd('ZADD', 'hb:moving', String(expiryScore), sessionId));
    } else {
      ops.push(redisCmd('ZREM', 'hb:moving', sessionId));
      // 停止移動時也一起清出貢獻者集合
      ops.push(redisCmd('ZREM', 'hb:contrib', sessionId));
    }

    await Promise.all(ops);

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[heartbeat]', e.message);
    res.status(503).json({ error: 'service_unavailable' });
  }
};
