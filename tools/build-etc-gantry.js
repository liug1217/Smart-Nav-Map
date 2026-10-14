// 產生國道 ETC 收費門架位置資料 etc_gantry_data.js(路線選擇時數「經過幾個收費門架」用)
// 資料來源：高公局 ETag.xml(門架位置、方向)
// 用法：node tools/build-etc-gantry.js        (會自動下載)
//      node tools/build-etc-gantry.js 本機的ETag.xml
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const URL = 'https://tisvcloud.freeway.gov.tw/history/motc20/ETag.xml';

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
const round5 = n => Math.round(n * 1e5) / 1e5;

(async () => {
  const xml = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : await download(URL);
  const out = [];
  for (const m of xml.matchAll(/<ETag>([\s\S]*?)<\/ETag>/g)) {
    const b = m[1];
    const lon = +tag(b, 'PositionLon'), lat = +tag(b, 'PositionLat'), dir = tag(b, 'RoadDirection');
    if (!lon || !lat || !/^[NSEW]$/.test(dir)) continue;
    out.push([round5(lon), round5(lat), dir, tag(b, 'ETagGantryID')]);
  }
  const txt = '// 由 tools/build-etc-gantry.js 產生，不要手動改\n' +
    '// 國道 ETC 收費門架：[經度, 緯度, 方向(N北上 S南下 E東向 W西向), 門架編號]\n' +
    'window.ETC_GANTRY = ' + JSON.stringify(out) + ';\n';
  fs.writeFileSync(path.join(ROOT, 'etc_gantry_data.js'), txt);
  console.log('門架', out.length, '個，', Math.round(txt.length / 1024), 'KB');
})().catch(e => { console.error(e); process.exit(1); });
