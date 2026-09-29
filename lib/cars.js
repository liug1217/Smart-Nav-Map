// 車友位置分享：使用者在 App 裡「同意分享」後才會上傳，其他使用者的地圖上會看到他的車。
// 只保留最近 30 秒的位置，不存任何歷史軌跡；id 是每次開 App 隨機產生的匿名編號，不是使用者身分。

const { redisCmd, redisPipeline } = require('./redis');

const CAR_TTL_S  = 30;
const ACTIVE_KEY = 'cars:active';          // sorted set：分數 = 位置到期時間
const carKey     = id => `car:${id}`;
const PUB_ID_RE  = /^[a-zA-Z0-9_-]{8,64}$/;
const MAX_RESULTS = 200;

function validPubId(id) { return typeof id === 'string' && PUB_ID_RE.test(id); }

async function upsertCar(id, pos) {
  const now = Date.now();
  await Promise.all([
    redisCmd('SETEX', carKey(id), String(CAR_TTL_S), JSON.stringify(pos)),
    redisCmd('ZADD', ACTIVE_KEY, String(now + CAR_TTL_S * 1000), id),
  ]);
}

// 關閉分享：立刻從別人的地圖上消失
async function removeCar(id) {
  await Promise.all([
    redisCmd('ZREM', ACTIVE_KEY, id),
    redisCmd('SETEX', carKey(id), '1', 'null'),
  ]);
}

async function carsInBbox({ north, south, east, west }, excludeId) {
  const now = Date.now();
  await redisCmd('ZREMRANGEBYSCORE', ACTIVE_KEY, '-inf', String(now));
  const ids = ((await redisCmd('ZRANGEBYSCORE', ACTIVE_KEY, String(now), '+inf')) || [])
    .filter(id => id !== excludeId);
  if (!ids.length) return [];
  const results = await redisPipeline(ids.map(id => ['GET', carKey(id)]));
  const cars = [];
  for (let i = 0; i < ids.length && cars.length < MAX_RESULTS; i++) {
    let p = null;
    try { p = JSON.parse(results[i] && results[i].result); } catch (_) {}
    if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
    if (p.lat < south || p.lat > north || p.lng < west || p.lng > east) continue;
    cars.push({ id: ids[i], lat: p.lat, lng: p.lng, heading: p.heading, speed: p.speed, ageS: Math.round((now - p.ts) / 1000) });
  }
  return cars;
}

module.exports = { validPubId, upsertCar, removeCar, carsInBbox, CAR_TTL_S };
