const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.SNM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'snm-comments-test-'));
const cm = require('../lib/comments');

// 1x1 的小 JPEG(沒有 EXIF)
const TINY = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

// 做一段手機照片會有的 EXIF：方向 6(直拍)、拍攝日期、GPS 位置
function exifApp1() {
  const e = [];
  const tiff = Buffer.alloc(200);
  tiff.write('MM', 0, 'latin1'); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4);
  // IFD0：3 個欄位
  let o = 8; tiff.writeUInt16BE(3, o); o += 2;
  const ent = (tag, type, cnt, val) => { tiff.writeUInt16BE(tag, o); tiff.writeUInt16BE(type, o + 2); tiff.writeUInt32BE(cnt, o + 4); tiff.writeUInt32BE(val, o + 8); o += 12; };
  ent(0x0112, 3, 1, 6 << 16);     // Orientation = 6
  ent(0x8769, 4, 1, 60);          // Exif 子目錄在 60
  ent(0x8825, 4, 1, 100);         // GPS 子目錄在 100
  tiff.writeUInt32BE(0, o);
  // Exif 子目錄：DateTimeOriginal
  tiff.writeUInt16BE(1, 60);
  tiff.writeUInt16BE(0x9003, 62); tiff.writeUInt16BE(2, 64); tiff.writeUInt32BE(20, 66); tiff.writeUInt32BE(140, 70);
  tiff.writeUInt32BE(0, 74);
  tiff.write('2026:09:28 14:03:22\0', 140, 'latin1');
  // GPS 子目錄：緯度 N(內容不重要，重點是要被拿掉)
  tiff.writeUInt16BE(1, 100);
  tiff.writeUInt16BE(0x0001, 102); tiff.writeUInt16BE(2, 104); tiff.writeUInt32BE(2, 106); tiff.write('N\0', 110, 'latin1');
  tiff.write('GPSSECRET', 170, 'latin1');
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]); head.writeUInt16BE(body.length + 2, 2);
  e.push(head, body);
  return Buffer.concat(e);
}
const PHONE = Buffer.concat([TINY.subarray(0, 2), exifApp1(), TINY.subarray(2)]);

test('cleanJpeg keeps the taken date and orientation, drops GPS, leaves image data untouched', () => {
  const c = cm.cleanJpeg(PHONE);
  assert.equal(c.taken, '2026-09-28 14:03:22');
  assert.ok(!c.buf.includes(Buffer.from('GPSSECRET')));
  assert.equal(cm.readExif(c.buf.subarray(6, 6 + c.buf.readUInt16BE(4) - 2)).orientation, 6);
  // 影像資料(從 SOS 開始)完全一樣
  const sos = b => b.subarray(b.indexOf(Buffer.from([0xff, 0xda])));
  assert.deepEqual(sos(c.buf), sos(TINY));
  assert.equal(cm.cleanJpeg(Buffer.from('not a jpeg')), null);
});

test('comments: stars required, photos must be your own, list hides sid, delete only your own', async () => {
  const A = 'devA1234567', B = 'devB1234567';
  const place = { layer: 'toilet-points', lat: 24.96, lng: 121.53, name: '碧潭公廁' };
  const ph = await cm.savePhoto(A, PHONE);
  assert.equal(ph.taken, '2026-09-28 14:03:22');
  assert.equal(await cm.saveThumb(B, ph.id, TINY), 'not_owner');
  assert.equal(await cm.saveThumb(A, ph.id, TINY), null);

  assert.equal((await cm.addComment({ sessionId: A, ...place, text: 'hi' })).error, 'stars_required');
  assert.equal((await cm.addComment({ sessionId: B, ...place, stars: 3, photos: [ph.id] })).error, 'invalid_photo');
  const ok = await cm.addComment({ sessionId: A, nick: '小明', ...place, stars: 4, text: '很乾淨', photos: [ph.id] });
  assert.ok(ok.id);
  await cm.addComment({ sessionId: B, ...place, stars: 2 });

  const l = await cm.listComments({ ...place, sid: A });
  assert.equal(l.count, 2);
  assert.equal(l.avg, 3);
  const mine = l.items.find(c => c.mine);
  assert.equal(mine.text, '很乾淨');
  assert.equal(mine.photos[0].taken, '2026-09-28 14:03:22');
  assert.ok(l.items.every(c => c.sid === undefined));

  assert.equal(await cm.deleteComment({ sessionId: B, ...place, id: ok.id }), 'not_owner');
  assert.equal(await cm.deleteComment({ sessionId: A, ...place, id: ok.id }), null);
  assert.equal((await cm.listComments(place)).count, 1);
  assert.ok(!fs.existsSync(path.join(cm.photoDir(), ph.id + '.jpg')));
});

test('photoPath only allows photo file names and hides removed ones', () => {
  assert.equal(cm.photoPath('../store.json'), null);
  assert.equal(cm.photoPath('abc.jpg'), null);
  const id = 'a'.repeat(24);
  assert.ok(cm.photoPath(id + '_t.jpg'));
  fs.writeFileSync(cm.removedFile(), JSON.stringify([id]));
  assert.equal(cm.photoPath(id + '.jpg'), null);
});
