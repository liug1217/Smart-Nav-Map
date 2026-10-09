// 地標回報：使用者點地標(廁所、超商、加油站、測速照相…)回報「已經沒了／重複／位置不對／名稱不對」。
//   reports         所有回報(score = 時間)，每筆是 JSON：{ t, sid, layer, name, lat, lng, reason, note }
// 只存匿名編號(sid)跟被回報的地標，不存回報者的位置。
// 看回報：node tools/reports.js

const { redisCmd } = require('./redis');

const REASONS = {
  gone:      '這裡已經沒有了(要刪除)',
  duplicate: '重複了(多一個)',
  position:  '位置不對',
  name:      '名稱不對',
  other:     '其他',
  comment:   '留言或照片不當',
};
const LAYERS = {
  'fm-points': '全家', 'seven-points': '7-ELEVEN', 'okmart-points': 'OK超商', 'hilife-points': '萊爾富',
  'times-points': 'Times 停車場', 'simplemart-points': '美廉社', 'dodohome-points': '嘟嘟房',
  'mcd-points': '麥當勞', 'bafang-points': '八方雲集', 'wanjiafu-points': '萬家福', 'lejiakang-points': '樂家康',
  'showba-points': '小北百貨', 'ntpcpark-points': '新北市公有停車場', 'youbike-points': 'YouBike', 'pxmart-points': '全聯', 'cpc-points': '中油', 'toilet-points': '公共廁所', 'speed-point': '測速照相',
  'cctv-point': '監視器', 'signal-points': '號誌路口', 'place-points': '地點',
};
const KEEP_S = 400 * 24 * 3600;

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
  const now = Date.now();
  await redisCmd('ZADD', 'reports', String(now), JSON.stringify({ t: now, ...r }));
  await redisCmd('EXPIRE', 'reports', String(KEEP_S));
  return null;
}

module.exports = { REASONS, LAYERS, cleanReport, addReport };
