// 每段道路(geohash 格 + 方向)自己學習「順暢時的車速」，用來判斷現在塞不塞。
// 國道順暢時約 100、市區小路約 30，不能全台共用一個固定值。
//
// 做法：長期累積在這段路上開過的車速分布(每 5 km/h 一格的直方圖)，
// 取第 85 百分位當作順暢車速(交通工程常用的自由車流速度估法，排除少數飆車的人)。

const BUCKET_KMH        = 5;
const MIN_LEARN_SAMPLES = 30;              // 樣本太少時不判定，改用絕對速度門檻
const DECAY_AT          = 2000;            // 樣本數到這個量就全部減半，讓舊資料慢慢淡出(道路速限、施工會變)
const LEARN_TTL_S       = 30 * 24 * 3600;  // 30 天沒人開過就忘掉
const PERCENTILE        = 0.85;
const MIN_FREEFLOW_KMH  = 20;

const ffKey = (gh, dir) => `ff:${gh}:${dir}`;

function parse(json) {
  try { const h = JSON.parse(json); if (h && typeof h.n === 'number' && h.b) return h; } catch (_) {}
  return { n: 0, b: {} };
}

// 把一筆車速加進直方圖，回傳新的 JSON 字串
function addSpeed(json, speedKmh) {
  const h = parse(json);
  const k = String(Math.floor(speedKmh / BUCKET_KMH));
  h.b[k] = (h.b[k] || 0) + 1;
  h.n += 1;
  if (h.n >= DECAY_AT) {
    let n = 0;
    for (const key of Object.keys(h.b)) {
      h.b[key] = Math.floor(h.b[key] / 2);
      if (!h.b[key]) delete h.b[key]; else n += h.b[key];
    }
    h.n = n;
  }
  return JSON.stringify(h);
}

// 學到的順暢車速(km/h)；樣本不夠時回傳 null
function freeFlowSpeed(json) {
  if (!json) return null;
  const h = parse(json);
  if (h.n < MIN_LEARN_SAMPLES) return null;
  const target = h.n * PERCENTILE;
  let acc = 0;
  for (const k of Object.keys(h.b).map(Number).sort((a, b) => a - b)) {
    acc += h.b[k];
    if (acc >= target) return Math.max(MIN_FREEFLOW_KMH, (k + 0.5) * BUCKET_KMH);
  }
  return null;
}

// ── 還沒學到實際車速時：用速限或道路等級推估「順暢車速」(道路等級取自 OpenStreetMap 的 highway 分類) ──
const rcKey = (gh, dir) => `rc:${gh}:${dir}`;
const ROAD_INFO_TTL_S = 30 * 24 * 3600;

// 各等級道路順暢時大約的車速(km/h)，大致等於台灣該類道路的速限
const CLASS_FREEFLOW_KMH = {
  motorway: 100,  // 國道
  trunk:    80,   // 快速道路 / 省道快速公路
  primary:  60,   // 主要道路
  secondary: 50,
  tertiary: 50,
  minor:    40,   // 一般小路
  service:  30,   // 巷弄、服務道路
};
const RAMP_FREEFLOW_KMH = 50;   // 交流道匝道
// 速限要落在這個等級合理的範圍內才採用(避免拿到旁邊另一條路的測速照相速限)
const CLASS_LIMIT_RANGE = {
  motorway: [80, 120], trunk: [50, 110], primary: [30, 80], secondary: [30, 70],
  tertiary: [30, 70], minor: [20, 60], service: [10, 50],
};

function validRoadClass(c) { return Object.prototype.hasOwnProperty.call(CLASS_FREEFLOW_KMH, c); }

// 上傳時帶來的道路資訊 → 要存的 JSON；不合理的資料回傳 null(不存)
function encodeRoadInfo(roadClass, ramp, speedLimit) {
  if (!validRoadClass(roadClass)) return null;
  const lim = Number(speedLimit);
  const [lo, hi] = CLASS_LIMIT_RANGE[roadClass];
  return JSON.stringify({
    c: roadClass,
    r: ramp ? 1 : 0,
    l: (Number.isFinite(lim) && lim >= lo && lim <= hi) ? Math.round(lim) : null,
  });
}

/**
 * 決定這段路的「順暢車速」：學到的實際車速 > 速限 > 道路等級推估 > 不知道(null)
 * @returns {{ kmh: number|null, source: 'learned'|'limit'|'class'|'none' }}
 */
function resolveBaseline(ffJson, rcJson) {
  const learned = freeFlowSpeed(ffJson);
  if (learned) return { kmh: learned, source: 'learned' };
  let info = null;
  try { info = rcJson ? JSON.parse(rcJson) : null; } catch (_) {}
  if (info && validRoadClass(info.c)) {
    if (info.l) return { kmh: info.l, source: 'limit' };
    return { kmh: info.r ? RAMP_FREEFLOW_KMH : CLASS_FREEFLOW_KMH[info.c], source: 'class' };
  }
  return { kmh: null, source: 'none' };
}

module.exports = {
  ffKey, addSpeed, freeFlowSpeed, LEARN_TTL_S, MIN_LEARN_SAMPLES,
  rcKey, ROAD_INFO_TTL_S, CLASS_FREEFLOW_KMH, encodeRoadInfo, resolveBaseline,
};
