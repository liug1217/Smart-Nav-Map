// 使用統計：只記人數與匿名編號(每台裝置隨機產生的 sessionId)，不記任何位置。
//   stats:users:{日期}    當天開過地圖的不同使用者
//   stats:drivers:{日期}  當天有開車(回報過路況)的不同使用者
//   stats:allusers        累計所有用過的不同使用者
//   stats:online:{日期}   每 5 分鐘一筆 [時間, 在線人數, 開車中人數]，用來找最多人用的時段
// 日期與時間都用台灣時間。

const { redisCmd } = require('./redis');
const { getCounts } = require('./presence/presence');

const TW_OFFSET_MS = 8 * 3600 * 1000;
const KEEP_S       = 400 * 24 * 3600;       // 保留約一年
const SAMPLE_MS    = 5 * 60 * 1000;

const twDate = (t = Date.now()) => new Date(t + TW_OFFSET_MS).toISOString().slice(0, 10);
const twTime = (t = Date.now()) => new Date(t + TW_OFFSET_MS).toISOString().slice(11, 16);

async function markSet(key, id, keepS) {
  const now = String(Date.now());
  await redisCmd('ZADD', key, now, id);
  if (keepS) await redisCmd('EXPIRE', key, String(keepS));
}

// 開地圖(心跳)時呼叫
async function markUser(sessionId) {
  const d = twDate();
  await Promise.all([
    markSet(`stats:users:${d}`, sessionId, KEEP_S),
    markSet('stats:allusers', sessionId, 0),
  ]);
}

// 有開車、回報路況時呼叫
async function markDriver(sessionId) {
  await markSet(`stats:drivers:${twDate()}`, sessionId, KEEP_S);
}

// 每 5 分鐘記一次在線人數
async function sampleOnline() {
  const c = await getCounts();
  const now = Date.now();
  const key = `stats:online:${twDate(now)}`;
  let series = [];
  try { series = JSON.parse(await redisCmd('GET', key)) || []; } catch (_) {}
  series.push([twTime(now), c.online, c.moving]);
  await redisCmd('SETEX', key, String(KEEP_S), JSON.stringify(series));
  return c;
}

function startSampling() {
  sampleOnline().catch(() => {});
  setInterval(() => { sampleOnline().catch(e => console.error('[stats]', e.message)); }, SAMPLE_MS).unref();
}

// 最近幾天的摘要：每天幾人、幾人開車、最多同時幾人在線與時間；另外給每小時平均在線人數
async function summary(days = 14) {
  const out = [];
  const byHour = Array.from({ length: 24 }, () => ({ sum: 0, n: 0 }));
  let peak = null;
  for (let i = 0; i < days; i++) {
    const d = twDate(Date.now() - i * 24 * 3600 * 1000);
    const [users, drivers, raw] = await Promise.all([
      redisCmd('ZCOUNT', `stats:users:${d}`, '-inf', '+inf'),
      redisCmd('ZCOUNT', `stats:drivers:${d}`, '-inf', '+inf'),
      redisCmd('GET', `stats:online:${d}`),
    ]);
    let series = [];
    try { series = JSON.parse(raw) || []; } catch (_) {}
    let dayPeak = null;
    for (const [t, online] of series) {
      const h = Number(t.slice(0, 2));
      byHour[h].sum += online; byHour[h].n += 1;
      if (!dayPeak || online > dayPeak.online) dayPeak = { time: t, online };
    }
    if (dayPeak && (!peak || dayPeak.online > peak.online)) peak = { date: d, ...dayPeak };
    if (users || drivers || series.length) {
      out.push({ date: d, users: Number(users) || 0, drivers: Number(drivers) || 0,
                 peakOnline: dayPeak ? dayPeak.online : 0, peakTime: dayPeak ? dayPeak.time : null });
    }
  }
  return {
    totalUsers: Number(await redisCmd('ZCOUNT', 'stats:allusers', '-inf', '+inf')) || 0,
    peak,
    days: out,
    avgOnlineByHour: byHour.map((b, h) => ({ hour: h, avg: b.n ? Math.round(b.sum / b.n * 10) / 10 : null })),
  };
}

module.exports = { markUser, markDriver, sampleOnline, startSampling, summary, twDate };
