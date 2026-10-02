// 地標回報：使用者點地標(廁所、超商、加油站、測速照相…)回報「已經沒了／重複／位置不對／名稱不對」。
//   reports         所有回報(score = 時間)，每筆是 JSON：{ t, sid, layer, name, lat, lng, reason, note }
//   reports:day:{sid}:{日期}  這個人今天回報幾次(防灌爆)
// 只存匿名編號(sid)跟被回報的地標，不存回報者的位置。
// 看回報：node tools/reports.js

const { redisCmd } = require('./redis');

const REASONS = {
  gone:      '這裡已經沒有了(要刪除)',
  duplicate: '重複了(多一個)',
  position:  '位置不對',
  name:      '名稱不對',
  other:     '其他',
};
const LAYERS = {
  'fm-points': '全家', 'seven-points': '7-ELEVEN', 'okmart-points': 'OK超商', 'hilife-points': '萊爾富',
  'pxmart-points': '全聯', 'cpc-points': '中油', 'toilet-points': '公共廁所', 'speed-point': '測速照相',
};
const KEEP_S = 400 * 24 * 3600;
const PER_DAY = 30;

const twDate = (t = Date.now()) => new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);

// 檢查並整理一筆回報；不合格回傳錯誤代碼字串
function cleanReport(b) {
  if (!b || typeof b !== 'object') return 'invalid_body';
  if (typeof b.sessionId !== 'string' || !/^[\w-]{8,64}$/.test(b.sessionId)) return 'invalid_session';
  if (!LAYERS[b.layer]) return 'invalid_layer';
  if (!REASONS[b.reason]) return 'invalid_reason';
  const lat = Number(b.lat), lng = Number(b.lng);
  if (!(lat > 20 && lat < 27 && lng > 118 && lng < 123)) return 'invalid_coords';
  const text = (v, n) => String(v || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
  return {
    sid: b.sessionId, layer: b.layer, name: text(b.name, 80),
    lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6,
    reason: b.reason, note: text(b.note, 200),
  };
}

async function addReport(r) {
  const dayKey = `reports:day:${r.sid}:${twDate()}`;
  const n = Number(await redisCmd('GET', dayKey)) || 0;
  if (n >= PER_DAY) return 'too_many';
  await redisCmd('SETEX', dayKey, String(26 * 3600), String(n + 1));
  const now = Date.now();
  await redisCmd('ZADD', 'reports', String(now), JSON.stringify({ t: now, ...r }));
  await redisCmd('EXPIRE', 'reports', String(KEEP_S));
  return null;
}

module.exports = { REASONS, LAYERS, cleanReport, addReport, PER_DAY };
