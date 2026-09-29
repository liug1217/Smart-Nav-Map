// 本機資料儲存：用自己的電腦當伺服器時取代雲端 Redis。
// 只實作後端實際用到的指令(GET / SETEX / EXPIRE / ZADD / ZREM / ZCOUNT / ZRANGEBYSCORE /
// ZREMRANGEBYSCORE / PING)，資料放在記憶體，每幾秒寫一次到 <資料夾>/store.json，重開不會遺失。

const fs   = require('fs');
const path = require('path');

const SAVE_EVERY_MS  = 5000;
const SWEEP_EVERY_MS = 60 * 1000;

let dataDir   = null;
let storeFile = null;
const keys    = new Map(); // key -> { type: 'string', value, exp } | { type: 'zset', members: Map<member, score>, exp }
let dirty     = false;

function now() { return Date.now(); }

function alive(key) {
  const e = keys.get(key);
  if (!e) return null;
  if (e.exp && e.exp <= now()) { keys.delete(key); dirty = true; return null; }
  return e;
}

// Redis 分數範圍：'-inf' / '+inf' / 數字 / '(數字' (不含)
function parseBound(s, isMin) {
  s = String(s);
  if (s === '-inf') return { v: -Infinity, excl: false };
  if (s === '+inf' || s === 'inf') return { v: Infinity, excl: false };
  if (s[0] === '(') return { v: Number(s.slice(1)), excl: true };
  const v = Number(s);
  if (Number.isNaN(v)) throw new Error(`ERR min or max is not a float (${isMin ? 'min' : 'max'})`);
  return { v, excl: false };
}
function inRange(score, min, max) {
  const lo = min.excl ? score > min.v : score >= min.v;
  const hi = max.excl ? score < max.v : score <= max.v;
  return lo && hi;
}

function zset(key, create) {
  let e = alive(key);
  if (!e && create) { e = { type: 'zset', members: new Map(), exp: 0 }; keys.set(key, e); }
  if (e && e.type !== 'zset') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
  return e;
}

function exec(args) {
  const [rawCmd, ...a] = args;
  const cmd = String(rawCmd).toUpperCase();
  switch (cmd) {
    case 'PING': return 'PONG';

    case 'GET': {
      const e = alive(a[0]);
      if (!e) return null;
      if (e.type !== 'string') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
      return e.value;
    }
    case 'SETEX': {
      const [key, sec, value] = a;
      keys.set(key, { type: 'string', value: String(value), exp: now() + Number(sec) * 1000 });
      dirty = true;
      return 'OK';
    }
    case 'EXPIRE': {
      const e = alive(a[0]);
      if (!e) return 0;
      e.exp = now() + Number(a[1]) * 1000;
      dirty = true;
      return 1;
    }

    case 'ZADD': {
      const [key, ...pairs] = a;
      const z = zset(key, true);
      let added = 0;
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        const member = String(pairs[i + 1]);
        if (!z.members.has(member)) added++;
        z.members.set(member, Number(pairs[i]));
      }
      dirty = true;
      return added;
    }
    case 'ZREM': {
      const [key, ...members] = a;
      const z = zset(key, false);
      if (!z) return 0;
      let n = 0;
      for (const m of members) if (z.members.delete(String(m))) n++;
      if (!z.members.size) keys.delete(key);
      if (n) dirty = true;
      return n;
    }
    case 'ZCOUNT': {
      const z = zset(a[0], false);
      if (!z) return 0;
      const min = parseBound(a[1], true), max = parseBound(a[2], false);
      let n = 0;
      for (const s of z.members.values()) if (inRange(s, min, max)) n++;
      return n;
    }
    case 'ZRANGEBYSCORE': {
      const z = zset(a[0], false);
      if (!z) return [];
      const min = parseBound(a[1], true), max = parseBound(a[2], false);
      return [...z.members.entries()]
        .filter(([, s]) => inRange(s, min, max))
        .sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : 1))
        .map(([m]) => m);
    }
    case 'ZREMRANGEBYSCORE': {
      const z = zset(a[0], false);
      if (!z) return 0;
      const min = parseBound(a[1], true), max = parseBound(a[2], false);
      let n = 0;
      for (const [m, s] of z.members) if (inRange(s, min, max)) { z.members.delete(m); n++; }
      if (!z.members.size) keys.delete(a[0]);
      if (n) dirty = true;
      return n;
    }
    default:
      throw new Error(`ERR 本機儲存不支援指令 ${cmd}`);
  }
}

function sweepExpired() {
  const t = now();
  let n = 0;
  for (const [k, e] of keys) {
    if (e.exp && e.exp <= t) { keys.delete(k); n++; }
  }
  if (n) dirty = true;
  return n;
}

function save() {
  if (!dirty || !storeFile) return;
  const out = {};
  const t = now();
  for (const [k, e] of keys) {
    if (e.exp && e.exp <= t) continue;
    out[k] = e.type === 'zset'
      ? { type: 'zset', exp: e.exp, members: [...e.members] }
      : { type: 'string', exp: e.exp, value: e.value };
  }
  const tmp = storeFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, storeFile); // 先寫暫存檔再改名，寫到一半當機也不會弄壞原本的資料
  dirty = false;
}

function load() {
  if (!fs.existsSync(storeFile)) return;
  try {
    const data = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    const t = now();
    for (const [k, e] of Object.entries(data)) {
      if (e.exp && e.exp <= t) continue;
      keys.set(k, e.type === 'zset'
        ? { type: 'zset', exp: e.exp, members: new Map(e.members) }
        : { type: 'string', exp: e.exp, value: e.value });
    }
  } catch (e) {
    // 檔案壞掉時保留一份，從空白開始，不讓伺服器起不來
    const bad = storeFile + '.broken-' + Date.now();
    try { fs.renameSync(storeFile, bad); } catch {}
    console.error('[local-store] store.json 讀取失敗，已改名為', bad, e.message);
  }
}

function init(dir) {
  if (dataDir) return;
  dataDir   = path.resolve(dir);
  storeFile = path.join(dataDir, 'store.json');
  fs.mkdirSync(dataDir, { recursive: true });
  load();
  const timer = setInterval(() => { try { save(); } catch (e) { console.error('[local-store] 儲存失敗', e.message); } }, SAVE_EVERY_MS);
  timer.unref();
  // 到期的資料只有被讀到時才會清掉；像限速紀錄、上次位置這類短期資料很多之後不會再被讀，
  // 會一直留在記憶體裡越堆越多 → 每分鐘掃一次清掉
  setInterval(sweepExpired, SWEEP_EVERY_MS).unref();
  const flush = () => { try { dirty = true; save(); } catch {} };
  process.on('exit', flush);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    process.on(sig, () => { flush(); process.exit(0); });
  }
}

module.exports = { init, exec, save, sweepExpired, _keys: keys };
