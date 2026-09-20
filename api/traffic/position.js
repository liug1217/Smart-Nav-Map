// POST /api/traffic/position
// 接收匿名 GPS 位置資料，驗證後存入 rolling window。
// 不永久保存個人軌跡；只保存道路 segment 的聚合速度資料。
//
// Body: { sessionId, timestamp, latitude, longitude, speed, heading, accuracy, navigationActive }

const CFG = {
  MAX_SPEED_KMH:        200,   // 超過此速度視為異常
  MAX_ACCURACY_M:       150,   // GPS 精度差於此值不採用
  MIN_MOVING_KMH:       5,     // 低於此速度視為靜止，不加入路況統計
  ROLLING_WINDOW_MS:    10 * 60 * 1000,  // 10 分鐘滾動窗口
  SAMPLE_TTL_S:         12 * 60,         // Redis key TTL 12 分鐘
  CONTRIB_TTL_MS:       5 * 60 * 1000,   // 貢獻者記錄 5 分鐘有效
  RATE_LIMIT_MS:        4000,            // 同一 session 最快 4 秒上傳一次
  MAX_JUMP_KMH:         250,             // 位置跳躍超過此隱含速度視為異常
  GEOHASH_PRECISION:    7,               // ≈ 153m × 153m 的 cell
};

// ── Geohash ──────────────────────────────────────────────────────────────────
const GH32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function ghEncode(lat, lng, p) {
  let idx = 0, bit = 0, even = true;
  let laMin = -90, laMax = 90, lnMin = -180, lnMax = 180, hash = '';
  while (hash.length < p) {
    if (even) {
      const m = (lnMin + lnMax) / 2;
      if (lng >= m) { idx = (idx << 1) | 1; lnMin = m; } else { idx <<= 1; lnMax = m; }
    } else {
      const m = (laMin + laMax) / 2;
      if (lat >= m) { idx = (idx << 1) | 1; laMin = m; } else { idx <<= 1; laMax = m; }
    }
    even = !even;
    if (++bit === 5) { hash += GH32[idx]; idx = 0; bit = 0; }
  }
  return hash;
}

function ghDecode(hash) {
  let even = true, laMin = -90, laMax = 90, lnMin = -180, lnMax = 180;
  for (const c of hash) {
    const bits = GH32.indexOf(c);
    for (let i = 4; i >= 0; i--) {
      const b = (bits >> i) & 1;
      if (even) { const m = (lnMin + lnMax) / 2; if (b) lnMin = m; else lnMax = m; }
      else       { const m = (laMin + laMax) / 2; if (b) laMin = m; else laMax = m; }
      even = !even;
    }
  }
  return { lat: (laMin + laMax) / 2, lng: (lnMin + lnMax) / 2 };
}

// 將航向角分成 4 個象限（N/E/S/W），用於雙向道路分離
function headingToDir(h) {
  const deg = ((h % 360) + 360) % 360;
  if (deg >= 315 || deg < 45)  return 'N';
  if (deg >= 45  && deg < 135) return 'E';
  if (deg >= 135 && deg < 225) return 'S';
  return 'W';
}

