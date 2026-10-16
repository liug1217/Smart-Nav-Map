// ===== 🏙 一般道路 3D 路面(省道、縣道、市區道路、巷弄) =====
// 國道、快速道路由 road_3d.js 畫(資料事先算好)；其他所有道路數量太多(全台幾十萬條)，事先算好會變成好幾百 MB，
// 所以直接用地圖本身已經下載的道路資料(openmaptiles transportation)在手機上當場產生，不用多下載東西。
//   路寬照等級：省道 14、縣道 12、市區道路 9、巷弄 6、服務道路 4.5 公尺；
//   單行道(地圖上分成兩條的雙向道路也是一邊一條)：省道 10.5(3 車道)、縣道 7(2 車道)、市區道路 6、巷弄 4、服務道路 3.5
//   標線：省道、縣道中央雙黃線＋車道線＋路邊白線；市區道路中央黃虛線＋路邊白線；巷弄沒有標線；單行道沒有黃線
//   路口：交叉的地方標線讓給等級高的路(同等級兩邊都讓，路口中間沒有標線，跟真的一樣)
//   橋：抬高 1.2 公尺(每層)，兩頭慢慢降回地面，兩側混凝土護欄；隧道不畫
//       跨過國道的橋：查國道 3D 路面高度(window._snmRoad3dHeightAt)，至少高 5.3 公尺(淨空 4.5)，不會穿過國道
// 省資源：放大到 zoom 17 以上才畫、只畫畫面中心附近 700 公尺；中心移動超過 250 公尺或換了地圖圖磚才重建。
// 圖層放在所有路況綠線下面(路況顏色照樣看得到)，國道 3D 路面再蓋在上面。
(function () {
  'use strict';
  var MIN_ZOOM = 17, RADIUS = 700, REBUILD_MOVE = 250;
  var LAYER = 'snm-road-3d-local';
  // 等級：w 路寬(雙向)、w1 路寬(單行)、r 讓路順序(大的優先)、c 中央線(yy 雙黃實線 / yd 黃虛線)、lane 車道寬(畫白虛線)、edge 路邊白線
  var CLS = {
    primary:   { w: 14, w1: 10.5, r: 4, c: 'yy', lane: 3.5, edge: true },
    secondary: { w: 12, w1: 7, r: 3, c: 'yy', lane: 3.5, edge: true },
    tertiary:  { w: 9,  w1: 6, r: 2, c: 'yd', lane: 0, edge: true },
    minor:     { w: 6,  w1: 4, r: 1, c: null, lane: 0, edge: false },
    service:   { w: 4.5, w1: 3.5, r: 0, c: null, lane: 0, edge: false },
  };
  var widthOf = function (r) { return r.oneway ? r.cls.w1 : r.cls.w; };
  var LAYER_H = 1.2, DASH = 4, PERIOD = 10;
  var renderer = null, camera = null, mats = null, chunk = null, builtAt = null, building = false;

  function makeMats() {
    var T = window.THREE, ds = T.DoubleSide;
    var mark = function (color) { return new T.MeshBasicMaterial({ color: color, side: ds, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }); };
    mats = {
      asphalt: new T.MeshLambertMaterial({ color: 0x55585D, side: ds }),
      concrete: new T.MeshLambertMaterial({ color: 0xCFCCC4, side: ds }),
      white: mark(0xF4F4F4),
      yellow: mark(0xF2BE1A),
    };
  }
  function Bucket() { this.p = []; }
  Bucket.prototype.tri = function (a, b, c) { this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); };
  Bucket.prototype.quad = function (a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); };

  // 向心 Catmull-Rom 曲線(轉彎平順)，每 3 公尺一點；穿過原本的點
  function smooth(P) {
    var n = P.length;
    if (n < 3) return P;
    var at = function (i) { return i < 0 ? [2 * P[0][0] - P[1][0], 2 * P[0][1] - P[1][1]] : i >= n ? [2 * P[n - 1][0] - P[n - 2][0], 2 * P[n - 1][1] - P[n - 2][1]] : P[i]; };
    var out = [P[0]];
    for (var i = 0; i < n - 1; i++) {
      var p0 = at(i - 1), p1 = P[i], p2 = P[i + 1], p3 = at(i + 2), d = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), m = Math.min(30, Math.ceil(d / 3));
      if (m <= 1) { out.push(p2); continue; }
      var dist = function (a, b) { return Math.max(1e-6, Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5)); };
      var t0 = 0, t1 = dist(p0, p1), t2 = t1 + dist(p1, p2), t3 = t2 + dist(p2, p3);
      for (var j = 1; j < m; j++) {
        var t = t1 + (t2 - t1) * j / m, q = [0, 0];
        for (var c = 0; c < 2; c++) {
          var A1 = (t1 - t) / (t1 - t0) * p0[c] + (t - t0) / (t1 - t0) * p1[c];
          var A2 = (t2 - t) / (t2 - t1) * p1[c] + (t - t1) / (t2 - t1) * p2[c];
          var A3 = (t3 - t) / (t3 - t2) * p2[c] + (t - t2) / (t3 - t2) * p3[c];
          var B1 = (t2 - t) / (t2 - t0) * A1 + (t - t0) / (t2 - t0) * A2;
          var B2 = (t3 - t) / (t3 - t1) * A2 + (t - t1) / (t3 - t1) * A3;
          q[c] = (t2 - t) / (t2 - t1) * B1 + (t - t1) / (t2 - t1) * B2;
        }
        out.push(q);
      }
      out.push(p2);
    }
    return out;
  }
  function rights(P) {
    var n = P.length, seg = [], R = [];
    for (var i = 0; i < n - 1; i++) { var dx = P[i + 1][0] - P[i][0], dy = P[i + 1][1] - P[i][1], d = Math.hypot(dx, dy) || 1; seg.push([-dy / d, dx / d]); }
    for (i = 0; i < n; i++) {
      var a = seg[Math.max(0, i - 1)], b = seg[Math.min(n - 2, i)], x = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(x, y) || 1;
      x /= l; y /= l;
      var f = Math.min(2, 1 / Math.max(0.5, x * b[0] + y * b[1]));
      R.push([x * f, y * f]);
    }
    return R;
  }

  // ── 從地圖資料取出畫面附近的道路 ──
  function collect(m, origin, sc) {
    var feats;
    try {
      feats = m.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation',
        filter: ['match', ['get', 'class'], ['primary', 'secondary', 'tertiary', 'minor', 'service'], true, false] });
    } catch (_) { return []; }
    var seen = {}, roads = [];
    var toLocal = function (c) { var mc = maplibregl.MercatorCoordinate.fromLngLat(c, 0); return [(mc.x - origin.x) / sc, (mc.y - origin.y) / sc]; };
    feats.forEach(function (f) {
      var p = f.properties || {}, cls = CLS[p.class];
      if (!cls || p.brunnel === 'tunnel') return;
      var g = f.geometry;
      (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []).forEach(function (cs) {
        // 圖磚邊界的重疊部分：同一段(兩端點一樣)只留一次，切成連續的幾段
        var run = [];
        var flush = function () { if (run.length > 1) roads.push({ cls: cls, name: p.class, oneway: p.oneway === 1 || p.oneway === -1, bridge: p.brunnel === 'bridge', layer: Math.max(1, +p.layer || 1), raw: run }); run = []; };
        for (var i = 0; i < cs.length - 1; i++) {
          var a = cs[i], b = cs[i + 1];
          var ka = a[0].toFixed(6) + ',' + a[1].toFixed(6), kb = b[0].toFixed(6) + ',' + b[1].toFixed(6), key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
          if (seen[key]) { flush(); continue; }
          seen[key] = 1;
          if (!run.length) run.push(a);
          run.push(b);
        }
        flush();
      });
    });
    // 只留畫面中心附近的
    var out = [];
    roads.forEach(function (r) {
      var P = r.raw.map(toLocal);
      if (!P.some(function (q) { return Math.abs(q[0]) < RADIUS && Math.abs(q[1]) < RADIUS; })) return;
      r.P = smooth(P);
      var n = r.P.length, S = [0];
      for (var i = 1; i < n; i++) S[i] = S[i - 1] + Math.hypot(r.P[i][0] - r.P[i - 1][0], r.P[i][1] - r.P[i - 1][1]);
      r.S = S; r.L = S[n - 1]; r.R = rights(r.P);
      // 橋：中間滿高度，兩頭 min(60 公尺, 長度 1/3) 內降回地面(跟前後的路接得上)
      var hb = r.bridge ? LAYER_H * r.layer : 0, ramp = Math.min(60, r.L / 3);
      r.Z = S.map(function (s) { return hb * Math.min(1, Math.min(s, r.L - s) / (ramp || 1)); });
      // 跨過國道的橋：查國道 3D 路面的高度(road_3d.js)，至少比國道高 5.3 公尺(淨空 4.5＋橋面 0.8)，往兩頭用 4% 坡度接回
      if (r.bridge && window._snmRoad3dHeightAt) {
        var need = r.P.map(function (q) {
          var ll = new maplibregl.MercatorCoordinate(origin.x + q[0] * sc, origin.y + q[1] * sc, 0).toLngLat();
          var h = window._snmRoad3dHeightAt(ll.lng, ll.lat, null, null);
          return h ? h.z + 5.3 : 0;
        });
        if (need.some(function (x) { return x > 0; })) {
          for (var k = 1; k < n; k++) need[k] = Math.max(need[k], need[k - 1] - 0.04 * (S[k] - S[k - 1]));
          for (k = n - 2; k >= 0; k--) need[k] = Math.max(need[k], need[k + 1] - 0.04 * (S[k + 1] - S[k]));
          r.Z = r.Z.map(function (z, k2) { return Math.max(z, need[k2]); });
        }
      }
      out.push(r);
    });
    return out;
  }

  // ── 路面覆蓋：標線、護欄落在別條路面上就不畫 ──
  function makeCover(roads) {
    var CELL = 25, grid = {};
    roads.forEach(function (r) {
      var half = widthOf(r) / 2;
      for (var i = 0; i < r.P.length - 1; i++) {
        var a = r.P[i], b = r.P[i + 1];
        var x0 = Math.floor((Math.min(a[0], b[0]) - half) / CELL), x1 = Math.floor((Math.max(a[0], b[0]) + half) / CELL);
        var y0 = Math.floor((Math.min(a[1], b[1]) - half) / CELL), y1 = Math.floor((Math.max(a[1], b[1]) + half) / CELL);
        var g = { r: r, i: i, half: half };
        for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) (grid[x + ',' + y] = grid[x + ',' + y] || []).push(g);
      }
    });
    // kind = 'mark'：等級一樣或比較高的路面上不畫(路口讓給大路，同等級的路口中間都不畫)；'rail'：任何同高度的路面上都不畫
    return function (p, z, self, kind) {
      var list = grid[Math.floor(p[0] / CELL) + ',' + Math.floor(p[1] / CELL)];
      if (!list) return false;
      for (var k = 0; k < list.length; k++) {
        var g = list[k], r = g.r;
        if (r === self || (kind === 'mark' && r.cls.r < self.cls.r)) continue;
        var A = r.P[g.i], B = r.P[g.i + 1], dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
        if (!L2) continue;
        var t = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2;
        if (t < -0.02 || t > 1.02) continue;
        var zo = r.Z[g.i] + (r.Z[g.i + 1] - r.Z[g.i]) * Math.max(0, Math.min(1, t));
        if (Math.abs(zo - z) > 0.4) continue;
        if (Math.hypot(p[0] - A[0] - dx * t, p[1] - A[1] - dy * t) < g.half - 0.2) return true;
      }
      return false;
    };
  }

  function buildRoad(r, B, covered) {
    var P = r.P, S = r.S, R = r.R, Z = r.Z, n = P.length, half = widthOf(r) / 2;
    var at = function (k, t, o, dy) {
      var rx = R[k][0] + (R[k + 1][0] - R[k][0]) * t, ry = R[k][1] + (R[k + 1][1] - R[k][1]) * t;
      return [P[k][0] + (P[k + 1][0] - P[k][0]) * t + rx * o, Z[k] + (Z[k + 1] - Z[k]) * t + dy, P[k][1] + (P[k + 1][1] - P[k][1]) * t + ry * o];
    };
    // 路面
    for (var k = 0; k < n - 1; k++) {
      B.asphalt.quad(at(k, 0, -half, 0.02), at(k, 0, half, 0.02), at(k, 1, half, 0.02), at(k, 1, -half, 0.02));
      if (Z[k] > 0.3 && Z[k + 1] > 0.3) [-half, half].forEach(function (e) { B.concrete.quad(at(k, 0, e, 0.02), at(k, 1, e, 0.02), at(k, 1, e, -0.3), at(k, 0, e, -0.3)); });
    }
    // 頭尾圓形路面(路口轉角平順)
    [0, n - 1].forEach(function (i) {
      var c = [P[i][0], Z[i] + 0.02, P[i][1]], seg = 12;
      for (var j = 0; j < seg; j++) {
        var a0 = j / seg * Math.PI * 2, a1 = (j + 1) / seg * Math.PI * 2;
        B.asphalt.tri(c, [c[0] + Math.cos(a0) * half, c[1], c[2] + Math.sin(a0) * half], [c[0] + Math.cos(a1) * half, c[1], c[2] + Math.sin(a1) * half]);
      }
    });
    // 一條線(偏移 o、寬 w)：每 1 公尺檢查有沒有落在別條路上，看得到的才畫；dash = 虛線
    var line = function (bk, o, w, dash, kind, prof) {
      for (var k = 0; k < n - 1; k++) {
        var len = S[k + 1] - S[k];
        if (len <= 0) continue;
        var m = Math.max(1, Math.ceil(len));
        for (var j = 0; j < m; j++) {
          var t0 = j / m, t1 = (j + 1) / m, s0 = S[k] + len * t0, s1 = S[k] + len * t1;
          var mid = at(k, (t0 + t1) / 2, o, 0);
          if (covered([mid[0], mid[2]], mid[1], r, kind)) continue;
          if (prof) {   // 護欄：profile 沿線拉出來
            for (var q = 0; q < prof.length - 1; q++) {
              var a = prof[q], b = prof[q + 1];
              bk.quad(at(k, t0, o + a[0], a[1]), at(k, t0, o + b[0], b[1]), at(k, t1, o + b[0], b[1]), at(k, t1, o + a[0], a[1]));
            }
            continue;
          }
          if (dash) {
            var st = Math.floor(s0 / PERIOD) * PERIOD, d0 = Math.max(st, s0), d1 = Math.min(st + DASH, s1);
            if (d1 - d0 < 0.05) continue;
            t0 = (d0 - S[k]) / len; t1 = (d1 - S[k]) / len;
          }
          bk.quad(at(k, t0, o - w / 2, 0.05), at(k, t0, o + w / 2, 0.05), at(k, t1, o + w / 2, 0.05), at(k, t1, o - w / 2, 0.05));
        }
      }
    };
    var c = r.cls;
    if (!r.oneway && c.c === 'yy') { line(B.yellow, 0.12, 0.12, false, 'mark'); line(B.yellow, -0.12, 0.12, false, 'mark'); }   // 中央雙黃線
    if (!r.oneway && c.c === 'yd') line(B.yellow, 0, 0.12, true, 'mark');                                                      // 中央黃虛線
    if (c.edge) { line(B.white, half - 0.5, 0.12, false, 'mark'); line(B.white, -half + 0.5, 0.12, false, 'mark'); }          // 路邊白線
    if (c.lane) {   // 車道線(白虛線)
      if (r.oneway) { for (var o = -half + 0.5 + c.lane; o < half - 0.5 - 1; o += c.lane) line(B.white, o, 0.10, true, 'mark'); }
      else if (half - 0.5 > c.lane * 1.5) { line(B.white, c.lane, 0.10, true, 'mark'); line(B.white, -c.lane, 0.10, true, 'mark'); }   // 每個方向寬到 2 車道才畫
    }
    if (r.bridge) {   // 橋上兩側混凝土護欄
      var PP = [[0, 0], [0.04, 0.95], [0.3, 0.95], [0.3, 0]];
      line(B.concrete, half - 0.3, 0, false, 'rail', PP);
      line(B.concrete, -half, 0, false, 'rail', PP);
    }
  }

  function build() {
    var m = window.map, T = window.THREE;
    var c = m.getCenter(), origin = maplibregl.MercatorCoordinate.fromLngLat([c.lng, c.lat], 0), sc = origin.meterInMercatorCoordinateUnits();
    var roads = collect(m, origin, sc), covered = makeCover(roads);
    var B = { asphalt: new Bucket(), concrete: new Bucket(), white: new Bucket(), yellow: new Bucket() };
    roads.forEach(function (r) { buildRoad(r, B, covered); });
    var scene = new T.Scene();
    scene.add(new T.AmbientLight(0xffffff, 0.62));
    var sun = new T.DirectionalLight(0xffffff, 0.6); sun.position.set(0.4, 1, 0.6); scene.add(sun);
    Object.keys(B).forEach(function (k) {
      if (!B[k].p.length) return;
      var g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(B[k].p, 3));
      g.computeVertexNormals();
      var mesh = new T.Mesh(g, mats[k]);
      mesh.renderOrder = k === 'white' || k === 'yellow' ? 2 : 0;
      mesh.frustumCulled = false;   // 不讓 three.js 自己判斷在不在畫面裡(會誤判)
      scene.add(mesh);
    });
    var matrix = new T.Matrix4().makeTranslation(origin.x, origin.y, origin.z).scale(new T.Vector3(sc, -sc, sc))
      .multiply(new T.Matrix4().makeRotationAxis(new T.Vector3(1, 0, 0), Math.PI / 2));
    if (chunk) chunk.scene.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
    chunk = { scene: scene, matrix: matrix, roads: roads.length };
    builtAt = { lng: c.lng, lat: c.lat };
    m.triggerRepaint();
  }

  var customLayer = {
    id: LAYER, type: 'custom', renderingMode: '3d',
    onAdd: function (map, gl) {
      var T = window.THREE;
      camera = new T.Camera();
      renderer = new T.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    render: function (gl, matrix) {
      if (!renderer || !chunk || window.map.getZoom() < MIN_ZOOM) return;
      var T = window.THREE;
      camera.projectionMatrix = new T.Matrix4().fromArray(matrix).multiply(chunk.matrix);
      renderer.resetState();
      renderer.render(chunk.scene, camera);
    }
  };
  // 放在所有路況綠線、底圖道路名稱下面：在 snm-roads-outline-minor 前面(沒有的話放在國道 3D 前面)
  function place() {
    var m = window.map;
    if (!m || !m.getLayer(LAYER)) return;
    var before = m.getLayer('snm-roads-outline-minor') ? 'snm-roads-outline-minor' : m.getLayer('snm-road-3d') ? 'snm-road-3d' : null;
    var order = (m.style && m.style._order) || [];
    if (before && order.indexOf(LAYER) !== order.indexOf(before) - 1) m.moveLayer(LAYER, before);
  }
  function addLayer() {
    var m = window.map;
    if (!m || !window.THREE || m.getLayer(LAYER)) return;
    if (!mats) makeMats();
    m.addLayer(customLayer);
    place();
  }
  function check() {
    var m = window.map;
    if (!m || !window.THREE || m.getZoom() < MIN_ZOOM) return;
    addLayer();
    var c = m.getCenter();
    if (builtAt && Math.hypot((c.lng - builtAt.lng) * 101000, (c.lat - builtAt.lat) * 110540) < REBUILD_MOVE && chunk) return;
    if (building) return;
    building = true;
    setTimeout(function () { try { build(); } catch (e) { console.error('[road3d-local]', e); } building = false; }, 0);
  }
  // 地圖圖磚新載入時(移動後道路資料才進來)重建
  var dataTimer = null;
  function onData(e) {
    if (e.sourceId !== 'openmaptiles' || !e.isSourceLoaded || !window.map || window.map.getZoom() < MIN_ZOOM) return;
    clearTimeout(dataTimer);
    dataTimer = setTimeout(function () { builtAt = null; check(); }, 300);
  }
  window._snmReloadRoad3dLocal = function () { if (window.map && !window.map.getLayer(LAYER)) renderer = null; builtAt = null; if (window.THREE && window.map && window.map.getZoom() >= MIN_ZOOM) { addLayer(); check(); } };
  window._snmRoad3dLocalState = function () { return { roads: chunk ? chunk.roads : 0, builtAt: builtAt }; };   // 除錯用
  function init() {
    var m = window.map;
    if (!m) { setTimeout(init, 500); return; }
    var go = function () {
      var t = null;
      m.on('moveend', function () { clearTimeout(t); t = setTimeout(function () { if (window.THREE) check(); }, 300); });
      m.on('sourcedata', onData);
      m.on('styledata', place);
      // three.js 由 road_3d.js 載入；還沒載入就等一下
      var wait = setInterval(function () { if (window.THREE) { clearInterval(wait); check(); } }, 1000);
    };
    if (m.loaded()) go(); else m.once('load', go);
  }
  init();
})();
