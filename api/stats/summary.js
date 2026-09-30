// GET /api/stats/summary?days=14
// 使用統計摘要：每天幾人用、幾人開車、最多同時在線的人數與時間、每小時平均在線人數。
// 只有人數，沒有任何個人資料或位置。

const { corsHeaders, methodNotAllowed, ok, err } = require('../../lib/response');
const { summary } = require('../../lib/stats');

module.exports = async (req, res) => {
  corsHeaders(res);
  if (req.method !== 'GET') return methodNotAllowed(res);
  const days = Math.max(1, Math.min(60, parseInt(req.query.days, 10) || 14));
  try {
    return ok(res, await summary(days));
  } catch (e) {
    console.error('[stats/summary]', e.message);
    return err(res, 503, 'service_unavailable', 'Storage error');
  }
};
