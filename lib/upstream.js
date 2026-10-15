// 上游公開資料(高公局、臺北市交通局…)的共用抓取器：照上游「實際更新的時間」抓，不用固定間隔硬抓。
//   - 用上游回的 Last-Modified 算出下一次大概幾點更新，時間到了才去看
//   - 去看時帶 If-None-Match / If-Modified-Since，沒更新上游回 304(不用下載整份檔案)，過 5 秒再看
//   - 同一個網址全伺服器共用一份(國道車速、國道路況都用 LiveTraffic.xml，只抓一次)
// 回傳的 nextUpdateIn(還要幾毫秒)也給前端，前端照這個時間來抓，資料一更新就拿到。

const RECHECK_MS = 5 * 1000;          // 預計更新時間到了還沒更新：每 5 秒再問一次(304 很省)
const LATE_RECHECK_MS = 30 * 1000;    // 上游已經晚超過 5 分鐘(可能停更)：改 30 秒問一次
const SETTLE_MS = 2 * 1000;           // 上游檔案時間 + 更新週期 + 2 秒再去抓，避開還沒寫完

const feeds = new Map();

function feed(url, { periodMs = 60 * 1000, binary = false, timeoutMs = 30000 } = {}) {
  if (feeds.has(url)) return feeds.get(url);
  const f = {
    url, periodMs,
    body: null,          // 最新一份內容(文字或 Buffer)
    version: 0,          // 內容有換就 +1，使用的地方用它判斷要不要重新解析
    modifiedAt: 0,       // 上游檔案的更新時間
    checkedAt: 0,        // 最後一次確認過是最新的時間
    nextCheckAt: 0,
    loading: null,
    // 前端還要等幾毫秒再來抓：預計上游更新、我們抓到之後(給相對時間，手機時鐘不準也沒關係)
    get nextUpdateIn() { return Math.max(RECHECK_MS, f.nextCheckAt + 1000 - Date.now()); },
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
  let etag = null, lastModified = null;
  async function check() {
    const headers = {};
    if (f.body && etag) headers['If-None-Match'] = etag;
    if (f.body && lastModified) headers['If-Modified-Since'] = lastModified;
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      const now = Date.now();
      if (r.status === 304) {
        f.checkedAt = now;
        const late = now - (f.modifiedAt + periodMs);
        f.nextCheckAt = now + (late > 5 * 60 * 1000 ? LATE_RECHECK_MS : RECHECK_MS);
        return;
      }
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
      const body = binary ? Buffer.from(await r.arrayBuffer()) : await r.text();
      etag = r.headers.get('etag'); lastModified = r.headers.get('last-modified');
      const mod = Date.parse(lastModified || '') || now;
      if (body !== f.body) { f.body = body; f.version++; }
      f.modifiedAt = mod; f.checkedAt = now; f.lastError = null;
      // 下一次預計更新的時間；上游時間怪怪的(太舊或在未來)就用現在算
      const expect = (now - mod < periodMs && mod <= now) ? mod + periodMs : now + periodMs;
      f.nextCheckAt = Math.max(now + RECHECK_MS, expect + SETTLE_MS);
    } catch (e) {
      f.lastError = e;
      f.nextCheckAt = Date.now() + RECHECK_MS * 2;   // 連不到：10 秒後再試
      throw e;
    }
  }
  feeds.set(url, f);
  return f;
}

module.exports = { feed };
