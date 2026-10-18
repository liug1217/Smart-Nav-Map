// ===== 🌤 天空(地圖往下拉、看到地平線上面時的背景) =====
// 照現在這個位置的太陽高度角換顏色，一天之中慢慢變：
//   深夜 → 黎明(深藍、地平線泛紫紅) → 日出(地平線橘黃) → 早上(淡藍) → 中午(深藍) →
//   下午(藍、地平線偏暖) → 黃昏(地平線橘紅) → 傍晚(紫) → 晚上(深藍黑)
// 早上、傍晚分開兩組顏色(太陽升起跟落下的顏色不一樣)；兩個顏色之間用內插，不會突然跳。每分鐘更新一次，換地圖樣式後重設。
// 太陽高度角：簡化的天文公式(誤差約 1 度，換天空顏色夠用)
// 月亮之後再做(會照真實月相顯示)
(function () {
  'use strict';
  var D2R = Math.PI / 180;

  // 太陽高度角(度)、是不是上午(太陽還在往上爬)
  function sunAt(date, lon, lat) {
    var d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
    var g = (357.529 + 0.98560028 * d) * D2R, q = 280.459 + 0.98564736 * d;
    var L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R, e = (23.439 - 0.00000036 * d) * D2R;
    var ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
    var gmst = (18.697374558 + 24.06570982441908 * d) % 24;
    var H = ((gmst * 15 + lon) * D2R - ra) % (2 * Math.PI);
    if (H > Math.PI) H -= 2 * Math.PI; if (H < -Math.PI) H += 2 * Math.PI;
    var alt = Math.asin(Math.sin(lat * D2R) * Math.sin(dec) + Math.cos(lat * D2R) * Math.cos(dec) * Math.cos(H)) / D2R;
    return { alt: alt, morning: H < 0 };
  }

  // [太陽高度角, 天空, 地平線]
  var NIGHT = [-18, '#050B1E', '#0E1838'];
  var MORNING = [NIGHT,
    [-12, '#0E1A3D', '#2A3566'],    // 天快亮
    [-6, '#283E7A', '#D9867A'],     // 黎明：地平線泛紫紅
    [-2, '#4A6FB0', '#F4A56E'],
    [3, '#6E9BD6', '#FFC98A'],      // 日出：地平線橘黃
    [10, '#78B4EC', '#DCEBF5'],     // 早上：淡藍
    [25, '#5AA6EC', '#CFE6F7'],
    [45, '#3F93E8', '#C4E1F8']];    // 中午：深藍
  var EVENING = [NIGHT,
    [-12, '#111A3E', '#2C2650'],    // 晚上
    [-6, '#24305F', '#9B4E6E'],     // 傍晚：紫
    [-2, '#3C4F8F', '#E9765A'],
    [3, '#5A79B8', '#FF9F5E'],      // 黃昏：地平線橘紅(太陽快下山才變色)
    [6, '#5E8FD0', '#F6C99A'],
    [9, '#66A4E6', '#D6E8F6'],      // 下午：跟白天一樣的藍天(以前太陽還很高就偏暖、看起來像傍晚)
    [25, '#5AA6EC', '#CFE6F7'],
    [45, '#3F93E8', '#C4E1F8']];

  function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
  function mix(a, b, t) {
    var A = hex(a), B = hex(b);
    return 'rgb(' + [0, 1, 2].map(function (i) { return Math.round(A[i] + (B[i] - A[i]) * t); }).join(',') + ')';
  }
  function colorsAt(alt, morning) {
    var list = morning ? MORNING : EVENING;
    if (alt <= list[0][0]) return { sky: list[0][1], horizon: list[0][2] };
    for (var i = 1; i < list.length; i++) {
      if (alt <= list[i][0]) {
        var a = list[i - 1], b = list[i], t = (alt - a[0]) / (b[0] - a[0]);
        return { sky: mix(a[1], b[1], t), horizon: mix(a[2], b[2], t) };
      }
    }
    var z = list[list.length - 1];
    return { sky: z[1], horizon: z[2] };
  }

  var forced = null;   // 除錯用：指定時間
  function apply() {
    var m = window.map;
    if (!m || typeof m.setSky !== 'function' || !(m.style && m.style._loaded)) return;   // 不用 isStyleLoaded(圖磚在載入時常常是 false)
    var c = m.getCenter(), s = sunAt(forced || new Date(), c.lng, c.lat), col = colorsAt(s.alt, s.morning);
    try {
      m.setSky({
        'sky-color': col.sky, 'horizon-color': col.horizon, 'fog-color': col.horizon,
        'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.92, 'atmosphere-blend': 0
      });
    } catch (e) { /* 舊版地圖沒有天空 */ }
  }
  window._snmSkyAt = function (date) { forced = date || null; apply(); return forced ? sunAt(forced, window.map.getCenter().lng, window.map.getCenter().lat) : null; };   // 除錯用
  function init() {
    var m = window.map;
    if (!m) { setTimeout(init, 500); return; }
    m.on('style.load', apply);   // 換地圖樣式後天空會被清掉
    if (m.isStyleLoaded()) apply(); else m.once('load', apply);
    setInterval(function () { if (!document.hidden) apply(); }, 60000);   // 網頁在背景時不重算(省電)
    document.addEventListener('visibilitychange', function () { if (!document.hidden) apply(); });
  }
  init();
})();
