// 管理地標留言：
//   node tools/comments.js            看最近 30 天的留言(新的在前)
//   node tools/comments.js 7          看最近 7 天
//   node tools/comments.js remove <編號>   刪掉一則留言或一張照片(留言編號、照片編號都可以；可一次給多個)
// 直接讀伺服器存檔(只讀)；刪除是寫進 comments-removed.json，伺服器馬上就不再顯示，不用重開。
// 不能載入 lib/local-store，那會在結束時把舊資料寫回去、蓋掉伺服器剛存的。

const fs = require('fs');
const path = require('path');

const dir = process.env.SNM_DATA_DIR || 'C:\\SmartNavData';
const removedFile = path.join(dir, 'comments-removed.json');
const readRemoved = () => { try { return JSON.parse(fs.readFileSync(removedFile, 'utf8')); } catch (_) { return []; } };

if (process.argv[2] === 'remove') {
  const ids = process.argv.slice(3).filter(id => /^[a-f0-9]{24}$/.test(id));
  if (!ids.length) { console.log('用法：node tools/comments.js remove <留言或照片編號>'); process.exit(1); }
  const set = new Set(readRemoved());
  ids.forEach(id => set.add(id));
  fs.writeFileSync(removedFile, JSON.stringify([...set]));
  // 照片檔也一起刪(留言的話，裡面的照片在畫面上會跟著消失；檔案留著不影響)
  for (const id of ids) for (const f of [id + '.jpg', id + '_t.jpg']) { try { fs.unlinkSync(path.join(dir, 'photos', f)); } catch (_) {} }
  console.log(`已刪除 ${ids.length} 個：${ids.join(', ')}`);
  process.exit(0);
}

const days = Number(process.argv[2]) || 30;
const since = Date.now() - days * 24 * 3600 * 1000;
const removed = new Set(readRemoved());
const store = JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8'));
const LAYER = {
  'fm-points': '全家', 'seven-points': '7-ELEVEN', 'okmart-points': 'OK', 'hilife-points': '萊爾富', 'times-points': 'Times',
  'simplemart-points': '美廉社', 'dodohome-points': '嘟嘟房', 'mcd-points': '麥當勞', 'bafang-points': '八方雲集',
  'wanjiafu-points': '萬家福', 'lejiakang-points': '樂家康', 'showba-points': '小北百貨', 'shopee-points': '蝦皮店到店', 'cityparking-points': '城市車旅', 'hospital-points': '醫院', 'ntpcpark-points': '新北公有停車場', 'youbike-points': 'YouBike',
  'pxmart-points': '全聯', 'cpc-points': '中油', 'toilet-points': '公廁', 'speed-point': '測速', 'cctv-point': '監視器', 'signal-points': '紅綠燈', 'place-points': '地點',
};
const rows = [];
for (const [k, v] of Object.entries(store)) {
  if (!k.startsWith('cm:') || v.type !== 'zset') continue;
  const layer = k.split(':')[1];
  for (const [m] of v.members) {
    try { const c = JSON.parse(m); if (c.t >= since && !removed.has(c.id)) rows.push({ ...c, layer }); } catch (_) {}
  }
}
rows.sort((a, b) => b.t - a.t);
if (!rows.length) { console.log(`最近 ${days} 天沒有留言`); process.exit(0); }
console.log(`最近 ${days} 天：${rows.length} 則留言\n`);
const when = t => new Date(t + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
for (const c of rows) {
  console.log(`${'★'.repeat(c.stars)}${'☆'.repeat(5 - c.stars)} ${LAYER[c.layer] || c.layer}｜${c.place || ''}｜${c.nick || '智行地圖使用者'}｜${when(c.t)}｜留言 ${c.id}`);
  if (c.text) console.log(`      「${c.text}」`);
  for (const p of c.photos.filter(p => !removed.has(p.id))) {
    console.log(`      📷 ${p.id}${p.taken ? '  拍攝 ' + p.taken : ''}  檔案：${path.join(dir, 'photos', p.id + '.jpg')}`);
  }
}
console.log('\n刪除：node tools/comments.js remove <編號>');
