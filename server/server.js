// 用自己的電腦當後端伺服器：執行 api/ 裡原本給 Vercel 用的程式，資料存在本機資料夾。
// 網頁照樣放在 GitHub Pages，只有 /api/... 連到這台電腦(透過 Tailscale Funnel 的 HTTPS 網址)。
//
// 啟動：node server/server.js   (或雙擊 server/啟動伺服器.bat)
// 設定(環境變數或專案根目錄的 .env)：
//   PORT          伺服器埠號，預設 8787
//   SNM_DATA_DIR  資料存放資料夾，預設 C:\SmartNavData(不要放在 OneDrive 裡，會一直同步)
//   TDX_CLIENT_ID / TDX_CLIENT_SECRET  捷運資料用(選填)
// 不需要安裝任何 npm 套件。

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT    = path.resolve(__dirname, '..');
const API_DIR = path.join(ROOT, 'api');

// ── 讀 .env(不覆蓋已經設定的環境變數) ──────────────────────────────────────
(function loadDotEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined && v !== '') process.env[m[1]] = v;
  }
})();

const PORT = Number(process.env.PORT) || 8787;
if (!process.env.SNM_DATA_DIR) process.env.SNM_DATA_DIR = 'C:\\SmartNavData';

const MAX_BODY = 100 * 1024;

// /api/traffic/position → api/traffic/position.js；只允許 api 資料夾裡真的存在的檔案
const handlers = new Map();
function findHandler(urlPath) {
  const rel = urlPath.replace(/^\/api\//, '').replace(/\/+$/, '');
  if (!/^[a-z0-9\-]+(\/[a-z0-9\-]+)*$/i.test(rel)) return null;
  if (handlers.has(rel)) return handlers.get(rel);
  const file = path.join(API_DIR, rel + '.js');
  if (!file.startsWith(API_DIR + path.sep) || !fs.existsSync(file)) return null;
  const h = require(file);
  handlers.set(rel, h);
  return h;
}

// 把 Node 原生的 req/res 包成 Vercel 函式用的樣子(req.query、req.body、res.status().json())
function adapt(req, res, url, body) {
  req.query = Object.fromEntries(url.searchParams);
  req.body  = body;
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = data => { res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data)); return res; };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return resolve(undefined);
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      if ((req.headers['content-type'] || '').includes('application/json')) {
        try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
      } else resolve(raw);
    });
    req.on('error', reject);
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const server = http.createServer(async (req, res) => {
  const t0  = Date.now();
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/' || url.pathname === '/api' || url.pathname === '/api/') {
      cors(res);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('智行地圖後端伺服器運作中。健康檢查：/api/health\n');
      return;
    }
    if (!url.pathname.startsWith('/api/')) { res.statusCode = 404; res.end(); return; }

    const handler = findHandler(url.pathname);
    if (!handler) { cors(res); res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); res.end('{"ok":false,"error":{"code":"not_found"}}'); return; }

    let body;
    try { body = await readBody(req); }
    catch (e) { cors(res); res.statusCode = e.status || 400; res.end(); return; }

    adapt(req, res, url, body);
    await (handler.default || handler)(req, res);
    if (!res.writableEnded) res.end();
  } catch (e) {
    console.error('[server]', req.method, url.pathname, e);
    if (!res.headersSent) { cors(res); res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); }
    if (!res.writableEnded) res.end('{"ok":false,"error":{"code":"server_error"}}');
  } finally {
    if (process.env.SNM_LOG !== '0') {
      console.log(new Date().toISOString().slice(11, 19), req.method, url.pathname, res.statusCode, (Date.now() - t0) + 'ms');
    }
  }
});

server.listen(PORT, () => {
  console.log('────────────────────────────────────────────');
  console.log(' 智行地圖後端伺服器已啟動');
  console.log(' 本機網址：http://localhost:' + PORT + '/api/health');
  console.log(' 資料資料夾：' + process.env.SNM_DATA_DIR);
  console.log(' 關閉伺服器：按 Ctrl + C');
  console.log('────────────────────────────────────────────');
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error('埠號 ' + PORT + ' 已被使用，伺服器可能已經在執行了。');
  else console.error(e);
  process.exit(1);
});
