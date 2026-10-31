// 大更新的新功能(都只存在這支手機的 localStorage，不會上傳)：
//   1. 地圖圖層開關：自己選地圖上要顯示哪些圖示
//   2. 首頁下方卡片：沒導航時改成「回家 / 上班 / 我的車」快捷鍵
//   3. 記住停車位置：一鍵記下，之後可以導航回去
//   4. 導航中分享到達時間
//   5. 自動夜間地圖：日落後自動換夜間、日出換回來(預設關閉)
(function () {
  function load(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } }
  function save(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function toast(t) { var d = el('div', 'coinToast', t); document.body.appendChild(d); setTimeout(function () { d.remove(); }, 2400); }

  var css = document.createElement('style');
  css.textContent =
    '.fxMask{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.25);display:flex;align-items:flex-end;justify-content:center}' +
    '.fxSheet{width:100%;max-width:520px;max-height:78vh;overflow-y:auto;box-sizing:border-box;padding:10px 18px calc(18px + env(safe-area-inset-bottom));' +
      'background:rgba(255,255,255,.92);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);border-radius:22px 22px 0 0;box-shadow:0 -4px 20px rgba(0,0,0,.2);color:#000}' +
    '.fxGrab{width:40px;height:5px;border-radius:3px;background:#c7c7cc;margin:0 auto 10px}' +
    '.fxHead{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}' +
    '.fxTitle{font-size:18px;font-weight:800}' +
    '.fxX{border:none;background:rgba(0,0,0,.06);border-radius:50%;width:32px;height:32px;font-size:15px;cursor:pointer;color:#000}' +
    '.fxSub{font-size:13px;color:#555;margin:0 0 12px;line-height:1.5}' +
    '.fxGroup{font-size:12px;font-weight:700;color:#888;margin:14px 0 6px}' +
    '.fxRow{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:.5px solid #e5e5ea;font-size:15px;cursor:pointer}' +
    '.fxSw{position:relative;width:46px;height:28px;border-radius:14px;background:#d1d1d6;transition:background .2s;flex-shrink:0}' +
    '.fxSw:after{content:"";position:absolute;left:2px;top:2px;width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .2s}' +
    '.fxRow.on .fxSw{background:#34C759}.fxRow.on .fxSw:after{transform:translateX(18px)}' +
    '.fxBtns{display:flex;gap:8px;margin-top:6px}' +
    '.fxBtn{flex:1;border:1px solid #DADCE0;background:#fff;color:#000;border-radius:999px;padding:11px 8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}' +
    '.fxBtn.main{background:#2F80FF;border-color:#2F80FF;color:#fff}' +
    // 首頁快捷鍵：沒導航時取代「退出 / 0小時0分鐘 / 全覽」
    '#idleQuick{display:none;gap:8px;padding:0 14px;flex-shrink:0}' +
    'body:not(.navigating) #idleQuick{display:flex}' +
    'body:not(.navigating) .rect1NavRow{display:none}' +
    '.idleBtn{flex:1;min-width:0;height:44px;border:.5px solid #d9d9d9;border-radius:999px;background:rgba(255,255,255,.75);color:#000;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:5px;white-space:nowrap}' +
    '.idleBtn:active{background:rgba(230,230,230,.9)}' +
    '.fxParkMark{width:32px;height:32px;border-radius:9px;background:#2F80FF;color:#fff;font:800 19px/32px Arial,sans-serif;text-align:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35);cursor:pointer}';
  document.head.appendChild(css);

  function sheet(title, sub) {
    var mask = el('div', 'fxMask'), s = el('div', 'fxSheet'), head = el('div', 'fxHead'), x = el('button', 'fxX', '✕');
    var close = function () { mask.remove(); };
    x.type = 'button'; x.onclick = close;
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    head.appendChild(el('div', 'fxTitle', title)); head.appendChild(x);
    s.appendChild(el('div', 'fxGrab')); s.appendChild(head);
    if (sub) s.appendChild(el('div', 'fxSub', sub));
    mask.appendChild(s); document.body.appendChild(mask);
    return { box: s, close: close };
  }
  function switchRow(label, on, onChange) {
    var r = el('div', 'fxRow' + (on ? ' on' : ''));
    r.appendChild(el('span', null, label)); r.appendChild(el('span', 'fxSw'));
    r.setAttribute('role', 'switch'); r.setAttribute('aria-checked', on ? 'true' : 'false');
    r.addEventListener('click', function () {
      var now = !r.classList.contains('on');
      r.classList.toggle('on', now); r.setAttribute('aria-checked', now ? 'true' : 'false');
      onChange(now);
    });
    return r;
  }

  // ═══ 1. 地圖圖層開關 ═══
  var pts = function (k) { return [k + '-points']; };
  var GROUPS = [
    ['便利商店', [['7-ELEVEN', pts('seven')], ['全家', pts('fm')], ['萊爾富', pts('hilife')], ['OK 超商', pts('okmart')]]],
    ['超市／量販', [['全聯', pts('pxmart')], ['美廉社', pts('simplemart')], ['樂家康', pts('lejiakang')], ['萬家福', pts('wanjiafu')], ['小北百貨', pts('showba')]]],
    ['餐飲', [['麥當勞', pts('mcd')], ['八方雲集', pts('bafang')], ['CoCo 都可', pts('coco')]]],
    ['醫療／生活', [['醫院', pts('hospital')], ['大樹藥局', pts('greattree')], ['大學眼鏡', pts('optical')], ['蝦皮店到店', pts('shopee')], ['公共廁所', pts('toilet')]]],
    ['加油／停車／單車', [['中油加油站', pts('cpc')], ['Times', pts('times')], ['嘟嘟房', pts('dodohome')], ['城市車旅', pts('cityparking')], ['新北公有停車場', pts('ntpcpark')], ['YouBike', pts('youbike')]]],
    ['交通', [['測速照相', ['speed-point', 'speed-clusters', 'speed-cluster-count']], ['監視器', ['cctv-point', 'cctv-clusters']], ['紅綠燈路口', ['signal-clusters', 'signal-cluster-count', 'signal-single']]]],
  ];
  var OFF_KEY = 'snm_layers_off';
  var off = load(OFF_KEY, {}); // 名稱 → true：關掉的
  function setVisible(ids, vis) {
    var m = window.map; if (!m) return;
    ids.forEach(function (id) { try { if (m.getLayer(id) && m.getLayoutProperty(id, 'visibility') !== vis) m.setLayoutProperty(id, 'visibility', vis); } catch (_) {} });
  }
  // 圖層會陸續載入、換地圖樣式也會重建：有變動就把關掉的再關一次(只動關掉的，其他程式控制的不碰)
  function applyOff() {
    GROUPS.forEach(function (g) { g[1].forEach(function (it) { if (off[it[0]]) setVisible(it[1], 'none'); }); });
  }
  var applyQueued = false;
  function queueApply() { if (applyQueued) return; applyQueued = true; requestAnimationFrame(function () { applyQueued = false; applyOff(); }); }
  function openLayers() {
    var sh = sheet('地圖上要顯示什麼', '關掉用不到的，地圖會清爽很多。只是不顯示，一樣可以搜尋得到。');
    GROUPS.forEach(function (g) {
      sh.box.appendChild(el('div', 'fxGroup', g[0]));
      g[1].forEach(function (it) {
        sh.box.appendChild(switchRow(it[0], !off[it[0]], function (on) {
          if (on) delete off[it[0]]; else off[it[0]] = true;
          save(OFF_KEY, off);
          setVisible(it[1], on ? 'visible' : 'none');
        }));
      });
    });
    sh.box.appendChild(el('div', 'fxGroup', '地圖'));
    sh.box.appendChild(switchRow('日落後自動換夜間地圖', !!load(NIGHT_KEY, false), function (on) { save(NIGHT_KEY, on); lastNight = null; if (on) nightCheck(); }));
  }

  // ═══ 3. 記住停車位置 ═══
  var PARK_KEY = 'snm_parked', parkMarker = null;
  function drawPark() {
    var p = load(PARK_KEY, null);
    if (parkMarker) { parkMarker.remove(); parkMarker = null; }
    if (!p || !window.map || !window.maplibregl) return;
    var d = el('div', 'fxParkMark', 'P'); d.title = '我的車';
    d.addEventListener('click', function (e) { e.stopPropagation(); openPark(); });
    // 往右上偏一點：人還在車旁時才不會蓋住自己的車
    parkMarker = new maplibregl.Marker({ element: d, offset: [26, -26] }).setLngLat([p.lng, p.lat]).addTo(window.map);
  }
  function fmtWhen(t) {
    var d = new Date(t), now = new Date(), hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    return d.toDateString() === now.toDateString() ? '今天 ' + hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }
  function savePark() {
    var lat = window.currentLat, lng = window.currentLon;
    if (lat == null || lng == null) { toast('還沒定位到目前位置'); return false; }
    save(PARK_KEY, { lat: lat, lng: lng, t: Date.now() });
    drawPark(); toast('已記住停車位置');
    return true;
  }
  function openPark() {
    var p = load(PARK_KEY, null);
    if (!p) { savePark(); return; }
    var sh = sheet('我的車', '停放時間：' + fmtWhen(p.t));
    var btns = el('div', 'fxBtns'), go = el('button', 'fxBtn main', '導航過去'), re = el('button', 'fxBtn', '重新記錄'), del = el('button', 'fxBtn', '清除');
    go.onclick = function () { sh.close(); if (window._navigateToCoord) window._navigateToCoord(p.lat, p.lng, '我的車'); };
    re.onclick = function () { if (savePark()) sh.close(); };
    del.onclick = function () { save(PARK_KEY, null); drawPark(); sh.close(); toast('已清除停車位置'); };
    btns.appendChild(go); btns.appendChild(re); btns.appendChild(del);
    sh.box.appendChild(btns);
    if (window.map) window.map.easeTo({ center: [p.lng, p.lat], duration: 500 });
  }

  // ═══ 2. 首頁快捷鍵 ═══
  function goSaved(storeKey, label, setKey) {
    var p = load(storeKey, null);
    if (p && window._snmRouteBetween) window._snmRouteBetween(null, { lat: p.lat, lon: p.lon, name: label, addr: p.addr || '' });
    else if (window._snmStartSetPlace) window._snmStartSetPlace(setKey);
  }
  function buildIdle() {
    var body = document.querySelector('#rect1 .rect1Body'), row = body && body.querySelector('.rect1NavRow');
    if (!row || document.getElementById('idleQuick')) return;
    var q = el('div'); q.id = 'idleQuick';
    [['🏠 回家', function () { goSaved('snm_home', '住家', 'home'); }],
     ['💼 上班', function () { goSaved('snm_work', '公司', 'work'); }],
     ['🚗 我的車', openPark]].forEach(function (b) {
      var btn = el('button', 'idleBtn', b[0]); btn.type = 'button'; btn.onclick = b[1]; q.appendChild(btn);
    });
    body.insertBefore(q, row);
  }

  // ═══ 4. 分享到達時間 ═══
  var dest = null;
  function wrapDest(name, pick) {
    var f = window[name]; if (typeof f !== 'function') return;
    window[name] = function () { try { dest = pick.apply(null, arguments) || dest; } catch (_) {} return f.apply(this, arguments); };
  }
  function shareEta() {
    var arr = (document.getElementById('arrivalText') || {}).textContent || '';
    var info = ((document.querySelector('#rect1 .info') || {}).textContent || '').replace(/\s+/g, ' ').trim();
    var name = dest && dest.name ? dest.name : '目的地';
    var text = '我正在前往' + name + '，預計 ' + arr.replace('到達', '') + ' 到達(還要 ' + info + ')';
    var c = window._navDestCoord, url = c ? 'https://www.google.com/maps/search/?api=1&query=' + c[1] + ',' + c[0] : undefined;
    if (navigator.share) { navigator.share(url ? { text: text, url: url } : { text: text }).catch(function () {}); return; }
    var full = url ? text + ' ' + url : text;
    if (navigator.clipboard) navigator.clipboard.writeText(full).then(function () { toast('已複製，可以貼給朋友'); }, function () { toast(full); });
    else toast(full);
  }
  function buildShare() {
    var ov = document.getElementById('navOverviewBtn');
    if (!ov || document.getElementById('navShareBtn')) return;
    var b = el('button', 'navOverviewBtn', '分享'); b.id = 'navShareBtn'; b.type = 'button'; b.onclick = shareEta;
    ov.parentNode.insertBefore(b, ov);
  }

  // ═══ 5. 自動夜間地圖 ═══
  var NIGHT_KEY = 'snm_auto_night', lastNight = null;
  // 日出、日落時間(NOAA 簡化算法，誤差幾分鐘內)，回傳當地從午夜起算的分鐘數
  function sunMinutes(lat, lng, d) {
    var rad = Math.PI / 180, start = new Date(d.getFullYear(), 0, 0), n = Math.floor((d - start) / 86400000);
    var g = 2 * Math.PI / 365 * (n - 1);
    var eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    var decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g);
    var ha = Math.acos(Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) - Math.tan(lat * rad) * Math.tan(decl)) / rad;
    var tz = -d.getTimezoneOffset();
    return { rise: 720 - 4 * (lng + ha) - eq + tz, set: 720 - 4 * (lng - ha) - eq + tz };
  }
  window._snmSunMinutes = sunMinutes;
  function nightCheck(when) {
    if (!load(NIGHT_KEY, false) || !window._snmSetStyle) return;
    var lat = window.currentLat != null ? window.currentLat : 25, lng = window.currentLon != null ? window.currentLon : 121.5;
    var now = when instanceof Date ? when : new Date(), s = sunMinutes(lat, lng, now), m = now.getHours() * 60 + now.getMinutes();
    var night = m < s.rise || m >= s.set;
    if (night === lastNight) return; // 只在日出、日落那一刻換：中間自己手動換過的不會被蓋掉
    lastNight = night;
    window._snmSetStyle(night ? 2 : 0);
  }

  // ═══ 啟動 ═══
  function start() {
    var m = window.map;
    if (!m || !window.maplibregl) { setTimeout(start, 300); return; }
    m.on('styledata', queueApply);
    queueApply();
    drawPark();
    setTimeout(nightCheck, 3000);
    setInterval(nightCheck, 60000);
  }
  var lb = document.getElementById('layersBtn');
  if (lb) lb.addEventListener('click', openLayers);
  buildIdle(); buildShare();
  wrapDest('_navigateToCoord', function (lat, lon, name) { return { name: name }; });
  wrapDest('_navigateNow', function (lat, lon, name) { return { name: name }; });
  wrapDest('_snmRouteBetween', function (from, to) { return to && { name: to.name }; });
  start();
  window._snmFeatures = { openLayers: openLayers, openPark: openPark, shareEta: shareEta, nightCheck: nightCheck };
})();
