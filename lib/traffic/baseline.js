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

module.exports = { ffKey, addSpeed, freeFlowSpeed, LEARN_TTL_S, MIN_LEARN_SAMPLES };
