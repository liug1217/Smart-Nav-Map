// ===== 🪧 國道電子看板(CMS) 3D 模型 =====
// 資料：後端 /api/cms(高公局即時訊息，代理在 api/cms.js)。只畫國道的看板。
// 造型：兩根立柱＋上下弦桿與斜撐的鋼桁架橫跨道路，桁架上是黑底 LED 看板(顯示即時訊息)、左邊綠底里程牌、看板上兩盞小燈。
// 看板面向來車：方向用同一條國道、同方向、里程相鄰的看板位置算(南下/東向是里程增加的方向)。
// 省資源：放大到 zoom 15 以上才載入 three.js 與畫模型；只畫畫面附近的看板(最多 40 座)；螢幕關掉不更新。
// 即時更新：畫面上有看板時每 60 秒重抓，訊息變了的看板馬上換字；切回 App 時也馬上抓一次。
// 看板上多則訊息時跟實際看板一樣輪流顯示(每 5 秒)。點看板會打開卡片顯示完整訊息。
(function () {
  'use strict';
  var MIN_ZOOM = 15, MAX_SIGNS = 40, PAGE_MS = 5000, REFRESH_MS = 60 * 1000;   // 高公局看板訊息每分鐘更新；實際照後端說的下次更新時間(nextUpdateIn)來抓
  var THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  var LAYER = 'snm-cms-3d', HIT_SRC = 'snm-cms-src', HIT_LAYER = 'cms-hit';
  var signs = [];            // [{ id, road, dir, mile, m, lon, lat, bearing, pages:[{text,type}] }]
  var nextAt = 0, refreshTimer = null, loading = false, threeState = 'none';   // none / loading / ready / failed
  var visible = [];          // 目前畫出來的看板
  var models = {};           // id → { scene, board(mesh), page, pageAt, matrix }
  var renderer = null, camera = null;
  var pageTimer = null;

  function apiBase() { return window._snmApiBase || 'https://node.tailfdfee1.ts.net/api'; }
  var mileM = function (s) { var m = String(s).match(/(\d+)K\+(\d+)/i); return m ? (+m[1]) * 1000 + (+m[2]) : null; };

  // ── 資料：抓看板、算每座看板面向哪裡 ──
  function loadSigns() {
    if (loading || document.hidden) return;
    if (signs.length && Date.now() < nextAt) return;   // 上游還沒更新，不用抓(縮放、切回來時也不會重複抓)
    loading = true;
    var wait = 10000;   // 抓失敗：10 秒後再試
    fetch(apiBase() + '/cms').then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok) return;
      wait = (j.data.nextUpdateIn || REFRESH_MS) + Math.random() * 1500;   // 上游一更新就來抓(加一點隨機，大家不要同一毫秒擠進來)
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
      // 已經吸附到車道的位置沿用，不用每分鐘重算
      var old = {}; signs.forEach(function (o) { if (o.snap) old[o.id] = o.snap; });
      list.forEach(function (n) { if (old[n.id]) n.snap = old[n.id]; });
      signs = list;
      updateHitSource(); refreshVisible();
    }).catch(function () {}).then(function () {
      loading = false; nextAt = Date.now() + wait;
      clearTimeout(refreshTimer); refreshTimer = setTimeout(autoLoad, wait);
    });
  }
  // 時間到自動更新：螢幕關著、地圖拉遠就先不抓(切回來 / 拉近時會補抓)
  function autoLoad() {
    if (!document.hidden && window.map && window.map.getZoom() >= MIN_ZOOM) loadSigns();
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
    // 鍍鋅鋼：淺灰、帶一點金屬反光；看板箱體深灰
    var steel = new T.MeshPhongMaterial({ color: 0xC4CACF, specular: 0x8A8F94, shininess: 70 });
    var dark = new T.MeshPhongMaterial({ color: 0x24272B, specular: 0x333333, shininess: 30 });
    var box = function (w, h, d, mat, x, y, z) { var m = new T.Mesh(new T.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); g.add(m); return m; };
    var UP = new T.Vector3(0, 1, 0);
    // 兩點之間的圓管
    var rod = function (a, b, r, mat) {
      var A = new T.Vector3(a[0], a[1], a[2]), B = new T.Vector3(b[0], b[1], b[2]), d = B.clone().sub(A), len = d.length();
      var m = new T.Mesh(new T.CylinderGeometry(r, r, len, 12), mat || steel);
      m.position.copy(A.clone().add(B).multiplyScalar(0.5));
      m.quaternion.setFromUnitVectors(UP, d.normalize());
      g.add(m); return m;
    };
    var SPAN = 11, H = 7, TH = 1.1, TZ = 0.42;   // 國道單向 3 線道＋路肩約 20 公尺，門架跨 22 公尺；桁架高 1.1、厚 0.84
    [-SPAN, SPAN].forEach(function (px) {
      rod([px, 0, 0], [px, H + TH + 0.3, 0], 0.26);                                   // 圓柱立柱
      var base = new T.Mesh(new T.CylinderGeometry(0.5, 0.55, 0.25, 16), steel); base.position.set(px, 0.12, 0); g.add(base);   // 柱腳
      var cap = new T.Mesh(new T.CylinderGeometry(0.3, 0.26, 0.12, 16), steel); cap.position.set(px, H + TH + 0.36, 0); g.add(cap); // 柱頂蓋
    });
    // 桁架：前後兩片，每片上下弦桿＋豎桿＋斜撐(圓管)，前後之間再用橫桿連起來
    var L = SPAN + 0.3, step = 1.1;
    [-TZ, TZ].forEach(function (z) {
      rod([-L, H, z], [L, H, z], 0.085);
      rod([-L, H + TH, z], [L, H + TH, z], 0.085);
      var k = 0;
      for (var x = -SPAN; x < SPAN - 0.01; x += step, k++) {
        rod([x, H, z], [x, H + TH, z], 0.04);                                                    // 豎桿
        rod(k % 2 ? [x, H, z] : [x, H + TH, z], k % 2 ? [x + step, H + TH, z] : [x + step, H, z], 0.04); // 斜撐(左右交錯)
      }
      rod([SPAN, H, z], [SPAN, H + TH, z], 0.04);
    });
    for (var x2 = -SPAN; x2 <= SPAN + 0.01; x2 += step * 2) {
      rod([x2, H, -TZ], [x2, H, TZ], 0.035); rod([x2, H + TH, -TZ], [x2, H + TH, TZ], 0.035);
    }
    // LED 看板：黑色箱體＋正面發光面板(用 MeshBasic，不受光線影響，夜裡也看得清楚)
    var BW = 8, BH = 2.3, BY = H + TH + BH / 2 + 0.15;
    box(BW + 0.3, BH + 0.3, 0.6, dark, 0.8, BY, 0);
    var tex = new T.CanvasTexture(boardCanvas(s.pages[0])); tex.anisotropy = 4;
    var face = new T.Mesh(new T.PlaneGeometry(BW, BH), new T.MeshBasicMaterial({ map: tex }));
    face.position.set(0.8, BY, 0.31); g.add(face);
    // 看板上方兩盞小燈
    [-BW / 2 + 1.2, BW / 2 - 1.2].forEach(function (lx) { box(0.5, 0.4, 0.4, dark, 0.8 + lx, BY + BH / 2 + 0.45, 0.05); });
    // 左邊綠底里程牌
    var mt = new T.CanvasTexture(mileCanvas(s));
    var mile = new T.Mesh(new T.PlaneGeometry(2.4, 0.8), new T.MeshBasicMaterial({ map: mt }));
    mile.position.set(-5.4, H + TH / 2, TZ + 0.12); g.add(mile);
    box(2.5, 0.9, 0.08, dark, -5.4, H + TH / 2, TZ + 0.07);
    g.rotation.y = -signBearing(s) * Math.PI / 180;   // 正面(+z)轉到面向來車
    var scene = new T.Scene();
    scene.add(new T.AmbientLight(0xffffff, 0.6));
    var sun = new T.DirectionalLight(0xffffff, 0.7); sun.position.set(0.4, 1, 0.6); scene.add(sun);
    var fill = new T.DirectionalLight(0xffffff, 0.25); fill.position.set(-0.6, 0.4, -0.5); scene.add(fill);   // 背光面也看得出圓管立體感
    scene.add(g);
    return { scene: scene, group: g, face: face, tex: tex, page: 0 };
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
  function signLon(s) { return s.snap ? s.snap.lon : s.lon; }
  function signLat(s) { return s.snap ? s.snap.lat : s.lat; }
  function signBearing(s) { return s.snap ? s.snap.bearing : s.bearing; }
  // 地圖底圖的國道線(openmaptiles transportation 的 motorway)：找 60 公尺內、行車方向跟看板一致(差 50 度內)、最近的那條，把看板投影上去
  function snapSigns(list) {
    var m = window.map, need = list.filter(function (s) { return !s.snap && (s.snapTries || 0) < 4; });
    if (!need.length || !m.getSource('openmaptiles')) return;
    var feats;
    try { feats = m.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation', filter: ['==', ['get', 'class'], 'motorway'] }); } catch (_) { return; }
    var lines = [];
    feats.forEach(function (f) {
      var g = f.geometry, one = f.properties && f.properties.oneway;
      (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []).forEach(function (c) { if (c.length > 1) lines.push({ c: c, oneway: one }); });
    });
    need.forEach(function (s) {
      s.snapTries = (s.snapTries || 0) + 1;
      var kx = 111320 * Math.cos(s.lat * Math.PI / 180), ky = 110540, best = null;
      lines.forEach(function (ln) {
        var c = ln.c;
        for (var i = 0; i < c.length - 1; i++) {
          var ax = (c[i][0] - s.lon) * kx, ay = (c[i][1] - s.lat) * ky, bx = (c[i + 1][0] - s.lon) * kx, by = (c[i + 1][1] - s.lat) * ky;
          var dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
          if (!L2) continue;
          var t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)), d = Math.hypot(ax + t * dx, ay + t * dy);
          if (d > 60 || (best && d >= best.d)) continue;
          var b = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
          if (ln.oneway === -1) b = (b + 180) % 360;                       // 逆向畫的單行道
          var diff = Math.abs(((b - s.bearing) % 360 + 540) % 360 - 180);
          if (!ln.oneway && diff > 90) { b = (b + 180) % 360; diff = 180 - diff; }   // 雙向一條線：取跟看板同方向
          if (diff > 50) continue;
          best = { d: d, lon: c[i][0] + (c[i + 1][0] - c[i][0]) * t, lat: c[i][1] + (c[i + 1][1] - c[i][1]) * t, bearing: b };
        }
      });
      if (best) s.snap = best;
    });
  }
  function modelMatrix(s) {
    // 門架立在 3D 路面上(高架上的看板跟著抬高；road_3d.js 查路面高度)
    var a = window._snmRoad3dAt ? window._snmRoad3dAt(signLon(s), signLat(s), 30) : null;
    var T = window.THREE, mc = maplibregl.MercatorCoordinate.fromLngLat([signLon(s), signLat(s)], a ? a.h : 0), sc = mc.meterInMercatorCoordinateUnits();
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
    var before = near.filter(function (s) { return !s.snap; }).length;
    snapSigns(near);
    if (near.filter(function (s) { return !s.snap; }).length !== before) updateHitSource();   // 有看板吸附到車道了，點擊位置也跟著移
    near.forEach(function (s) {
      var md = models[s.id];
      if (!md || md.key !== s.pages.map(function (p) { return p.text; }).join('|')) {   // 新看板或訊息換了才重建
        if (md) disposeModel(md);
        md = models[s.id] = buildModel(s);
        md.key = s.pages.map(function (p) { return p.text; }).join('|');
        md.sign = s;
      }
      md.group.rotation.y = -signBearing(s) * Math.PI / 180;   // 吸附到車道後方向可能變了
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
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [signLon(s), signLat(s)] }, properties: { id: s.id, name: s.road + ' ' + s.mile } };
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
        kind: '即時訊息' + (s.section ? ' · ' + s.section : ''), logo: logo, logoShape: 'bare', lat: signLat(s), lng: signLon(s),
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
    document.addEventListener('visibilitychange', autoLoad);
    var refit = null;
    window.addEventListener('snm-road3d-data', function () { clearTimeout(refit); refit = setTimeout(refreshVisible, 200); });   // 3D 路面載入後：門架改立在路面高度
  }
  init();
})();
