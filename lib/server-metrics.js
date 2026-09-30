// 伺服器自己的運作數據(給統計網站看)：啟動時間、啟動以來的請求數。
// 只有用 server/server.js 跑在自己電腦時才有；部署在 Vercel 時沒有這些值。

const metrics = { startedAt: null, requests: 0, errors: 0 };

function markStarted() { metrics.startedAt = Date.now(); }
function countRequest(status) {
  metrics.requests++;
  if (status >= 500) metrics.errors++;
}

module.exports = { metrics, markStarted, countRequest };
