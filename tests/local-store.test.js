const assert = require('node:assert/strict');
const test = require('node:test');
const store = require('../lib/local-store');

test('expired short-lived keys are swept from memory even if nobody reads them again', async () => {
  // 模擬很多使用者留下的限速紀錄(1 秒到期)，加上一筆要長期保留的資料
  for (let i = 0; i < 500; i++) store.exec(['SETEX', 'rl:pos:user' + i, '1', String(Date.now())]);
  store.exec(['SETEX', 'ff:keep:N', '3600', '{"n":1,"b":{"10":1}}']);
  assert.equal(store._keys.size, 501);

  await new Promise(r => setTimeout(r, 1100));
  assert.equal(store.sweepExpired(), 500);
  assert.equal(store._keys.size, 1);
  assert.equal(store.exec(['GET', 'ff:keep:N']), '{"n":1,"b":{"10":1}}');
});
