// 網頁推播(Web Push)：不用裝套件，用 Node 內建的 crypto 照標準做
//   - VAPID 金鑰(P-256)：第一次用時產生，存在資料庫(push:vapid)，之後一直用同一把(換了手機的訂閱就失效)
//   - 訂閱：存在 push:subs(有序集合，成員 = 訂閱的 JSON，分數 = 訂閱時間)
//   - 內容加密：RFC 8291(aes128gcm)；身分：RFC 8292(VAPID，JWT ES256)
//   - 推播服務回 404 / 410(訂閱已經不在了)就把那筆訂閱刪掉
// 聯絡資訊(sub)放網站網址，不放 email
const crypto = require('crypto');
const { redisCmd } = require('./redis');

const SUBS_KEY = 'push:subs', VAPID_KEY = 'push:vapid', TEN_YEARS = 10 * 365 * 86400;
const SUBJECT = 'https://liug1217.github.io/Smart-Nav-Map/';

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

let vapid = null;
async function getVapid() {
  if (vapid) return vapid;
  const saved = await redisCmd('GET', VAPID_KEY);
  if (saved) { vapid = JSON.parse(saved); return vapid; }
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  vapid = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
  await redisCmd('SETEX', VAPID_KEY, TEN_YEARS, JSON.stringify(vapid));
  return vapid;
}
// VAPID 私鑰(原始 32 bytes) → Node 的 KeyObject(簽 JWT 用)
function privateKeyObject(v) {
  const pub = unb64u(v.publicKey);
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: v.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
}
function vapidHeader(endpoint, v) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: privateKeyObject(v), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${v.publicKey}`;
}
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// RFC 8291：用訂閱的 p256dh、auth 把內容加密成 aes128gcm 格式
function encrypt(sub, payload) {
  const uaPublic = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(), secret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(auth, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const salt = crypto.randomBytes(16), prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

async function addSubscription(sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return false;
  const clean = JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } });
  await removeSubscription(sub.endpoint);   // 同一個裝置重新訂閱：換成新的
  await redisCmd('ZADD', SUBS_KEY, Date.now(), clean);
  return true;
}
async function listSubscriptions() { return ((await redisCmd('ZRANGEBYSCORE', SUBS_KEY, '-inf', '+inf')) || []).map((s) => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean); }
async function removeSubscription(endpoint) {
  const raw = (await redisCmd('ZRANGEBYSCORE', SUBS_KEY, '-inf', '+inf')) || [];
  for (const s of raw) { try { if (JSON.parse(s).endpoint === endpoint) await redisCmd('ZREM', SUBS_KEY, s); } catch (_) {} }
}

// 推給所有訂閱的人：{ title, body, url }；回傳 { sent, failed, removed }
async function sendAll(message) {
  const v = await getVapid(), subs = await listSubscriptions(), payload = JSON.stringify(message);
  let sent = 0, failed = 0, removed = 0;
  await Promise.all(subs.map(async (sub) => {
    try {
      const r = await fetch(sub.endpoint, { method: 'POST', body: encrypt(sub, payload), headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal', Authorization: vapidHeader(sub.endpoint, v) } });
      if (r.status === 404 || r.status === 410) { await removeSubscription(sub.endpoint); removed++; }
      else if (r.ok) sent++; else failed++;
    } catch (_) { failed++; }
  }));
  return { sent, failed, removed, total: subs.length };
}

module.exports = { getVapid, addSubscription, removeSubscription, listSubscriptions, sendAll };
