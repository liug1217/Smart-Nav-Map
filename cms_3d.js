// ===== 🪧 國道電子看板(CMS) 3D 模型 =====
// 資料：後端 /api/cms(高公局即時訊息，代理在 api/cms.js)。只畫國道的看板。
// 造型：兩根立柱＋上下弦桿與斜撐的鋼桁架橫跨道路，桁架上是黑底 LED 看板(顯示即時訊息)、左邊綠底里程牌、看板上兩盞小燈。
// 看板面向來車：方向用同一條國道、同方向、里程相鄰的看板位置算(南下/東向是里程增加的方向)。
// 省資源：放大到 zoom 15 以上才載入 three.js 與畫模型；只畫畫面附近的看板(最多 40 座)；螢幕關掉不更新。
// 看板上多則訊息時跟實際看板一樣輪流顯示(每 5 秒)。點看板會打開卡片顯示完整訊息。
(function () {
  'use strict';
  var MIN_ZOOM = 15, MAX_SIGNS = 40, PAGE_MS = 5000, REFRESH_MS = 5 * 60 * 1000;
  var THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  var LAYER = 'snm-cms-3d', HIT_SRC = 'snm-cms-src', HIT_LAYER = 'cms-hit';
  var signs = [];            // [{ id, road, dir, mile, m, lon, lat, bearing, pages:[{text,type}] }]
  var loadedAt = 0, loading = false, threeState = 'none';   // none / loading / ready / failed
  var visible = [];          // 目前畫出來的看板
  var models = {};           // id → { scene, board(mesh), page, pageAt, matrix }
  var renderer = null, camera = null;
  var pageTimer = null;

  function apiBase() { return window._snmApiBase || 'https://node.tailfdfee1.ts.net/api'; }
  var mileM = function (s) { var m = String(s).match(/(\d+)K\+(\d+)/i); return m ? (+m[1]) * 1000 + (+m[2]) : null; };

  // ── 資料：抓看板、算每座看板面向哪裡 ──
  function loadSigns() {
    if (loading || document.hidden) return;
    if (signs.length && Date.now() - loadedAt < REFRESH_MS) return;
    loading = true;
    fetch(apiBase() + '/cms').then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok) return;
      var items = (j.data.items || []).filter(function (x) {
        return /^國道/.test(x.road || '') && /^[NSEW]$/.test(x.direction) && x.lon && x.lat && mileM(x.mile) != null;
      });
      var list = items.map(function (x) {
        return { id: x.id, road: x.road, dir: x.direction, mile: x.mile, m: mileM(x.mile), lon: x.lon, lat: x.lat, section: x.section || '',
          pages: (x.messages || []).map(function (g) { return { text: cleanText(g.text), type: String(g.type || '') }; }).filter(function (g) { return g.text; }) };
      }).filter(function (s) { return s.pages.length; });
      // 方向：同路同向依里程排，前一座/後一座的位置
      var groups = {};
      list.forEach(function (s) { (groups[s.road + '|' + s.dir] = groups[s.road + '|' + s.dir] || []).push(s); });
      Object.keys(groups).forEach(function (k) {
        var g = groups[k].sort(function (a, b) { return a.m - b.m; });
        g.forEach(function (s, i) {
          var up = s.dir === 'S' || s.dir === 'E';
          var ahead = up ? g[i + 1] : g[i - 1], behind = up ? g[i - 1] : g[i + 1];
          var b = null;
          if (ahead && dist(s, ahead) > 30) b = brg(s, ahead); else if (behind && dist(behind, s) > 30) b = brg(behind, s);
          s.bearing = b == null ? ({ N: 0, E: 90, S: 180, W: 270 })[s.dir] : b;
        });
      });
      // 同一個位置有兩座(例如高架、平面各一)：第二座往行車方向挪 25 公尺，不要疊在一起
      list.forEach(function (s, i) {
        for (var k = 0; k < i; k++) if (dist(s, list[k]) < 5) {
          var r = s.bearing * Math.PI / 180;
          s.lat += 25 * Math.cos(r) / 110540; s.lon += 25 * Math.sin(r) / (111320 * Math.cos(s.lat * Math.PI / 180));
          break;
        }
      });
      signs = list; loadedAt = Date.now();
      updateHitSource(); refreshVisible();
    }).catch(function () {}).then(function () { loading = false; });
  }
  function cleanText(t) {
    return String(t || '').replace(/\(圖\)/g, '').replace(/\(至\)/g, '至').replace(/[\s　]+/g, ' ').trim();
  }
  function dist(a, b) { var kx = 111320 * Math.cos(a.lat * Math.PI / 180); return Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * 110540); }
  function brg(a, b) { return (Math.atan2((b.lon - a.lon) * Math.cos(a.lat * Math.PI / 180), b.lat - a.lat) * 180 / Math.PI + 360) % 360; }

  // ── LED 看板面：黑底、點陣字(一格一格的 LED)，事故紅、公告黃、行車時間綠 ──
  var RED_WORDS = /事故|封閉|施工|壅塞|車禍|管制|散落|故障|危險|注意|慢行|追撞|落石|火警/;
  function pageColor(p) {
    if (p.type === '7' || RED_WORDS.test(p.text)) return '#FF3B2F';
    if (p.type === '6' || /雨|霧|風|減速|限速/.test(p.text)) return '#FFB31A';
    return '#3CFF52';
  }
  function splitLines(t) {
    var a = Array.from(t);
    if (a.length <= 10) return [t];
    var n = Math.ceil(a.length / 2);
    return [a.slice(0, n).join(''), a.slice(n, Math.min(a.length, n * 2)).join('')];
  }
  function boardCanvas(p) {
    var W = 512, H = 160, c = document.createElement('canvas'); c.width = W; c.height = H;
    var x = c.getContext('2d');
    x.fillStyle = '#0B0B0D'; x.fillRect(0, 0, W, H);
    var lines = splitLines(p.text), col = pageColor(p);
    var fs = lines.length > 1 ? 62 : 74;
    x.font = '700 ' + fs + 'px "PingFang TC","Microsoft JhengHei","Noto Sans TC",sans-serif';
    var widest = Math.max.apply(null, lines.map(function (l) { return x.measureText(l).width; }));
    if (widest > W - 24) { fs = Math.floor(fs * (W - 24) / widest); x.font = '700 ' + fs + 'px "PingFang TC","Microsoft JhengHei","Noto Sans TC",sans-serif'; }
    x.fillStyle = col; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.shadowColor = col; x.shadowBlur = 8;   // LED 發光
    lines.forEach(function (l, i) { x.fillText(l, W / 2, lines.length > 1 ? H * (0.29 + i * 0.44) : H / 2); });
    x.shadowBlur = 0;
    // 點陣：每 4px 一格，格線塗黑，看起來像一顆顆 LED
    x.fillStyle = 'rgba(0,0,0,0.55)';
    for (var gx = 0; gx < W; gx += 4) x.fillRect(gx, 0, 1, H);
    for (var gy = 0; gy < H; gy += 4) x.fillRect(0, gy, W, 1);
    return c;
  }
  function mileCanvas(s) {
    var c = document.createElement('canvas'); c.width = 192; c.height = 64;
    var x = c.getContext('2d');
    x.fillStyle = '#0A7A3E'; x.fillRect(0, 0, 192, 64);
    x.strokeStyle = '#FFFFFF'; x.lineWidth = 4; x.strokeRect(4, 4, 184, 56);
    var t = (s.m / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    x.fillStyle = '#FFFFFF'; x.font = '700 38px Arial,sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(t, 96, 34);
    return c;
  }

  // ── 3D 模型(公尺；+x 往右、+y 往上、看板正面朝 +z，之後轉到面向來車) ──
  function buildModel(s) {
    var T = window.THREE, g = new T.Group();
    var steel = new T.MeshLambertMaterial({ color: 0xA7AEB5 }), dark = new T.MeshLambertMaterial({ color: 0x2A2D31 });
    var box = function (w, h, d, mat, x, y, z) { var m = new T.Mesh(new T.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); g.add(m); return m; };
    var SPAN = 11, H = 7;   // 國道單向 3 線道＋路肩約 20 公尺，門架跨 22 公尺
    [-SPAN, SPAN].forEach(function (px) {
      box(0.45, H + 1.2, 0.45, steel, px, (H + 1.2) / 2, 0);      // 立柱
      box(0.9, 0.25, 0.9, steel, px, 0.12, 0);                     // 柱腳
    });
    // 桁架：上下弦桿＋前後兩片＋斜撐
    [-0.35, 0.35].forEach(function (z) {
      box(SPAN * 2 + 0.6, 0.14, 0.14, steel, 0, H, z);
      box(SPAN * 2 + 0.6, 0.14, 0.14, steel, 0, H + 1.0, z);
      for (var i = -SPAN; i < SPAN; i += 1.2) {
        var d = new T.Mesh(new T.BoxGeometry(0.08, 1.4, 0.08), steel);
        d.position.set(i + 0.6, H + 0.5, z); d.rotation.z = (Math.round((i + SPAN) / 1.2) % 2 ? 1 : -1) * 0.7; g.add(d);
      }
    });
    // LED 看板：黑色箱體＋正面發光面板(用 MeshBasic，不受光線影響，夜裡也看得清楚)
    var BW = 8, BH = 2.3, BY = H + 1.0 + BH / 2 + 0.15;
    box(BW + 0.3, BH + 0.3, 0.6, dark, 0.8, BY, 0);
    var tex = new T.CanvasTexture(boardCanvas(s.pages[0])); tex.anisotropy = 4;
    var face = new T.Mesh(new T.PlaneGeometry(BW, BH), new T.MeshBasicMaterial({ map: tex }));
    face.position.set(0.8, BY, 0.31); g.add(face);
    // 看板上方兩盞小燈
    [-BW / 2 + 1.2, BW / 2 - 1.2].forEach(function (lx) { box(0.5, 0.4, 0.4, dark, 0.8 + lx, BY + BH / 2 + 0.45, 0.05); });
    // 左邊綠底里程牌
    var mt = new T.CanvasTexture(mileCanvas(s));
    var mile = new T.Mesh(new T.PlaneGeometry(2.4, 0.8), new T.MeshBasicMaterial({ map: mt }));
    mile.position.set(-5.4, H + 0.5, 0.45); g.add(mile);
    box(2.5, 0.9, 0.08, dark, -5.4, H + 0.5, 0.4);
    g.rotation.y = -s.bearing * Math.PI / 180;   // 正面(+z)轉到面向來車
    var scene = new T.Scene();
    scene.add(new T.AmbientLight(0xffffff, 0.75));
    var sun = new T.DirectionalLight(0xffffff, 0.55); sun.position.set(0.4, 1, 0.6); scene.add(sun);
    scene.add(g);
    return { scene: scene, face: face, tex: tex, page: 0 };
  }

  // ── MapLibre 自訂圖層：每座看板一個模型，用地圖的投影矩陣畫 ──
  var customLayer = {
    id: LAYER, type: 'custom', renderingMode: '3d',
    onAdd: function (map, gl) {
      var T = window.THREE;
      camera = new T.Camera();
      renderer = new T.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    render: function (gl, matrix) {
      if (!renderer || !visible.length || window.map.getZoom() < MIN_ZOOM) return;
      var T = window.THREE, mapM = new T.Matrix4().fromArray(matrix);
      visible.forEach(function (s) {
        var md = models[s.id];
        if (!md) return;
        camera.projectionMatrix = mapM.clone().multiply(md.matrix);
        renderer.resetState();
        renderer.render(md.scene, camera);
      });
    }
  };
  function modelMatrix(s) {
    var T = window.THREE, mc = maplibregl.MercatorCoordinate.fromLngLat([s.lon, s.lat], 0), sc = mc.meterInMercatorCoordinateUnits();
    return new T.Matrix4().makeTranslation(mc.x, mc.y, mc.z).scale(new T.Vector3(sc, -sc, sc)).multiply(new T.Matrix4().makeRotationAxis(new T.Vector3(1, 0, 0), Math.PI / 2));
  }

  // 只畫畫面附近的看板(依離畫面中心的距離取最近的 MAX_SIGNS 座)
  function refreshVisible() {
    var m = window.map;
    if (!m || threeState !== 'ready' || m.getZoom() < MIN_ZOOM || !signs.length) { visible = []; m && m.triggerRepaint(); return; }
    var b = m.getBounds(), padLon = (b.getEast() - b.getWest()) * 0.3, padLat = (b.getNorth() - b.getSouth()) * 0.3, c = m.getCenter();
    var near = signs.filter(function (s) {
      return s.lon > b.getWest() - padLon && s.lon < b.getEast() + padLon && s.lat > b.getSouth() - padLat && s.lat < b.getNorth() + padLat;
    }).sort(function (a, b2) { return dist(a, { lon: c.lng, lat: c.lat }) - dist(b2, { lon: c.lng, lat: c.lat }); }).slice(0, MAX_SIGNS);
    near.forEach(function (s) {
      var md = models[s.id];
      if (!md || md.key !== s.pages.map(function (p) { return p.text; }).join('|')) {   // 新看板或訊息換了才重建
        if (md) disposeModel(md);
        md = models[s.id] = buildModel(s);
        md.key = s.pages.map(function (p) { return p.text; }).join('|');
        md.sign = s;
      }
      md.matrix = modelMatrix(s);
    });
    // 離開畫面很久的模型釋放掉(超過 120 座就清)
    var ids = Object.keys(models);
    if (ids.length > 120) ids.forEach(function (id) { if (!near.some(function (s) { return s.id === id; })) { disposeModel(models[id]); delete models[id]; } });
    visible = near;
    m.triggerRepaint();
  }
  function disposeModel(md) {
    md.scene.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
  }
  // 多則訊息輪流顯示(只換畫面上的看板)
  function rotatePages() {
    if (document.hidden || !visible.length) return;
    var changed = false;
    visible.forEach(function (s) {
      var md = models[s.id];
      if (!md || s.pages.length < 2) return;
      md.page = (md.page + 1) % s.pages.length;
      md.tex.image = boardCanvas(s.pages[md.page]); md.tex.needsUpdate = true; changed = true;
    });
    if (changed) window.map.triggerRepaint();
  }

  // ── 點看板：用看不見的圓點接點擊，打開卡片 ──
  function updateHitSource() {
    var m = window.map;
    if (!m) return;
    var data = { type: 'FeatureCollection', features: signs.map(function (s) {
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: { id: s.id, name: s.road + ' ' + s.mile } };
    }) };
    if (m.getSource(HIT_SRC)) { m.getSource(HIT_SRC).setData(data); return; }
    m.addSource(HIT_SRC, { type: 'geojson', data: data });
    m.addLayer({ id: HIT_LAYER, type: 'circle', source: HIT_SRC, minzoom: MIN_ZOOM, paint: { 'circle-radius': 22, 'circle-opacity': 0 } });
  }
  var DIR_NAME = { N: '北上', S: '南下', E: '東向', W: '西向' };
  function bindClick(m) {
    if (m._snmCmsClickBound) return;
    m._snmCmsClickBound = true;
    m.on('click', HIT_LAYER, function (e) {
      var id = e.features && e.features[0] && e.features[0].properties.id, s = signs.find(function (x) { return x.id === id; });
      if (!s || !window._snmOpenPlace) return;
      var md = models[s.id], logo = boardCanvas(s.pages[md ? md.page : 0]).toDataURL('image/png');
      window._snmOpenPlace({ layer: HIT_LAYER, name: s.road + ' ' + DIR_NAME[s.dir] + ' ' + (s.m / 1000).toFixed(1) + 'K 電子看板',
        kind: '即時訊息' + (s.section ? ' · ' + s.section : ''), logo: logo, logoShape: 'bare', lat: s.lat, lng: s.lon,
        info: s.pages.map(function (p) { return p.text; }), noReport: true });
    });
    m.on('mouseenter', HIT_LAYER, function () { m.getCanvas().style.cursor = 'pointer'; });
    m.on('mouseleave', HIT_LAYER, function () { m.getCanvas().style.cursor = ''; });
  }

  // ── 載入 three.js、加圖層 ──
  function ensureThree(cb) {
    if (window.THREE) { threeState = 'ready'; cb(); return; }
    if (threeState === 'loading' || threeState === 'failed') return;
    threeState = 'loading';
    var sc = document.createElement('script'); sc.src = THREE_URL;
    sc.onload = function () { threeState = window.THREE ? 'ready' : 'failed'; if (window.THREE) cb(); };
    sc.onerror = function () { threeState = 'failed'; };
    document.head.appendChild(sc);
  }
  function addLayer() {
    var m = window.map;
    if (!m || !window.THREE || m.getLayer(LAYER)) return;
    var before = m.getLayer('user-car') ? 'user-car' : undefined;
    m.addLayer(customLayer, before);
    if (signs.length) updateHitSource();
    bindClick(m);
  }
  function check() {
    var m = window.map;
    if (!m || m.getZoom() < MIN_ZOOM) { if (visible.length) refreshVisible(); return; }
    loadSigns();
    ensureThree(function () { addLayer(); refreshVisible(); });
    if (threeState === 'ready') { addLayer(); refreshVisible(); }
  }
  // 換地圖樣式後圖層會被清掉，重加
  window._snmReloadCms3d = function () {
    renderer = null; models = {}; visible = [];
    if (window.THREE && window.map && window.map.getZoom() >= MIN_ZOOM) { addLayer(); if (signs.length) updateHitSource(); refreshVisible(); }
  };
  function init() {
    var m = window.map;
    if (!m) { setTimeout(init, 500); return; }
    var go = function () { m.on('moveend', check); check(); };
    if (m.loaded()) go(); else m.once('load', go);
    pageTimer = setInterval(rotatePages, PAGE_MS);
    setInterval(function () { if (!document.hidden && window.map && window.map.getZoom() >= MIN_ZOOM) loadSigns(); }, REFRESH_MS);
  }
  init();
})();