// Haversine 距離（km）
function haversineKm(la1, ln1, la2, ln2) {
  const R = 6371, d2r = Math.PI / 180;
  const dLa = (la2 - la1) * d2r, dLn = (ln2 - ln1) * d2r;
  const a = Math.sin(dLa/2)**2 + Math.cos(la1*d2r)*Math.cos(la2*d2r)*Math.sin(dLn/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Redis helper ──────────────────────────────────────────────────────────────
async function redisCmd(...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis 未設定');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).end(); return; }

  const body = req.body || {};
  const { sessionId, timestamp, latitude, longitude, speed, heading, accuracy, navigationActive } = body;

  // ── 基本驗證 ─────────────────────────────────────────────────────────────
  if (!sessionId || typeof sessionId !== 'string' ||
      !/^[a-zA-Z0-9\-_]{8,128}$/.test(sessionId)) {
    res.status(400).json({ error: 'invalid_session' }); return;
  }
  if (typeof latitude !== 'number' || typeof longitude !== 'number' ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    res.status(400).json({ error: 'invalid_coords' }); return;
  }

  const now = Date.now();
  const ts = Number(timestamp) || now;
  if (Math.abs(now - ts) > 120000) {   // 超過 2 分鐘偏差
    res.status(400).json({ error: 'stale_timestamp' }); return;
  }

  // GPS 精度過差
  if (typeof accuracy === 'number' && accuracy > CFG.MAX_ACCURACY_M) {
    res.status(200).json({ ok: true, filtered: 'accuracy_poor' }); return;
  }

  // 速度單位：coords.speed 為 m/s，轉為 km/h
  let speedKmh = typeof speed === 'number' ? speed * 3.6 : null;
  if (speedKmh !== null && (speedKmh < 0 || speedKmh > CFG.MAX_SPEED_KMH)) {
    res.status(200).json({ ok: true, filtered: 'speed_invalid' }); return;
  }

  try {
    // ── Rate limit（每 session 最快 4 秒一次）─────────────────────────────
    const rlKey = `rl:pos:${sessionId}`;
    const lastTs = await redisCmd('GET', rlKey);
    if (lastTs && (now - Number(lastTs)) < CFG.RATE_LIMIT_MS) {
      res.status(429).json({ error: 'too_fast' }); return;
    }

    // ── 位置跳躍檢查 ─────────────────────────────────────────────────────
    const posKey = `lastpos:${sessionId}`;
    const lastPosStr = await redisCmd('GET', posKey);
    if (lastPosStr) {
      try {
        const lp = JSON.parse(lastPosStr);
        const dtMs = ts - lp.ts;
        if (dtMs > 0 && dtMs < 120000) {
          const distKm = haversineKm(lp.lat, lp.lng, latitude, longitude);
          const impliedKmh = (distKm / dtMs) * 3600000;
          if (impliedKmh > CFG.MAX_JUMP_KMH) {
            // 位置異常跳躍：接受新位置為新參考點，但跳過本次路況樣本
            await Promise.all([
              redisCmd('SETEX', rlKey,  '60', String(now)),
              redisCmd('SETEX', posKey, '120', JSON.stringify({ lat: latitude, lng: longitude, ts })),
            ]);
            res.status(200).json({ ok: true, filtered: 'position_jump' }); return;
          }
          // 如果瀏覽器未提供 speed，用位移自行推算
          if ((speedKmh === null || speedKmh === 0) && distKm > 0.005) {
            speedKmh = impliedKmh;
          }
        }
      } catch (_) {}
    }

    // ── 靜止過濾 ─────────────────────────────────────────────────────────
    const effectiveSpeed = speedKmh !== null ? speedKmh : 0;
    if (effectiveSpeed < CFG.MIN_MOVING_KMH) {
      await Promise.all([
        redisCmd('SETEX', rlKey,  '60',  String(now)),
        redisCmd('SETEX', posKey, '120', JSON.stringify({ lat: latitude, lng: longitude, ts })),
      ]);
      res.status(200).json({ ok: true, filtered: 'stationary' }); return;
    }

    // ── Geohash → 道路 segment ──────────────────────────────────────────
    const gh  = ghEncode(latitude, longitude, CFG.GEOHASH_PRECISION);
    const dir = (typeof heading === 'number' && !isNaN(heading)) ? headingToDir(heading) : 'U';

    // rolling window sorted set key
    const segKey = `ts:${gh}:${dir}`;

    // sample member 格式：{sessionId}:{timestamp}:{speedRounded}
    // sessionId 為 UUID（只含字母/數字/-），不含冒號，所以最後兩個 : 分隔 ts 和 speed
    const member = `${sessionId}:${ts}:${Math.round(effectiveSpeed)}`;
    const windowStart = now - CFG.ROLLING_WINDOW_MS;
    const contribExpiry = now + CFG.CONTRIB_TTL_MS;
    const center = ghDecode(gh);

    // 寫入所有資料（並行）
    await Promise.all([
      redisCmd('SETEX', rlKey,  '60',  String(now)),
      redisCmd('SETEX', posKey, '120', JSON.stringify({ lat: latitude, lng: longitude, ts })),
      // rolling window：加入新 sample，清除舊資料，刷新 TTL
      redisCmd('ZADD',              segKey, String(ts), member),
      redisCmd('ZREMRANGEBYSCORE',  segKey, '-inf', String(windowStart)),
      redisCmd('EXPIRE',            segKey, String(CFG.SAMPLE_TTL_S)),
      // 標記此 segment 最後活躍時間（供 segments API 做空間查詢）
      // member 格式：{gh}|{dir}  score = 最後活躍時間戳
      redisCmd('ZADD', 'traffic:segs', String(now), `${gh}|${dir}`),
      // 更新貢獻者清單（score = 過期時間戳）
      redisCmd('ZADD', 'hb:contrib', String(contribExpiry), sessionId),
    ]);

    res.status(200).json({ ok: true, segment: `${gh}:${dir}` });
  } catch (e) {
    console.error('[traffic/position]', e.message);
    res.status(503).json({ error: 'service_unavailable' });
  }
};
