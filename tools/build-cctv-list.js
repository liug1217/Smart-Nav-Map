// 產生監視器清單頁(監視器.html)用的資料 cctv_list_data.js
//   國道：高公局 CCTV.xml(有方向、路段起訖、所屬區域)
//   省道/快速公路：thb_cctv_data.js(公路局，說明文字最後的 (E)(W)(N)(S) 是方向)
// 用法：node tools/build-cctv-list.js        (會自動下載 CCTV.xml)
//      node tools/build-cctv-list.js 本機的CCTV.xml
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const XML_URL = 'https://tisvcloud.freeway.gov.tw/history/motc20/CCTV.xml';

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}
const tag = (s, t) => { const m = s.match(new RegExp('<' + t + '>([^<]*)</' + t + '>')); return m ? m[1].trim() : ''; };
// "32K+700" → 32700 公尺
const mileM = s => { const m = String(s).match(/(\d+)K\+(\d+)/i); return m ? (+m[1]) * 1000 + (+m[2]) : null; };
const round5 = n => Math.round(n * 1e5) / 1e5;

(async () => {
  const xml = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : await download(XML_URL);
  const fw = [];
  for (const m of xml.matchAll(/<CCTV>([\s\S]*?)<\/CCTV>/g)) {
    const c = m[1];
    const url = tag(c, 'VideoStreamURL');
    // 一般的攝影機網址只存編號(省空間)；國5 等不同主機或非數字編號的就存完整網址
    const std = url.match(/^https:\/\/cctvn\.freeway\.gov\.tw\/abs2mjpg\/bmjpg\?camera=(\d+)$/);
    const cam = std ? +std[1] : url;
    const mile = tag(c, 'LocationMile'), mm = mileM(mile);
    if (!cam || mm == null) continue;
    fw.push([
      tag(c, 'RoadName'), tag(c, 'RoadDirection'), tag(c, 'SubAuthorityCode').replace('NFB-', ''),
      tag(c, 'Start'), tag(c, 'End'), mm, round5(+tag(c, 'PositionLat')), round5(+tag(c, 'PositionLon')), cam
    ]);
  }
  global.window = {};
  require(path.join(ROOT, 'thb_cctv_data.js'));
  const thb = [];
  // 公路局的 road 欄位有時是國道或地方路名，統一改成「台X線」：先看本來的路名，再看說明文字，最後看影像網址裡的代碼(T2G → 台2庚線)
  const SUFFIX = { A: '甲', B: '乙', C: '丙', D: '丁', E: '戊', F: '己', G: '庚' };
  const roadOf = c => {
    if (/^台\d+[甲乙丙丁戊己庚]?線$/.test(c.road)) return c.road;
    const d = String(c.desc || '').match(/台\d+[甲乙丙丁戊己庚]?線/);
    if (d) return d[0];
    const u = String(c.url).match(/\/T(\d+)([A-G]?)-\d/);
    if (u) return '台' + u[1] + (SUFFIX[u[2]] || '') + '線';
    return c.road;
  };
  const DIRS = { 東: 'E', 西: 'W', 南: 'S', 北: 'N' };
  const dirOf = desc => {
    const m = desc.match(/[(\[]([NSEW])[)\]]\s*$|([NSEW])\s*$/);
    if (m) return m[1] || m[2];
    const z = desc.match(/([東西南北])向|往([東西南北])|([南])下|([北])上/);
    return z ? DIRS[z[1] || z[2] || z[3] || z[4]] : '';
  };
  for (const c of window.THB_CCTV_DATA || []) {
    const mm = mileM(c.mile);
    const raw = String(c.desc || '').trim();
    const dir = dirOf(raw);
    const desc = raw.replace(/\s*[(\[][NSEW][)\]]\s*$/, '').trim();
    if (mm == null || !c.url) continue;
    thb.push([roadOf(c), dir, desc, mm, round5(c.lat), round5(c.lon), c.url]);
  }
  const sortKey = (a, b) => a[0].localeCompare(b[0], 'zh-Hant') || a[1].localeCompare(b[1]);
  fw.sort((a, b) => sortKey(a, b) || a[5] - b[5]);
  thb.sort((a, b) => sortKey(a, b) || a[3] - b[3]);
  const out = '// 由 tools/build-cctv-list.js 產生，不要手動改\n' +
    '// fw  國道：[路名, 方向, 區域(NR北 CR中 SR南 PL坪林), 路段起, 路段迄, 里程(公尺), 緯度, 經度, 攝影機編號(數字)或完整網址]\n' +
    '// thb 省道：[路名, 方向, 說明, 里程(公尺), 緯度, 經度, 快照網址]\n' +
    'window.CCTV_LIST = {"updated":' + JSON.stringify(new Date().toISOString().slice(0, 10)) +
    ',\n"fw":' + JSON.stringify(fw) + ',\n"thb":' + JSON.stringify(thb) + '};\n';
  fs.writeFileSync(path.join(ROOT, 'cctv_list_data.js'), out);
  console.log('國道', fw.length, '支，省道', thb.length, '支，', Math.round(out.length / 1024), 'KB');
})().catch(e => { console.error(e); process.exit(1); });
