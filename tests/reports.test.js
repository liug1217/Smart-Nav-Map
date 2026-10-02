const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.SNM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'snm-reports-test-'));
const { cleanReport, addReport, PER_DAY } = require('../lib/reports');
const { redisCmd } = require('../lib/redis');

const good = { sessionId: 'devA1234567', layer: 'toilet-points', name: '碧潭公廁', lat: 24.96, lng: 121.53, reason: 'gone', note: '拆掉了' };

test('accepts a valid report and strips control characters / overlong text', () => {
  const r = cleanReport({ ...good, note: 'a\u0000b' + 'x'.repeat(500) });
  assert.equal(r.layer, 'toilet-points');
  assert.equal(r.note.length, 200);
  assert.ok(!r.note.includes('\u0000'));
});

test('rejects unknown layers, reasons, bad coordinates and bad session ids', () => {
  assert.equal(cleanReport({ ...good, layer: 'x' }), 'invalid_layer');
  assert.equal(cleanReport({ ...good, reason: 'x' }), 'invalid_reason');
  assert.equal(cleanReport({ ...good, lat: 0 }), 'invalid_coords');
  assert.equal(cleanReport({ ...good, sessionId: 'a b' }), 'invalid_session');
});

test('stores reports and caps each person per day', async () => {
  const r = cleanReport(good);
  for (let i = 0; i < PER_DAY; i++) assert.equal(await addReport(r), null);
  assert.equal(await addReport(r), 'too_many');
  const rows = await redisCmd('ZRANGEBYSCORE', 'reports', '-inf', '+inf');
  assert.equal(rows.length >= 1, true);
  assert.equal(JSON.parse(rows[0]).reason, 'gone');
});
