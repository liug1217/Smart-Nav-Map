// ===== 📹 監視器、測速照相 3D 模型 =====
// 放大到 zoom 16 以上，把監視器(國道、省道 CCTV)、測速照相改成立體模型(測速照相旁邊的警告標誌不做)：
//   監視器：灰色鋼柱(7.5 公尺)＋伸向車道的橫桿＋白色攝影機(往下斜、朝來車)
//   測速照相：灰色鋼柱(5.5 公尺)＋短橫桿＋測速機箱(深色玻璃面朝來車)＋閃光燈
// 位置：在國道、快速道路旁邊的照 3D 路面(road_3d.js 的 _snmRoad3dAt)立在路肩外側(在路的左邊就立在中央分隔上)，
//       高度照路面(高架上的也在橋面上)；一般道路的照原本的位置、方向照最近的道路
// 資料：直接用地圖上監視器(cctv)、測速照相(speed-cam)圖層的資料；地圖上的平面圖示放大後變透明(點下去照樣打開卡片)，
//       點 3D 模型也會打開同一張卡片
// 省資源：只畫畫面附近最多 60 個
(function () {
  'use strict';
  var MIN_ZOOM = 16, MAX_MODELS = 60;
  var LAYER = 'snm-cams-3d', HIT_SRC = 'snm-cams-hit', HIT_LAYER = 'cams-hit';
  var SOURCES = [{ id: 'cctv', kind: 'cctv', icon: 'cctv-point' }, { id: 'speed-cam', kind: 'speed', icon: 'speed-point' }];
  var renderer = null, camera = null, visible = [], models = {}, timer = null, roadLines = null, placed = {}, roadGen = 0;

  var KX = function (lat) { return 111320 * Math.cos(lat * Math.PI / 180); }, KY = 110540;
  function dist(a, b) { return Math.hypot((b[0] - a[0]) * KX(a[1]), (b[1] - a[1]) * KY); }

  // ── 擺放位置 ──
  // 回傳 { lon, lat, h, bearing(行車方向), arm(1 = 橫桿往右伸 / -1 往左) }
  function placeOf(p, kind) {
    var a = window._snmRoad3dAt ? window._snmRoad3dAt(p[0], p[1], 30) : null;
    if (a) {
      var right = a.side >= 0 || kind === 'speed';   // 測速照相都立在右邊路肩外
      var off = right ? a.half + 0.8 : (a.oneway && !a.link ? a.nhalf - 0.35 : a.nhalf - 0.8);
      var b = a.bearing * Math.PI / 180, rx = Math.cos(b), ry = -Math.sin(b);   // 行車方向的右邊(東、北)
      return { lon: a.lon + rx * off / KX(a.lat0), lat: a.lat0 + ry * off / KY, h: a.h, bearing: a.bearing, arm: right ? -1 : 1 };
    }
    // 一般道路：方向照最近的道路線(底圖 transportation)，橫桿伸向那條路
    var best = nearestRoad(p);
    if (best) return { lon: p[0], lat: p[1], h: 0, bearing: best.bearing, arm: best.side >= 0 ? -1 : 1 };
    return { lon: p[0], lat: p[1], h: 0, bearing: 0, arm: -1 };
  }
  function nearestRoad(p) {
    var m = window.map;
    if (!roadLines) {
      roadLines = [];
      try {
        (m.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation' }) || []).forEach(function (f) {
          var g = f.geometry; (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []).forEach(function (c) { if (c.length > 1) roadLines.push(c); });
        });
      } catch (e) { roadLines = []; }
    }
    var kx = KX(p[1]), best = null;
    roadLines.forEach(function (c) {
      for (var i = 0; i < c.length - 1; i++) {
        var ax = (c[i][0] - p[0]) * kx, ay = (c[i][1] - p[1]) * KY, bx = (c[i + 1][0] - p[0]) * kx, by = (c[i + 1][1] - p[1]) * KY;
        var dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        if (!L2) continue;
        var t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)), d = Math.hypot(ax + t * dx, ay + t * dy);
        if (d > 30 || (best && d >= best.d)) continue;
        // 這點在線的哪一邊：(點 - 線上的點) · 右手方向
        var L = Math.sqrt(L2), side = (-(ax + t * dx)) * (dy / L) + (-(ay + t * dy)) * (-dx / L);
        best = { d: d, bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360, side: side };
      }
    });
    return best;
  }

  // ── 3D 模型(公尺；+x 往東、+y 往上、+z 往南；行車方向朝北時：+x = 右邊、+z = 來車那邊) ──
  function buildModel(kind, arm) {
    var T = window.THREE, g = new T.Group();
    var steel = new T.MeshPhongMaterial({ color: 0xB9BFC5, specular: 0x8A8F94, shininess: 60 });
    var white = new T.MeshPhongMaterial({ color: 0xF2F3F4, specular: 0x666666, shininess: 40 });
    var dark = new T.MeshPhongMaterial({ color: 0x1D2125, specular: 0x444444, shininess: 80 });
    var grey = new T.MeshPhongMaterial({ color: 0x9EA4AA, specular: 0x555555, shininess: 30 });
    var cyl = function (r, h, mat, x, y, z) { var m = new T.Mesh(new T.CylinderGeometry(r, r, h, 12), mat); m.position.set(x, y, z); g.add(m); return m; };
    var box = function (w, h, d, mat, x, y, z) { var m = new T.Mesh(new T.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); g.add(m); return m; };
    var hbar = function (len, r, y) { var m = new T.Mesh(new T.CylinderGeometry(r, r, len, 10), steel); m.rotation.z = Math.PI / 2; m.position.set(arm * len / 2, y, 0); g.add(m); };
    if (kind === 'cctv') {
      var H = 7.5, A = 2.2;
      cyl(0.12, H, steel, 0, H / 2, 0);                                  // 鋼柱
      cyl(0.25, 0.2, steel, 0, 0.1, 0);                                  // 柱腳
      hbar(A, 0.06, H - 0.2);                                            // 橫桿(伸向車道)
      var head = new T.Group(); head.position.set(arm * A, H - 0.55, 0); head.rotation.x = 0.28; g.add(head);   // 攝影機往下斜、朝來車
      var body = new T.Mesh(new T.BoxGeometry(0.26, 0.26, 0.6), white); head.add(body);
      var hood = new T.Mesh(new T.BoxGeometry(0.32, 0.04, 0.68), white); hood.position.set(0, 0.16, 0.03); head.add(hood);   // 遮陽罩
      var lens = new T.Mesh(new T.CylinderGeometry(0.08, 0.08, 0.04, 16), dark); lens.rotation.x = Math.PI / 2; lens.position.set(0, 0, 0.31); head.add(lens);
      box(0.05, 0.35, 0.05, steel, arm * A, H - 0.3, 0);                 // 吊架
    } else {
      var H2 = 5.5, A2 = 0.9;
      cyl(0.1, H2, grey, 0, H2 / 2, 0);                                  // 鋼柱
      cyl(0.22, 0.2, grey, 0, 0.1, 0);
      hbar(A2, 0.06, H2 - 0.15);                                         // 短橫桿
      box(0.6, 0.46, 0.5, grey, arm * (A2 + 0.1), H2 - 0.45, 0);        // 測速機箱
      box(0.46, 0.3, 0.02, dark, arm * (A2 + 0.1), H2 - 0.45, 0.26);    // 深色玻璃面(朝來車)
      box(0.18, 0.18, 0.2, white, arm * (A2 + 0.1) - arm * 0.45, H2 - 0.42, 0.12);   // 閃光燈
    }
    var scene = new T.Scene();
    scene.add(new T.AmbientLight(0xffffff, 0.6));
    var sun = new T.DirectionalLight(0xffffff, 0.7); sun.position.set(0.4, 1, 0.6); scene.add(sun);
    var fill = new T.DirectionalLight(0xffffff, 0.25); fill.position.set(-0.6, 0.4, -0.5); scene.add(fill);
    g.traverse(function (o) { o.frustumCulled = false; });
    scene.add(g);
    return { scene: scene, group: g };
  }
  function modelMatrix(pl) {
    var T = window.THREE, mc = maplibregl.MercatorCoordinate.fromLngLat([pl.lon, pl.lat], pl.h), sc = mc.meterInMercatorCoordinateUnits();
    return new T.Matrix4().makeTranslation(mc.x, mc.y, mc.z).scale(new T.Vector3(sc, -sc, sc)).multiply(new T.Matrix4().makeRotationAxis(new T.Vector3(1, 0, 0), Math.PI / 2));
  }

  // ── 自訂圖層 ──
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
      visible.forEach(function (v) {
        var md = models[v.key];
        if (!md) return;
        camera.projectionMatrix = mapM.clone().multiply(md.matrix);
        renderer.resetState();
        renderer.render(md.scene, camera);
      });
    }
  };

  // 畫面附近的監視器、測速照相
  function refresh() {
    var m = window.map;
    if (!m || !window.THREE) return;
    if (m.getZoom() < MIN_ZOOM) { if (visible.length) { visible = []; m.triggerRepaint(); } return; }
    if (!m.getLayer(LAYER)) m.addLayer(customLayer, m.getLayer('user-car') ? 'user-car' : undefined);
    fadeIcons();
    roadLines = null;   // 只有要算新的位置時才會用到(nearestRoad 第一次用才抓)
    var b = m.getBounds(), c = m.getCenter(), padX = (b.getEast() - b.getWest()) * 0.2, padY = (b.getNorth() - b.getSouth()) * 0.2, list = [];
    SOURCES.forEach(function (s) {
      var src = m.getSource(s.id), d = src && src._data;
      if (!d || !d.features) return;
      d.features.forEach(function (f, i) {
        var p = f.geometry && f.geometry.coordinates;
        if (!p || f.properties && f.properties.cluster) return;
        if (p[0] < b.getWest() - padX || p[0] > b.getEast() + padX || p[1] < b.getSouth() - padY || p[1] > b.getNorth() + padY) return;
        list.push({ key: s.kind + ':' + i + ':' + p[0].toFixed(6) + ',' + p[1].toFixed(6), kind: s.kind, p: p, icon: s.icon });
      });
    });
    list.sort(function (x, y) { return dist(x.p, [c.lng, c.lat]) - dist(y.p, [c.lng, c.lat]); });
    visible = list.slice(0, MAX_MODELS);
    visible.forEach(function (v) {
      // 位置算過就記住(監視器、測速照相不會動)；3D 路面剛載入時再重算一次
      var pl = placed[v.key] && placed[v.key].gen === roadGen ? placed[v.key] : (placed[v.key] = Object.assign(placeOf(v.p, v.kind), { gen: roadGen })), md = models[v.key];
      if (!md || md.arm !== pl.arm) { if (md) dispose(md); md = models[v.key] = buildModel(v.kind, pl.arm); md.arm = pl.arm; }
      md.group.rotation.y = -pl.bearing * Math.PI / 180;
      md.matrix = modelMatrix(pl);
      v.pl = pl;
    });
    var keys = Object.keys(models);
    if (keys.length > 200) keys.forEach(function (k) { if (!visible.some(function (v) { return v.key === k; })) { dispose(models[k]); delete models[k]; } });
    updateHit();
    m.triggerRepaint();
  }
  function dispose(md) { md.scene.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); }
  // 平面圖示：放大到 3D 出現時變透明(點下去照樣打開卡片)
  function fadeIcons() {
    var m = window.map;
    SOURCES.forEach(function (s) {
      if (!m.getLayer(s.icon) || m.getLayer(s.icon)._snm3d) return;
      var cur = m.getPaintProperty(s.icon, 'icon-opacity');
      m.setPaintProperty(s.icon, 'icon-opacity', ['step', ['zoom'], typeof cur === 'number' ? cur : 1, MIN_ZOOM, 0]);
      m.getLayer(s.icon)._snm3d = true;
    });
  }
  // 點 3D 模型：看不見的圓點接點擊，轉給原本的圖示(打開同一張卡片)
  function updateHit() {
    var m = window.map, data = { type: 'FeatureCollection', features: visible.filter(function (v) { return v.pl; }).map(function (v) {
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [v.pl.lon, v.pl.lat] }, properties: { lon: v.p[0], lat: v.p[1], h: v.pl.h } };
    }) };
    if (m.getSource(HIT_SRC)) { m.getSource(HIT_SRC).setData(data); return; }
    m.addSource(HIT_SRC, { type: 'geojson', data: data });
    m.addLayer({ id: HIT_LAYER, type: 'circle', source: HIT_SRC, minzoom: MIN_ZOOM, paint: { 'circle-radius': 18, 'circle-opacity': 0 } });
    if (m._snmCamsClickBound) return;
    m._snmCamsClickBound = true;
    m.on('click', HIT_LAYER, function (e) {
      var f = e.features && e.features[0];
      if (!f) return;
      var ll = [f.properties.lon, f.properties.lat];
      m.fire('click', { point: m.project(ll), lngLat: { lng: ll[0], lat: ll[1] }, originalEvent: e.originalEvent });
    });
    m.on('mouseenter', HIT_LAYER, function () { m.getCanvas().style.cursor = 'pointer'; });
    m.on('mouseleave', HIT_LAYER, function () { m.getCanvas().style.cursor = ''; });
  }

  function soon() { clearTimeout(timer); timer = setTimeout(refresh, 250); }
  window._snmReloadCams3d = function () { renderer = null; models = {}; visible = []; soon(); };   // 換地圖樣式後重加
  function init() {
    var m = window.map;
    if (!m) { setTimeout(init, 500); return; }
    var lastMove = 0;
    var go = function () { m.on('moveend', soon); m.on('move', function () { var now = Date.now(); if (now - lastMove > 1500) { lastMove = now; soon(); } }); soon(); };   // 導航時鏡頭一直在動：移動中也更新
    if (m.loaded()) go(); else m.once('load', go);
    window.addEventListener('snm-road3d-data', function () { roadGen++; soon(); });   // 3D 路面載入後照路面重新擺
    // three.js 由 road_3d.js 載入；還沒好就等一下
    var wait = setInterval(function () { if (window.THREE) { clearInterval(wait); soon(); } }, 500);
  }
  init();
})();
