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

//   stats:first:{sessionId}   這個人第一次使用的日期
//   stats:returning:{日期}     當天的「回訪」使用者：之前某一天就用過、今天又回來的人
const firstKey = id => `stats:first:${id}`;

// 開地圖(心跳)時呼叫
async function markUser(sessionId) {
  const d = twDate();
  let first = await redisCmd('GET', firstKey(sessionId));
  if (!first) {
    first = d;
    await redisCmd('SETEX', firstKey(sessionId), String(KEEP_S), d);
  }
  await Promise.all([
    markSet(`stats:users:${d}`, sessionId, KEEP_S),
    markSet('stats:allusers', sessionId, 0),
    first < d ? markSet(`stats:returning:${d}`, sessionId, KEEP_S) : null,
  ]);
}

// 加上回訪統計之前就用過的人還沒有「第一次使用日期」：從現有的每日名單由舊到新回推一次，
// 不然他們今天再來會被當成新人
async function backfillFirstSeen(lookbackDays = 60) {
  const today = twDate();
  for (let i = lookbackDays; i >= 0; i--) {
    const d = twDate(Date.now() - i * 24 * 3600 * 1000);
    const members = (await redisCmd('ZRANGEBYSCORE', `stats:users:${d}`, '-inf', '+inf')) || [];
    for (const id of members) {
      let first = await redisCmd('GET', firstKey(id));
      if (!first) { first = d; await redisCmd('SETEX', firstKey(id), String(KEEP_S), d); }
      if (first < d) await markSet(`stats:returning:${d}`, id, KEEP_S);
    }
    if (d === today) break;
  }
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
  backfillFirstSeen().catch(e => console.error('[stats] 回推第一次使用日期失敗', e.message));
  sampleOnline().catch(() => {});
  setInterval(() => { sampleOnline().catch(e => console.error('[stats]', e.message)); }, SAMPLE_MS).unref();
}

// 最近幾天的摘要：每天幾人、幾人開車、最多同時幾人在線與時間；另外給每小時平均在線人數
async function summary(days = 14) {
  const out = [];
  const byHour = Array.from({ length: 24 }, () => ({ sum: 0, n: 0 }));
  let peak = null, today = [];
  for (let i = 0; i < days; i++) {
    const d = twDate(Date.now() - i * 24 * 3600 * 1000);
    const [users, drivers, returning, raw] = await Promise.all([
      redisCmd('ZCOUNT', `stats:users:${d}`, '-inf', '+inf'),
      redisCmd('ZCOUNT', `stats:drivers:${d}`, '-inf', '+inf'),
      redisCmd('ZCOUNT', `stats:returning:${d}`, '-inf', '+inf'),
      redisCmd('GET', `stats:online:${d}`),
    ]);
    let series = [];
    try { series = JSON.parse(raw) || []; } catch (_) {}
    if (i === 0) today = series;
    let dayPeak = null;
    for (const [t, online] of series) {
      const h = Number(t.slice(0, 2));
      byHour[h].sum += online; byHour[h].n += 1;
      if (!dayPeak || online > dayPeak.online) dayPeak = { time: t, online };
    }
    if (dayPeak && (!peak || dayPeak.online > peak.online)) peak = { date: d, ...dayPeak };
    if (users || drivers || series.length) {
      out.push({ date: d, users: Number(users) || 0, drivers: Number(drivers) || 0, returning: Number(returning) || 0,
                 peakOnline: dayPeak ? dayPeak.online : 0, peakTime: dayPeak ? dayPeak.time : null });
    }
  }
  return {
    totalUsers: Number(await redisCmd('ZCOUNT', 'stats:allusers', '-inf', '+inf')) || 0,
    peak,
    days: out,
    today,   // 今天每 5 分鐘一筆 [時間, 在線, 開車中]
    avgOnlineByHour: byHour.map((b, h) => ({ hour: h, avg: b.n ? Math.round(b.sum / b.n * 10) / 10 : null })),
  };
}

module.exports = { markUser, markDriver, sampleOnline, startSampling, summary, twDate, backfillFirstSeen };
