// 即時推送(Server-Sent Events)：GET /api/live 建立一條常駐連線，伺服器有變化就主動通知，
// 不用每 30 秒問一次。
//   counts   在線 / 開車中 / 分享位置的車友 人數有變化時(內容就是最新人數)
//   traffic  有人回報了新車速 → 前端重抓畫面範圍內的路況
//   cars     有車友位置更新或停止分享 → 前端重抓車友位置
// 同類事件在短時間內只送一次(避免一群人同時回報時洗版)。只有 server/server.js 會用到。

const { redisCmd } = require('./redis');
const { getCounts } = require('./presence/presence');

const clients = new Set();
const DEBOUNCE_MS = { presence: 1000, traffic: 2000, cars: 500 };
const RECHECK_MS  = 10 * 1000;   // 有人沒道別就離開(心跳過期)時，靠定時重算人數發現
const PING_MS     = 15 * 1000;   // 保持連線不被中途的代理伺服器切斷

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data) {
  for (const res of clients) { try { send(res, event, data); } catch (_) { clients.delete(res); } }
}

async function currentCounts() {
  const c = await getCounts();
  const sharing = await redisCmd('ZCOUNT', 'cars:active', String(Date.now()), '+inf');
  return { online: c.online, moving: c.moving, trafficSources: c.trafficSources, sharingCars: Number(sharing) || 0 };
}
let lastCountsKey = null;
async function pushCounts() {
  if (!clients.size) return;
  const c = await currentCounts();
  const key = JSON.stringify(c);
  if (key === lastCountsKey) return;   // 沒變就不送
  lastCountsKey = key;
  broadcast('counts', c);
}

const timers = {};
// 其他 API 在資料有變化時呼叫
function notify(type) {
  if (!clients.size || timers[type]) return;
  timers[type] = setTimeout(async () => {
    timers[type] = null;
    try {
      if (type === 'presence' || type === 'cars') await pushCounts();
      if (type === 'traffic') broadcast('traffic', { ts: Date.now() });
      if (type === 'cars')    broadcast('cars',    { ts: Date.now() });
    } catch (e) { console.error('[live]', e.message); }
  }, DEBOUNCE_MS[type] || 1000);
}

// GET /api/live
async function handle(req, res) {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
  });
  res.write('retry: 3000\n\n');           // 斷線 3 秒後自動重連
  clients.add(res);
  req.on('close', () => clients.delete(res));
  try { send(res, 'counts', await currentCounts()); } catch (_) {}
}

let started = false;
function start() {
  if (started) return;
  started = true;
  setInterval(() => { pushCounts().catch(() => {}); }, RECHECK_MS).unref();
  setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch (_) { clients.delete(res); } } }, PING_MS).unref();
  // 國道官方即時路況：塞車狀況一變就通知手機重抓路況
  require('./traffic/freeway').startPolling(() => notify('traffic'));
}

module.exports = { handle, notify, start, clientCount: () => clients.size };
