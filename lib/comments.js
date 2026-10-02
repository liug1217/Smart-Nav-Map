// 地標留言：星星(1～5，必填) + 文字(選填) + 照片(選填，張數不限、原圖不壓縮)。
//   cm:{地標}          這個地標的留言(score = 時間)，每筆 JSON：{ id, t, sid, nick, avatar, stars, text, photos:[{id, taken}] }
//   photo:{照片編號}    照片是誰傳的、什麼時候傳的、拍攝日期(只有傳照片的人能把它放進自己的留言)
// 照片檔存在 {SNM_DATA_DIR}/photos：{id}.jpg 原圖(只拿掉 GPS 等資料，畫質不動)、{id}_t.jpg 縮圖(列表用)
// 管理：node tools/comments.js(看最新留言、刪掉不當的)
// 地標 = 圖層 + 座標(小數 5 位，約 1 公尺)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redisCmd } = require('./redis');

const KEEP_S = 10 * 365 * 24 * 3600;
const MAX_PHOTO_BYTES = 30 * 1024 * 1024;
const MAX_THUMB_BYTES = 1024 * 1024;

const dataDir = () => process.env.SNM_DATA_DIR || 'C:\\SmartNavData';
const photoDir = () => path.join(dataDir(), 'photos');
const removedFile = () => path.join(dataDir(), 'comments-removed.json');

const poiKey = (layer, lat, lng) => `${layer}:${Number(lat).toFixed(5)}:${Number(lng).toFixed(5)}`;
const validId = id => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id);
const validSid = s => typeof s === 'string' && /^[\w-]{8,64}$/.test(s);
const text = (v, n) => String(v || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);

// ── JPEG：讀拍攝日期、方向，拿掉 GPS/相機等資料(EXIF、XMP…)，只留一個寫著方向的小 EXIF ─────────
// 不重新編碼，畫質完全不變
function readExif(app1) {
  // app1 = APP1 內容(不含標記與長度)，開頭 "Exif\0\0"
  if (app1.length < 14 || app1.toString('latin1', 0, 4) !== 'Exif') return {};
  const t = app1.subarray(6);
  const le = t.toString('latin1', 0, 2) === 'II';
  const u16 = o => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = o => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const out = {};
  const readIfd = (off, depth) => {
    if (depth > 2 || off < 8 || off + 2 > t.length) return;
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > t.length) return;
      const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
      if (tag === 0x0112 && type === 3) out.orientation = u16(e + 8);
      else if ((tag === 0x9003 || (tag === 0x0132 && !out.taken)) && type === 2 && cnt >= 19) {
        const p = u32(e + 8);
        if (p + 19 <= t.length) {
          const s = t.toString('latin1', p, p + 19); // "2026:09:28 14:03:22"
          if (/^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d$/.test(s) && !s.startsWith('0000')) {
            out.taken = s.slice(0, 10).replace(/:/g, '-') + ' ' + s.slice(11, 19); // 到秒
          }
        }
      } else if (tag === 0x8769 && type === 4) readIfd(u32(e + 8), depth + 1); // 拍攝資訊子目錄(拍攝日期在這)
    }
  };
  try { readIfd(u32(4), 0); } catch (_) {}
  return out;
}

function orientationExif(o) {
  // 最小的 EXIF：只有一個 Orientation 欄位(照片才不會轉向)
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1'); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10); tiff.writeUInt16BE(3, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(o, 18);
  tiff.writeUInt32BE(0, 22);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

function cleanJpeg(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const parts = [buf.subarray(0, 2)];
  let info = {}, pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return null;
    const marker = buf[pos + 1];
    if (marker === 0xff) { pos++; continue; } // 填充用的 0xFF
    if (marker === 0xda) { parts.push(buf.subarray(pos)); break; } // 影像資料開始：後面全部照搬
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    const len = buf.readUInt16BE(pos + 2);
    if (len < 2 || pos + 2 + len > buf.length) return null;
    const seg = buf.subarray(pos, pos + 2 + len);
    if (marker === 0xe1) {
      const e = readExif(buf.subarray(pos + 4, pos + 2 + len));
      if (e.taken && !info.taken) info.taken = e.taken;
      if (e.orientation && !info.orientation) info.orientation = e.orientation;
    } else if (marker === 0xe0 || marker === 0xe2 || marker === 0xee || marker === 0xdb || marker === 0xc4 || marker === 0xdd ||
               (marker >= 0xc0 && marker <= 0xcf)) {
      parts.push(seg); // JFIF、色彩描述檔(ICC)、Adobe 色彩轉換、量化表、霍夫曼表、影像大小…：影像本身需要的
    } // 其他 APPn(EXIF/XMP/相機廠商資料)、註解(COM) 全部拿掉
    pos += 2 + len;
  }
  if (info.orientation && info.orientation !== 1) parts.splice(1, 0, orientationExif(info.orientation));
  return { buf: Buffer.concat(parts), taken: info.taken || null };
}

