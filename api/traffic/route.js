// GET /api/traffic/route?coords=[[[lng,lat],...]]
// 接受導航路線的座標點，回傳路線上各 segment 的路況。
// 用於前端在導航中判斷路線前方是否有壅塞。

const CFG = {
  ROLLING_WINDOW_MS:  10 * 60 * 1000,
  SEG_ACTIVE_MS:      30 * 60 * 1000,
  MIN_SAMPLES:        2,
  BASELINE_KMH:       50,
  GEOHASH_PRECISION:  7,
  LEVELS: [
    { minRatio: 0.75, level: 'free',      color: '#00C853', label: '順暢' },
    { minRatio: 0.55, level: 'moderate',  color: '#FFD600', label: '車多' },
    { minRatio: 0.40, level: 'slow',      color: '#FF6D00', label: '緩慢' },
    { minRatio: 0.25, level: 'congested', color: '#D32F2F', label: '壅塞' },
    { minRatio: 0,   level: 'severe',    color: '#7B0000', label: '嚴重壅塞' },
  ],
  HIGH_CONF:   8,
  MEDIUM_CONF: 3,
};

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

async function redisCmd(...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
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

async function redisPipeline(commands) {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis 未設定');
  const r = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  return r.json();
}

function computeState(samples) {
  if (!samples || samples.length < CFG.MIN_SAMPLES) return null;
  const speedBySession = {};
  for (const m of samples) {
    const last = m.lastIndexOf(':'), prev = m.lastIndexOf(':', last - 1);
    if (prev < 0) continue;
    const sId = m.slice(0, prev), spd = parseInt(m.slice(last + 1), 10);
    if (isNaN(spd) || spd < 0 || spd > 200) continue;
    (speedBySession[sId] = speedBySession[sId] || []).push(spd);
  }
  const contributors = Object.keys(speedBySession);
  if (!contributors.length) return null;
  const perC = contributors.map(id => {
    const s = [...speedBySession[id]].sort((a,b)=>a-b); return s[Math.floor(s.length/2)];
  }).sort((a,b)=>a-b);
  const medianSpeed = perC[Math.floor(perC.length / 2)];
  const speedRatio = medianSpeed / CFG.BASELINE_KMH;
  let lvl = CFG.LEVELS[CFG.LEVELS.length - 1];
  for (const l of CFG.LEVELS) { if (speedRatio >= l.minRatio) { lvl = l; break; } }
  const confidence = contributors.length >= CFG.HIGH_CONF ? 'high' :
                     contributors.length >= CFG.MEDIUM_CONF ? 'medium' : 'low';
  return { medianSpeed, speedRatio: Math.round(speedRatio*100)/100,
           totalSamples: contributors.reduce((s,id)=>s+speedBySession[id].length,0),
           uniqueContributors: contributors.length, level: lvl, confidence };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') { res.status(405).end(); return; }

  // coords 是 JSON 陣列：[[lng,lat], [lng,lat], ...]
  let coords;
  try {
    coords = JSON.parse(req.query.coords || '[]');
  } catch {
    res.status(400).json({ error: 'invalid_coords_json' }); return;
  }
  if (!Array.isArray(coords) || coords.length < 2) {
    res.status(400).json({ error: 'need_at_least_2_coords' }); return;
  }

  const now = Date.now();
  const windowStart = now - CFG.ROLLING_WINDOW_MS;

  try {
    // 將路線座標轉換成 geohash（去重）
    const ghSet = new Set();
    for (const [lng, lat] of coords) {
      if (typeof lat !== 'number' || typeof lng !== 'number') continue;
      ghSet.add(ghEncode(lat, lng, CFG.GEOHASH_PRECISION));
    }

    const ghList = [...ghSet];
    const dirs   = ['N', 'E', 'S', 'W', 'U'];

    // 為每個 geohash × direction 查詢樣本
    const segKeys = ghList.flatMap(gh => dirs.map(dir => `ts:${gh}:${dir}`));
    const cmds    = segKeys.map(k => ['ZRANGEBYSCORE', k, String(windowStart), '+inf']);
    const results = await redisPipeline(cmds);

    const segments = [];
    for (let i = 0; i < segKeys.length; i++) {
      const samples = results[i] && results[i].result;
      const state   = computeState(samples);
      if (!state) continue;
      const ghIdx = Math.floor(i / dirs.length);
      const dirIdx = i % dirs.length;
      segments.push({
        segmentId:         `${ghList[ghIdx]}:${dirs[dirIdx]}`,
        direction:         dirs[dirIdx],
        averageSpeed:      Math.round(state.medianSpeed),
        speedRatio:        state.speedRatio,
        sampleCount:       state.totalSamples,
        uniqueContributors: state.uniqueContributors,
        trafficLevel:      state.level.level,
        color:             state.level.color,
        label:             state.level.label,
        confidence:        state.confidence,
      });
    }

    res.setHeader('Cache-Control', 'public, max-age=15');
    res.json({ segments, updatedAt: now });
  } catch (e) {
    console.error('[traffic/route]', e.message);
    res.status(503).json({ error: 'service_unavailable' });
  }
};
