// 上游公開資料(高公局、臺北市交通局…)的共用抓取器：照上游「實際更新的時間」抓，不用固定間隔硬抓。
//   - 用上游回的 Last-Modified 跟 Date 算出檔案已經多舊，推出下一次大概什麼時候更新，時間到了就去看
//     (用上游自己的 Date 比，不用我們的時鐘：實測高公局時鐘比我們快十幾秒，直接比會算錯)
//   - 上游偶爾一分鐘內多更新一次，所以兩次更新之間每 15 秒也問一下
//   - 去看時帶 If-None-Match / If-Modified-Since，沒更新上游回 304(不用下載整份檔案)
//   - 同一個網址全伺服器共用一份(國道車速、國道路況都用 LiveTraffic.xml，只抓一次)
// 回傳的 nextUpdateIn(還要幾毫秒)也給前端，前端照這個時間來抓，資料一更新就拿到。

const SETTLE_MS = 1000;               // 預計更新時間再過 1 秒去抓
const LATE_RECHECK_MS = 3 * 1000;     // 預計時間到了還沒更新：每 3 秒再問一次(304 很省)
const STALE_RECHECK_MS = 30 * 1000;   // 上游已經晚超過 5 分鐘(可能停更)：改 30 秒問一次
const BETWEEN_MS = 15 * 1000;         // 兩次正常更新之間，每 15 秒問一下有沒有額外更新
const MIN_CLIENT_MS = 5 * 1000;       // 叫前端最快 5 秒後再來

const feeds = new Map();

function feed(url, { periodMs = 60 * 1000, binary = false, timeoutMs = 30000 } = {}) {
  if (feeds.has(url)) return feeds.get(url);
  const f = {
    url, periodMs,
    body: null,          // 最新一份內容(文字或 Buffer)
    version: 0,          // 內容有換就 +1，使用的地方用它判斷要不要重新解析
    expectAt: 0,         // 預計下一次上游更新(我們的時鐘)
    checkedAt: 0,        // 最後一次確認過是最新的時間
    nextCheckAt: 0,
    loading: null,
    // 前端還要等幾毫秒再來抓：預計上游更新、我們抓到之後(給相對時間，手機時鐘不準也沒關係)
    get nextUpdateIn() {
      const now = Date.now();
      if (now - modifiedLocal > 5 * 60 * 1000) return STALE_RECHECK_MS;   // 上游停更：前端也不用一直來
      return Math.max(MIN_CLIENT_MS, f.expectAt + 1000 - now);
    },
    due() { return !f.body || Date.now() >= f.nextCheckAt; },
    // 需要的話去看一次上游；waitMs 內等它完成，超過就先用手上的
    async get(waitMs = 0) {
      if (f.due() && !f.loading) f.loading = check().finally(() => { f.loading = null; });
      if (f.loading && (waitMs > 0 || !f.body)) {
        await Promise.race([f.loading.catch(() => {}), new Promise(r => setTimeout(r, f.body ? waitMs : timeoutMs))]);
      }
      if (!f.body) throw f.lastError || new Error('no data ' + url);
      return f;
    },
  };
  let etag = null, lastModified = null, modifiedLocal = 0;
  const plan = (now) => {
    if (now < f.expectAt) f.nextCheckAt = Math.min(f.expectAt, now + BETWEEN_MS);
    else f.nextCheckAt = now + (now - modifiedLocal > 5 * 60 * 1000 ? STALE_RECHECK_MS : LATE_RECHECK_MS);
  };
  async function check() {
    const headers = {};
    if (f.body && etag) headers['If-None-Match'] = etag;
    if (f.body && lastModified) headers['If-Modified-Since'] = lastModified;
    try {
      // 已經有資料：先用 HEAD 看檔案時間有沒有變(高公局不支援 304，不先看的話每次都會下載整份)
      if (f.body && (etag || lastModified)) {
        const h = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
        if (h && h.ok && h.headers.get('etag') === etag && h.headers.get('last-modified') === lastModified) {
          f.checkedAt = Date.now(); plan(f.checkedAt); return;
        }
      }
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      const now = Date.now();
      if (r.status === 304) { f.checkedAt = now; plan(now); return; }
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
      const body = binary ? Buffer.from(await r.arrayBuffer()) : await r.text();
      etag = r.headers.get('etag'); lastModified = r.headers.get('last-modified');
      // 檔案多舊：上游的 Date - Last-Modified(兩個都是上游時鐘)
      const mod = Date.parse(lastModified || ''), date = Date.parse(r.headers.get('date') || '');
      const age = (mod && date) ? Math.max(0, date - mod) : 0;
      modifiedLocal = now - age;
      if (body !== f.body) { f.body = body; f.version++; }
      f.checkedAt = now; f.lastError = null;
      f.expectAt = modifiedLocal + periodMs + SETTLE_MS;
      plan(now);
    } catch (e) {
      f.lastError = e;
      f.nextCheckAt = Date.now() + 10 * 1000;   // 連不到：10 秒後再試
      throw e;
    }
  }
  feeds.set(url, f);
  return f;
}

module.exports = { feed };
