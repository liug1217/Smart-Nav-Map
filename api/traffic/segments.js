// GET /api/traffic/segments?n=&s=&e=&w=
// 回傳指定 bbox 內的即時道路路況（GeoJSON FeatureCollection）。
// 只包含在過去 10 分鐘內有真實使用者 GPS 資料的 segment。
// 「沒有資料」≠「順暢」，資料不足時不顯示顏色。

const CFG = {
  ROLLING_WINDOW_MS:     10 * 60 * 1000,  // 樣本有效期 10 分鐘
  SEG_ACTIVE_WINDOW_MS:  30 * 60 * 1000,  // segment 活躍期 30 分鐘
  MIN_SAMPLES:           2,               // 顯示路況所需最少樣本數
  MIN_CONTRIBUTORS:      1,               // 顯示路況所需最少貢獻者數
  // speedRatio = currentSpeed / baselineSpeed
  LEVELS: [
    { minRatio: 0.75, level: 'free',      color: '#00C853', label: '順暢' },
    { minRatio: 0.55, level: 'moderate',  color: '#FFD600', label: '車多' },
    { minRatio: 0.40, level: 'slow',      color: '#FF6D00', label: '緩慢' },
    { minRatio: 0.25, level: 'congested', color: '#D32F2F', label: '壅塞' },
    { minRatio: 0,   level: 'severe',    color: '#7B0000', label: '嚴重壅塞' },
  ],
  // 第一版 baseline = 固定值；未來替換為歷史平均速度
  BASELINE_KMH: 50,
  // Confidence 門檻
  HIGH_CONF_CONTRIBUTORS:   8,
  MEDIUM_CONF_CONTRIBUTORS: 3,
  // Hysteresis：避免路況顏色頻繁跳動（未來在前端/後端狀態機實作）
  // 目前版本每次重新計算，不維護前一狀態
};

// ── Geohash decode ────────────────────────────────────────────────────────────
const GH32 = '0123456789bcdefghjkmnpqrstuvwxyz';
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

// ── Redis ─────────────────────────────────────────────────────────────────────
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

async function redisPipeline(commands) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis 未設定');
  const r = await fetch(`${url}/pipeline`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(commands),
  });
  return r.json(); // [{ result }, { result }, ...]
}

// ── 計算路況 ──────────────────────────────────────────────────────────────────
function computeState(samples) {
  if (!samples || samples.length < CFG.MIN_SAMPLES) return null;

  // 解析 sample member：{sessionId}:{timestamp}:{speedKmh}
  // sessionId 不含冒號（UUID 格式），所以倒數兩個 : 分隔 ts 和 speed
  const speedBySession = {};
  for (const m of samples) {
    const last = m.lastIndexOf(':');
    const prev = m.lastIndexOf(':', last - 1);
    if (prev < 0) continue;
    const sId = m.slice(0, prev);
    const spd = parseInt(m.slice(last + 1), 10);
    if (isNaN(spd) || spd < 0 || spd > 200) continue;
    (speedBySession[sId] = speedBySession[sId] || []).push(spd);
  }

  const contributors = Object.keys(speedBySession);
  if (contributors.length < CFG.MIN_CONTRIBUTORS) return null;

  // 每個 contributor 先取中位數，再取所有 contributor 的中位數
  // → 防止單一使用者大量 sample 主導結果
  const perContrib = contributors
    .map(id => {
      const s = [...speedBySession[id]].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    })
    .sort((a, b) => a - b);

  const medianSpeed = perContrib[Math.floor(perContrib.length / 2)];
  const totalSamples = contributors.reduce((s, id) => s + speedBySession[id].length, 0);
  const speedRatio = medianSpeed / CFG.BASELINE_KMH;

  // 交通等級
  let lvl = CFG.LEVELS[CFG.LEVELS.length - 1];
  for (const l of CFG.LEVELS) {
    if (speedRatio >= l.minRatio) { lvl = l; break; }
  }

  // Confidence
  let confidence;
  if (contributors.length >= CFG.HIGH_CONF_CONTRIBUTORS)   confidence = 'high';
  else if (contributors.length >= CFG.MEDIUM_CONF_CONTRIBUTORS) confidence = 'medium';
  else confidence = 'low';

  return {
    medianSpeed,
    speedRatio:  Math.round(speedRatio * 100) / 100,
    totalSamples,
    uniqueContributors: contributors.length,
    level: lvl,
    confidence,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') { res.status(405).end(); return; }

  const { n, s, e, w } = req.query;
  const north = parseFloat(n), south = parseFloat(s),
        east  = parseFloat(e), west  = parseFloat(w);
  if ([north, south, east, west].some(isNaN)) {
    res.status(400).json({ error: 'bbox_required: n, s, e, w' }); return;
  }

  const now         = Date.now();
  const windowStart = now - CFG.ROLLING_WINDOW_MS;
  const activeFrom  = now - CFG.SEG_ACTIVE_WINDOW_MS;

  try {
    // 取得最近 30 分鐘活躍的 segment 清單
    // traffic:segs：sorted set，member = `{gh}|{dir}`，score = 最後活躍時間戳
    const members = await redisCmd(
      'ZRANGEBYSCORE', 'traffic:segs', String(activeFrom), '+inf'
    );

    if (!members || members.length === 0) {
      res.setHeader('Cache-Control', 'public, max-age=15');
      res.json({ type: 'FeatureCollection', features: [], updatedAt: now });
      return;
    }

    // 解析並篩選出 bbox 範圍內的 segment
    const inBbox = [];
    const seen = new Set();
    for (const m of members) {
      const [gh, dir] = m.split('|');
      if (!gh || !dir) continue;
      const key = `${gh}|${dir}`;
      if (seen.has(key)) continue;  // 去重（同一 gh|dir 可能有多筆）
      seen.add(key);
      const { lat, lng } = ghDecode(gh);
      if (lat < south || lat > north || lng < west || lng > east) continue;
      inBbox.push({ gh, dir, lat, lng, segKey: `ts:${gh}:${dir}` });
    }

    if (inBbox.length === 0) {
      res.setHeader('Cache-Control', 'public, max-age=15');
      res.json({ type: 'FeatureCollection', features: [], updatedAt: now });
      return;
    }

    // 批次查詢所有 segment 的 rolling window 樣本（pipeline）
    const cmds = inBbox.map(seg => [
      'ZRANGEBYSCORE', seg.segKey, String(windowStart), '+inf'
    ]);
    const results = await redisPipeline(cmds);

    const features = [];
    for (let i = 0; i < inBbox.length; i++) {
      const seg     = inBbox[i];
      const samples = results[i] && results[i].result;
      const state   = computeState(samples);
      if (!state) continue;

      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [seg.lng, seg.lat] },
        properties: {
          segmentId:         `${seg.gh}:${seg.dir}`,
          direction:         seg.dir,
          averageSpeed:      Math.round(state.medianSpeed),
          baselineSpeed:     CFG.BASELINE_KMH,
          speedRatio:        state.speedRatio,
          sampleCount:       state.totalSamples,
          uniqueContributors: state.uniqueContributors,
          trafficLevel:      state.level.level,
          color:             state.level.color,
          label:             state.level.label,
          confidence:        state.confidence,
        }
      });
    }

    res.setHeader('Cache-Control', 'public, max-age=15');
    res.json({ type: 'FeatureCollection', features, updatedAt: now });
  } catch (e) {
    console.error('[traffic/segments]', e.message);
    res.status(503).json({ error: 'service_unavailable' });
  }
};
