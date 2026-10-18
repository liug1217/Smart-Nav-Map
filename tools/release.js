// 發布新版：一個指令做完「通知更新中 → 推上 GitHub → 等網頁真的換成新版 → 通知更新完成 + 推播更新內容」
//
// 用法(在要推的那個資料夾，已經 commit 好)：
//   node tools/release.js "這次更新的內容(會顯示在推播通知裡)"
//   加 --no-push 只推 GitHub、不送推播通知
//
// 需要：這台電腦的後端伺服器開著(server\啟動伺服器.bat)。管理密碼自動從 C:\SmartNavData\admin-key.txt 讀
//   (伺服器第一次開會自己產生；環境變數 SNM_ADMIN_KEY 優先)。後端網址預設 http://localhost:8787/api(SNM_LOCAL_API 可改)
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = process.env.SNM_LOCAL_API || 'http://localhost:8787/api';
const PAGE = 'https://liug1217.github.io/Smart-Nav-Map/' + encodeURIComponent('智行地圖.html');
const args = process.argv.slice(2), noPush = args.includes('--no-push'), notes = args.filter((a) => a !== '--no-push').join(' ').trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function adminKey() {
  if (process.env.SNM_ADMIN_KEY) return process.env.SNM_ADMIN_KEY;
  const f = path.join(process.env.SNM_DATA_DIR || 'C:\\SmartNavData', 'admin-key.txt');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch (_) { return null; }
}
async function setStatus(action, extra) {
  const key = adminKey();
  if (!key) { console.log('  (找不到管理密碼，先開一次後端伺服器讓它產生 admin-key.txt；這次跳過網站通知)'); return null; }
  try {
    const r = await fetch(API + '/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ key, action, notes }, extra || {})) });
    const j = await r.json();
    if (!j.ok) { console.log('  後端回錯誤：', j.error && j.error.message); return null; }
    return j.data;
  } catch (e) { console.log('  連不到後端伺服器(' + API + ')，這次跳過網站通知：', e.message); return null; }
}

(async () => {
  if (!notes) { console.log('用法：node tools/release.js "這次更新的內容"'); process.exit(1); }
  console.log('1/4 通知網站：更新中…');
  await setStatus('start');

  console.log('2/4 推上 GitHub(main)…');
  try { execSync('git push origin HEAD:main', { cwd: ROOT, stdio: 'inherit' }); }
  catch (e) { console.log('推上 GitHub 失敗，取消「更新中」'); await setStatus('done', { push: false }); process.exit(1); }

  console.log('3/4 等 GitHub Pages 換成新版(最多 10 分鐘)…');
  // 比對前去掉 BOM(本機檔案開頭有，GitHub Pages 抓下來時會被去掉，不去掉永遠「不一樣」)、統一換行
  const norm = (t) => t.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const local = norm(fs.readFileSync(path.join(ROOT, '智行地圖.html'), 'utf8'));
  let live = false;
  for (let i = 0; i < 40 && !live; i++) {
    await wait(15000);
    try {
      const t = norm(await (await fetch(PAGE + '?v=' + Date.now(), { cache: 'no-store' })).text());
      live = t === local;
    } catch (_) {}
    process.stdout.write(live ? '  新版上線了\n' : '  還沒…(' + ((i + 1) * 15) + ' 秒)\n');
  }
  if (!live) console.log('  等太久了，網頁可能還在更新；照樣通知更新完成');

  console.log('4/4 通知網站：更新完成' + (noPush ? '' : '，推播更新內容') + '…');
  const r = await setStatus('done', { push: !noPush });
  if (r && r.push) console.log(`  推播：送出 ${r.push.sent}／${r.push.total}，失敗 ${r.push.failed}，已失效移除 ${r.push.removed}`);
  console.log('完成！');
})();
