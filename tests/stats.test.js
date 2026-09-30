const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 用本機儲存跑，資料放暫存資料夾
process.env.SNM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'snm-stats-test-'));
const { markUser, markDriver, sampleOnline, summary } = require('../lib/stats');
const { refreshPresence } = require('../lib/presence/presence');

test('counts distinct users and drivers per day, and finds the busiest time', async () => {
  for (const id of ['devA1234567', 'devB1234567', 'devA1234567']) await markUser(id);
  await markDriver('devB1234567');
  await markDriver('devB1234567');

  await sampleOnline();                                   // 0 人在線
  await refreshPresence('devA1234567', true, false);
  await refreshPresence('devB1234567', false, false);
  await sampleOnline();                                   // 2 人在線、1 人開車

  const s = await summary(1);
  assert.equal(s.totalUsers, 2);
  assert.equal(s.days.length, 1);
  assert.equal(s.days[0].users, 2);
  assert.equal(s.days[0].drivers, 1);
  assert.equal(s.days[0].peakOnline, 2);
  assert.equal(s.peak.online, 2);
  assert.match(s.peak.time, /^\d\d:\d\d$/);
});

test('returning users: someone seen on an earlier day counts as 回訪 today; a brand-new user does not', async () => {
  const { redisCmd } = require('../lib/redis');
  const { backfillFirstSeen, twDate } = require('../lib/stats');
  const yesterday = twDate(Date.now() - 24 * 3600 * 1000), today = twDate();
  // 昨天就用過的人(加上回訪統計之前的舊資料，只有每日名單)
  await redisCmd('ZADD', `stats:users:${yesterday}`, String(Date.now() - 86400000), 'oldUser0001');
  await backfillFirstSeen(3);
  await markUser('oldUser0001');   // 今天又回來
  await markUser('newUser0001');   // 今天第一次來
  await markUser('newUser0001');   // 同一天再來一次，還是新人
  const s = await summary(2);
  const t = s.days.find(d => d.date === today);
  assert.equal(t.returning, 1);
  assert.equal(await redisCmd('GET', 'stats:first:oldUser0001'), yesterday);
  assert.equal(await redisCmd('GET', 'stats:first:newUser0001'), today);
});
