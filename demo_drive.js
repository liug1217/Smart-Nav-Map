// ===== 🚗 示範導航(模擬行駛)：網址加 ?demo=1 才會跑，平常完全不影響 =====
// 從台北車站導航到台中車站，車子照真實速度開(國道 100 km/h、一般道路 45 km/h，不快轉)，每秒一個位置，
// 走的是跟手機真的 GPS 一模一樣的流程(_simulateGpsFix)，語音播報、轉彎提示、測速照相提醒都照常。可以用來看 3D 車道級導航整段的樣子。
// 打開後先按畫面中間的「開始」(瀏覽器要點一下才能出聲音)
// 網址參數：?demo=1(台北 → 台中)；也可以 ?demo=1&from=緯度,經度&to=緯度,經度 自己指定起訖點
(function () {
  'use strict';
  var q = new URLSearchParams(location.search);
  if (!q.get('demo')) return;
  var parse = function (s, d) { var a = (s || '').split(',').map(Number); return a.length === 2 && isFinite(a[0]) && isFinite(a[1]) ? a : d; };
  var FROM = parse(q.get('from'), [25.0478, 121.5170]), TO = parse(q.get('to'), [24.1369, 120.6866]);
  var FW = 27.8, CITY = 12.5;   // 公尺 / 秒

  // 定位改成起點(示範用，不用真的 GPS)
  try {
    navigator.geolocation.getCurrentPosition = function (ok) { setTimeout(function () { ok({ coords: { latitude: FROM[0], longitude: FROM[1], accuracy: 5, speed: 0, heading: null }, timestamp: Date.now() }); }, 50); };
    navigator.geolocation.watchPosition = function () { return 0; };
  } catch (e) {}
  window.simRunning = true;

  var bar = null;
  function banner(text) {
    if (!bar) {
      bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:99999;background:rgba(0,0,0,.72);color:#fff;font:600 13px -apple-system,"PingFang TC",sans-serif;padding:7px 14px;border-radius:999px;display:flex;gap:10px;align-items:center;';
      document.body.appendChild(bar);
    }
    bar.innerHTML = '<span>🚗 示範導航(模擬) ' + text + '</span><button style="border:0;border-radius:999px;padding:3px 10px;font:600 12px sans-serif;cursor:pointer">停止</button>';
    bar.querySelector('button').onclick = function () { stopped = true; bar.remove(); };
  }
  var stopped = false;

  function start() {
    if (!window.map || !window._simulateGpsFix || !window._navigateNow) { setTimeout(start, 500); return; }
    document.querySelectorAll('[class*=elcome]').forEach(function (e) { e.remove(); });   // 第一次使用的歡迎畫面先關掉
    window._simulateGpsFix({ coords: { latitude: FROM[0], longitude: FROM[1], speed: 0, accuracy: 5 }, timestamp: Date.now() });
    banner('規劃路線中…');
    Promise.resolve(window._navigateNow(TO[0], TO[1], '示範目的地')).then(function () { setTimeout(drive, 4000); });
  }
  function drive() {
    var rt = (window.plannedRouteCoordinates || []).slice();
    if (rt.length < 2) { banner('找不到路線'); return; }
    var d = function (a, b) { return Math.hypot((b[0] - a[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (b[1] - a[1]) * 110540); };
    var cum = [0]; for (var i = 1; i < rt.length; i++) cum.push(cum[i - 1] + d(rt[i - 1], rt[i]));
    var total = cum[cum.length - 1], s = 0, k = 0;
    var at = function (x) {
      while (k < cum.length - 2 && cum[k + 1] < x) k++;
      var t = (x - cum[k]) / ((cum[k + 1] - cum[k]) || 1), a = rt[k], b = rt[k + 1];
      return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], hd: (Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI + 360) % 360 };
    };
    var step = function () {
      if (stopped) return;
      var c = at(s), onFw = window._snmRoad3dAt ? !!window._snmRoad3dAt(c.p[0], c.p[1], 12) : false, v = onFw ? FW : CITY;
      window._simulateGpsFix({ coords: { latitude: c.p[1], longitude: c.p[0], speed: v, accuracy: 5, heading: c.hd }, timestamp: Date.now() });
      banner((s / 1000).toFixed(1) + ' / ' + (total / 1000).toFixed(1) + ' 公里 · ' + Math.round(v * 3.6) + ' km/h');
      s += v;
      if (s >= total) { banner('已到達'); return; }
      setTimeout(step, 1000);
    };
    step();
  }
  // 先顯示「開始」按鈕：瀏覽器規定網頁要先被點一下才能出聲音，點了語音播報、提示音才會有(主程式會在這次點擊時解鎖音訊)
  function ready() {
    var btn = document.createElement('button');
    btn.textContent = '▶ 開始示範導航(台北 → 台中)';
    btn.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:99999;border:0;border-radius:999px;padding:16px 26px;background:#16E098;color:#003B26;font:700 17px -apple-system,"PingFang TC",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer';
    btn.onclick = function () { btn.remove(); start(); };
    document.body.appendChild(btn);
  }
  if (document.readyState === 'complete') ready(); else window.addEventListener('load', ready);
})();
