// 網站更新狀態：更新時(tools/release.js 推上 GitHub 前)設成「更新中」，網頁上方顯示綠色「更新中」；
// 更新完成(GitHub Pages 已經是新版)設回來，網頁顯示「更新完成」，同時推播更新內容給訂閱的人
//   狀態存在資料庫(update:status)，伺服器重開也還在；即時通道(/api/live)的 update 事件通知所有在線的網頁
//   改狀態要管理密碼：資料夾裡的 admin-key.txt(第一次自動產生；環境變數 SNM_ADMIN_KEY 優先)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redisCmd } = require('./redis');

const KEY = 'update:status', TEN_YEARS = 10 * 365 * 86400;
let state = null, listeners = [];

function adminKeyFile() { return path.join(process.env.SNM_DATA_DIR || path.join(__dirname, '..', '.data'), 'admin-key.txt'); }
function adminKey() {
  if (process.env.SNM_ADMIN_KEY) return process.env.SNM_ADMIN_KEY;
  const f = adminKeyFile();
  try { return fs.readFileSync(f, 'utf8').trim(); } catch (_) {}
  const k = crypto.randomBytes(24).toString('hex');
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, k); } catch (_) {}
  return k;
}
function checkKey(k) {
  const a = Buffer.from(String(k || '')), b = Buffer.from(adminKey());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function get() {
  if (state) return state;
  try { const s = await redisCmd('GET', KEY); state = s ? JSON.parse(s) : null; } catch (_) {}
  if (!state) state = { updating: false, notes: '', since: 0, doneAt: 0 };
  return state;
}
async function set(next) {
  state = Object.assign(await get(), next);
  try { await redisCmd('SETEX', KEY, TEN_YEARS, JSON.stringify(state)); } catch (_) {}
  listeners.forEach((fn) => { try { fn(state); } catch (_) {} });
  return state;
}
function onChange(fn) { listeners.push(fn); }

module.exports = { get, set, onChange, checkKey, adminKey, adminKeyFile };
