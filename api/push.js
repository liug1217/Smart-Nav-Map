// GET  /api/push                       推播用的公開金鑰 { publicKey }(網頁訂閱時要用)
// POST /api/push { subscription }      訂閱更新通知(網頁 pushManager.subscribe 拿到的那個)
// POST /api/push { unsubscribe: endpoint } 取消
const { corsHeaders, handlePreflight, ok, err, methodNotAllowed } = require('../lib/response');
const webpush = require('../lib/webpush');

module.exports = async (req, res) => {
  corsHeaders(res);
  if (handlePreflight(req, res)) return;
  if (req.method === 'GET') return ok(res, { publicKey: (await webpush.getVapid()).publicKey }, { cache: 'no-store' });
  if (req.method !== 'POST') return methodNotAllowed(res);
  const b = req.body || {};
  if (b.unsubscribe) { await webpush.removeSubscription(String(b.unsubscribe)); return ok(res, { removed: true }); }
  if (!(await webpush.addSubscription(b.subscription))) return err(res, 400, 'bad_subscription', '訂閱資料不對');
  return ok(res, { subscribed: true });
};
