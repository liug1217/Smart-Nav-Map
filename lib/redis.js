// Upstash Redis REST helper — shared across all API routes.
// Uses HTTP fetch (no persistent socket), safe for Vercel serverless.

// 支援 Vercel KV（KV_REST_API_*）和 Upstash 直連（UPSTASH_REDIS_REST_*）兩種設定方式
const BASE_URL   = () => process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const AUTH_TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// 用自己的電腦當伺服器(server/server.js)時設定 SNM_DATA_DIR：資料改存在本機資料夾，不連雲端 Redis
const LOCAL_DIR = () => process.env.SNM_DATA_DIR;
function localStore() {
  const s = require('./local-store');
  s.init(LOCAL_DIR());
  return s;
}

function assertEnv() {
  if (!BASE_URL() || !AUTH_TOKEN()) throw new Error('Redis 未設定（KV_REST_API_URL 或 UPSTASH_REDIS_REST_URL）');
}

async function redisCmd(...args) {
  if (LOCAL_DIR()) return localStore().exec(args);
  assertEnv();
  const r = await fetch(BASE_URL(), {
    method:  'POST',
    headers: { Authorization: `Bearer ${AUTH_TOKEN()}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(args),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

// Sends multiple commands in a single HTTP round-trip.
// Returns an array: [{ result }, { result }, ...]
async function redisPipeline(commands) {
  if (LOCAL_DIR()) {
    const s = localStore();
    return commands.map(c => { try { return { result: s.exec(c) }; } catch (e) { return { error: e.message }; } });
  }
  assertEnv();
  const r = await fetch(`${BASE_URL()}/pipeline`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${AUTH_TOKEN()}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(commands),
  });
  return r.json();
}

// Ping/connectivity check — used by /api/health.
async function redisPing() {
  try {
    if (LOCAL_DIR()) return localStore().exec(['PING']) === 'PONG' ? 'ok' : 'error';
    assertEnv();
    const r = await fetch(BASE_URL(), {
      method:  'POST',
      headers: { Authorization: `Bearer ${AUTH_TOKEN()}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(['PING']),
    });
    const d = await r.json();
    return d.result === 'PONG' ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

module.exports = { redisCmd, redisPipeline, redisPing };
