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
  const all = [];
  for (const m of xml.matchAll(/<ETag>([\s\S]*?)<\/ETag>/g)) {
    const b = m[1];
    const lon = +tag(b, 'PositionLon'), lat = +tag(b, 'PositionLat'), dir = tag(b, 'RoadDirection');
    const mm = tag(b, 'LocationMile').match(/(\d+)k\+(\d+)/i);
    if (!lon || !lat || !/^[NSEW]$/.test(dir) || !mm) continue;
    all.push({ lon, lat, dir, id: tag(b, 'ETagGantryID'), road: tag(b, 'RoadName'), m: (+mm[1]) * 1000 + (+mm[2]) });
  }
  // 每個門架真正的行車方向：國道不一定南北向(國3 在雙北、桃園是東西向，還有彎道)，不能用「北上/南下」猜。
  // 用同一條路、同方向、里程相鄰的門架位置算：南下/東向是里程增加的方向，北上/西向是里程減少的方向
  const brg = (a, b) => (Math.atan2((b.lon - a.lon) * Math.cos(a.lat * Math.PI / 180), b.lat - a.lat) * 180 / Math.PI + 360) % 360;
  const out = [];
  all.forEach(g => {
    const same = all.filter(x => x.road === g.road && x.dir === g.dir).sort((a, b) => a.m - b.m);
    const i = same.indexOf(g), up = g.dir === 'S' || g.dir === 'E';
    const prev = same[i - 1], next = same[i + 1];
    // 行車方向上的「下一個」與「上一個」
    const ahead = up ? next : prev, behind = up ? prev : next;
    let b = null;
    if (ahead) b = brg(g, ahead); else if (behind) b = brg(behind, g);
    out.push([round5(g.lon), round5(g.lat), g.dir, g.id, b == null ? -1 : Math.round(b)]);
  });
  const txt = '// 由 tools/build-etc-gantry.js 產生，不要手動改\n' +
    '// 國道 ETC 收費門架：[經度, 緯度, 方向(N北上 S南下 E東向 W西向), 門架編號, 行車方位角(度，由前後門架位置算，-1=算不出來)]\n' +
    'window.ETC_GANTRY = ' + JSON.stringify(out) + ';\n';
  fs.writeFileSync(path.join(ROOT, 'etc_gantry_data.js'), txt);
  console.log('門架', out.length, '個，', Math.round(txt.length / 1024), 'KB');
})().catch(e => { console.error(e); process.exit(1); });
