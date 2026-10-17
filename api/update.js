// GET  /api/update  目前的更新狀態 { updating, notes, since, doneAt }
// POST /api/update  { key: 管理密碼, action: 'start' | 'done', notes: '這次更新的內容' }(tools/release.js 用)
//   start：網頁顯示綠色「更新中」
//   done ：網頁顯示「更新完成」，推播更新內容給訂閱的人(回傳推播結果)
const { corsHeaders, handlePreflight, ok, err, methodNotAllowed } = require('../lib/response');
const status = require('../lib/update-status');
const webpush = require('../lib/webpush');

module.exports = async (req, res) => {
  corsHeaders(res);
  if (handlePreflight(req, res)) return;
  if (req.method === 'GET') return ok(res, await status.get(), { cache: 'no-store' });
  if (req.method !== 'POST') return methodNotAllowed(res);
  const b = req.body || {};
  if (!status.checkKey(b.key)) return err(res, 403, 'forbidden', '管理密碼不對');
  const notes = String(b.notes || '').slice(0, 500);
  if (b.action === 'start') return ok(res, await status.set({ updating: true, notes, since: Date.now() }));
  if (b.action === 'done') {
    const s = await status.set({ updating: false, notes, doneAt: Date.now() });
    const push = b.push === false ? null : await webpush.sendAll({ title: '智行地圖已更新', body: notes || '有新版本了，打開看看！', url: 'https://liug1217.github.io/Smart-Nav-Map/智行地圖.html' });
    return ok(res, { status: s, push });
  }
  return err(res, 400, 'bad_action', 'action 要是 start 或 done');
};
