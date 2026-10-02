// 看使用者的地標回報：node tools/reports.js [天數，預設 30]
// 直接讀伺服器存檔(C:\SmartNavData\store.json)，只在這台電腦上看得到。
// 只讀不寫：不能載入 lib/local-store，那會在結束時把舊資料寫回去、蓋掉伺服器剛存的。
// 伺服器每隔一段時間才存檔，剛送出的回報可能要等一下才看得到。
// 同一個地標、同一種問題的回報會合併計數，回報的人越多越可信。

const fs = require('fs');
const path = require('path');
const { REASONS, LAYERS } = require('../lib/reports');

const file = path.join(process.env.SNM_DATA_DIR || 'C:\\SmartNavData', 'store.json');
const days = Number(process.argv[2]) || 30;
const since = Date.now() - days * 24 * 3600 * 1000;

const store = JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = ((store.reports && store.reports.members) || [])
  .filter(([, score]) => score >= since)
  .map(([m]) => { try { return JSON.parse(m); } catch (_) { return null; } })
  .filter(Boolean);
if (!rows.length) { console.log(`最近 ${days} 天沒有回報`); process.exit(0); }

const groups = new Map();
for (const r of rows) {
  const key = `${r.layer}|${r.lat.toFixed(5)}|${r.lng.toFixed(5)}|${r.reason}`;
  let g = groups.get(key);
  if (!g) { g = { ...r, people: new Set(), notes: [], last: 0 }; groups.set(key, g); }
  g.people.add(r.sid);
  if (r.note) g.notes.push(r.note);
  g.last = Math.max(g.last, r.t);
}
const list = [...groups.values()].sort((a, b) => b.people.size - a.people.size || b.last - a.last);
console.log(`最近 ${days} 天：${rows.length} 筆回報，${list.length} 個問題\n`);
for (const g of list) {
  const when = new Date(g.last + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
  console.log(`[${g.people.size} 人] ${LAYERS[g.layer] || g.layer}｜${g.name || '(無名稱)'}｜${REASONS[g.reason]}｜${g.lat},${g.lng}｜最後 ${when}`);
  for (const n of g.notes.slice(-3)) console.log(`      「${n}」`);
}