// ── 照片 ────────────────────────────────────────────────────────────────────
async function savePhoto(sid, buf) {
  if (!validSid(sid)) return { error: 'invalid_session' };
  if (!Buffer.isBuffer(buf) || buf.length > MAX_PHOTO_BYTES) return { error: 'too_large' };
  const c = cleanJpeg(buf);
  if (!c) return { error: 'not_jpeg' };
  const id = crypto.randomBytes(12).toString('hex');
  fs.mkdirSync(photoDir(), { recursive: true });
  fs.writeFileSync(path.join(photoDir(), id + '.jpg'), c.buf);
  await redisCmd('SETEX', `photo:${id}`, String(KEEP_S), JSON.stringify({ sid, t: Date.now(), taken: c.taken }));
  return { id, taken: c.taken };
}

async function photoMeta(id) {
  if (!validId(id)) return null;
  try { return JSON.parse(await redisCmd('GET', `photo:${id}`)); } catch (_) { return null; }
}

async function saveThumb(sid, id, buf) {
  const m = await photoMeta(id);
  if (!m || m.sid !== sid) return 'not_owner';
  if (!Buffer.isBuffer(buf) || buf.length > MAX_THUMB_BYTES) return 'too_large';
  const c = cleanJpeg(buf);
  if (!c) return 'not_jpeg';
  fs.writeFileSync(path.join(photoDir(), id + '_t.jpg'), c.buf);
  return null;
}

// ── 留言 ────────────────────────────────────────────────────────────────────
function removedIds() {
  try { return new Set(JSON.parse(fs.readFileSync(removedFile(), 'utf8'))); } catch (_) { return new Set(); }
}

function cleanPoi(b) {
  if (!b || typeof b !== 'object') return 'invalid_body';
  if (typeof b.layer !== 'string' || !/^[a-z]+-points?$/.test(b.layer)) return 'invalid_layer';
  const lat = Number(b.lat), lng = Number(b.lng);
  if (!(lat > 20 && lat < 27 && lng > 118 && lng < 123)) return 'invalid_coords';
  return { layer: b.layer, lat, lng, key: poiKey(b.layer, lat, lng) };
}

async function addComment(b) {
  if (!validSid(b && b.sessionId)) return { error: 'invalid_session' };
  const poi = cleanPoi(b);
  if (typeof poi === 'string') return { error: poi };
  const stars = Number(b.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return { error: 'stars_required' };
  const photos = [];
  for (const id of Array.isArray(b.photos) ? b.photos : []) {
    const m = await photoMeta(id);
    if (!m || m.sid !== b.sessionId) return { error: 'invalid_photo' };
    photos.push({ id, taken: m.taken || null, up: m.t });
  }
  const avatar = typeof b.avatar === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(b.avatar) && b.avatar.length < 40000
    ? b.avatar : '';
  const c = {
    id: crypto.randomBytes(12).toString('hex'), t: Date.now(), sid: b.sessionId,
    nick: text(b.nick, 12), avatar, stars, text: text(b.text, 1000), photos,
    place: text(b.name, 80),
  };
  await redisCmd('ZADD', `cm:${poi.key}`, String(c.t), JSON.stringify(c));
  await redisCmd('EXPIRE', `cm:${poi.key}`, String(KEEP_S));
  return { id: c.id };
}

async function rawComments(key) {
  const rows = (await redisCmd('ZRANGEBYSCORE', `cm:${key}`, '-inf', '+inf')) || [];
  return rows.map(s => { try { return { raw: s, c: JSON.parse(s) }; } catch (_) { return null; } }).filter(Boolean);
}

async function listComments(q) {
  const poi = cleanPoi(q);
  if (typeof poi === 'string') return { error: poi };
  const gone = removedIds();
  const items = (await rawComments(poi.key))
    .map(x => x.c)
    .filter(c => !gone.has(c.id))
    .map(c => ({
      ...c,
      photos: c.photos.filter(p => !gone.has(p.id)),
      mine: !!q.sid && c.sid === q.sid,
      sid: undefined, // 不把別人的匿名編號送出去
    }))
    .sort((a, b) => b.t - a.t);
  const avg = items.length ? Math.round(items.reduce((s, c) => s + c.stars, 0) / items.length * 10) / 10 : null;
  return { count: items.length, avg, items };
}

async function deleteComment(b) {
  if (!validSid(b && b.sessionId)) return 'invalid_session';
  const poi = cleanPoi(b);
  if (typeof poi === 'string') return poi;
  const hit = (await rawComments(poi.key)).find(x => x.c.id === b.id);
  if (!hit) return 'not_found';
  if (hit.c.sid !== b.sessionId) return 'not_owner';
  await redisCmd('ZREM', `cm:${poi.key}`, hit.raw);
  for (const p of hit.c.photos) {
    for (const f of [p.id + '.jpg', p.id + '_t.jpg']) { try { fs.unlinkSync(path.join(photoDir(), f)); } catch (_) {} }
  }
  return null;
}

// 照片檔路徑(只接受合法檔名，不會讀到別的檔案)；被管理員刪掉的回傳 null
function photoPath(file) {
  const m = /^([a-f0-9]{24})(_t)?\.jpg$/.exec(file || '');
  if (!m || removedIds().has(m[1])) return null;
  return path.join(photoDir(), file);
}

module.exports = { cleanJpeg, readExif, savePhoto, saveThumb, addComment, listComments, deleteComment, photoPath, poiKey, removedFile, photoDir };
