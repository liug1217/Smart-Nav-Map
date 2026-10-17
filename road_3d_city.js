// ===== 🏙 一般道路 3D 路面(省道、縣道、市區道路、巷弄) =====
// 放大到 zoom 16 以上，把底圖的一般道路(openmaptiles transportation：primary / secondary / tertiary / minor / service)畫成 3D 路面：
//   - 底圖的道路被切成一塊一塊(圖磚)，先去掉重複的、切邊多出來的小尾巴，再接成完整的一條(路口斷開)
//   - 曲線跟國道一樣用向心 Catmull-Rom 樣條(road_3d_shape.js)：通過每個原始點、沒有折角
//   - 路寬照道路等級：省道級(primary) 雙向 4 線、縣道級(secondary) 雙向 4 線(較窄)、區道(tertiary) 雙向 2 線、巷弄 6 公尺、服務道路 4 公尺；單行道減半
//   - 標線：primary / secondary 中央雙黃線＋白色車道虛線＋路面邊線；tertiary 中央黃虛線＋邊線；巷弄、服務道路不畫；路口裡面不畫標線
//   - 從平面的國道上面跨過去的路：抬到國道上方 5.3 公尺(淨空 4.5)，用 4% 坡度接回地面，兩側紐澤西護欄
// 圖層放在路況綠線、導航路線的下面(路況顏色、導航路線照樣畫在上面)，國道 3D 路面的下面
(function () {
  'use strict';
  var MIN_ZOOM = 16, LAYER = 'snm-road-3d-city';
  var CLASS = {   // 寬(公尺)、車道寬、每個方向幾線、高度(大路畫在小路上面，路口不打架)、標線
    primary:   { lanes: 2, lane: 3.5, edge: 1.5, y: 0.030, mark: 'double' },
    secondary: { lanes: 2, lane: 3.25, edge: 1.0, y: 0.026, mark: 'double' },
    tertiary:  { lanes: 1, lane: 3.25, edge: 1.0, y: 0.022, mark: 'dashed' },
    minor:     { lanes: 1, lane: 3.0, edge: 0, y: 0.018, mark: 'none', fixedW: 6 },
    service:   { lanes: 1, lane: 2.0, edge: 0, y: 0.014, mark: 'none', fixedW: 4 }
  };
  var renderer = null, camera = null, chunk = null, timer = null, builtFor = null, mats = null;

  function widthOf(c, oneway) {
    var k = CLASS[c];
    if (k.fixedW) return oneway ? Math.max(3.5, k.fixedW * 0.7) : k.fixedW;
    return (oneway ? k.lanes : k.lanes * 2) * k.lane + k.edge * 2;
  }

  // ── 底圖的道路 → 完整的一條條路 ──
  function collect(b) {
    var m = window.map, srcId = m.getSource('openmaptiles') ? 'openmaptiles' : m.getSource('snm-roads') ? 'snm-roads' : null;
    if (!srcId) return [];
    var feats;
    try { feats = m.querySourceFeatures(srcId, { sourceLayer: 'transportation', filter: ['match', ['get', 'class'], Object.keys(CLASS), true, false] }); } catch (e) { return []; }
    var K = function (c) { return c[0].toFixed(6) + ',' + c[1].toFixed(6); };
    var edges = {}, adj = {};
    feats.forEach(function (f) {
      var p = f.properties || {}, g = f.geometry;
      if (p.brunnel === 'tunnel' || !CLASS[p.class]) return;
      var oneway = p.oneway === 1 || p.oneway === -1;
      (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []).forEach(function (cs) {
        if (p.oneway === -1) cs = cs.slice().reverse();
        for (var i = 0; i < cs.length - 1; i++) {
          var a = cs[i], c = cs[i + 1];
          if (Math.max(a[0], c[0]) < b.w || Math.min(a[0], c[0]) > b.e || Math.max(a[1], c[1]) < b.s || Math.min(a[1], c[1]) > b.n) continue;
          var ka = K(a), kc = K(c);
          if (ka === kc) continue;
          var key = ka < kc ? ka + '|' + kc : kc + '|' + ka;
          if (edges[key]) continue;   // 好幾塊圖磚重複的
          edges[key] = { a: a, c: c, ka: ka, kc: kc, cls: p.class, oneway: oneway, key: key };
          (adj[ka] = adj[ka] || []).push(key); (adj[kc] = adj[kc] || []).push(key);
        }
      });
    });
    // 圖磚切邊多出來的小尾巴：只接一條路的端點，又剛好落在別條路線上(0.5 公尺內) → 是切出來的，拿掉
    var kx = 111320 * Math.cos((b.s + b.n) / 2 * Math.PI / 180), ky = 110540;
    var onOther = function (pt, self) {
      for (var key in edges) {
        var e = edges[key]; if (key === self) continue;
        var ax = (e.a[0] - pt[0]) * kx, ay = (e.a[1] - pt[1]) * ky, cx = (e.c[0] - pt[0]) * kx, cy = (e.c[1] - pt[1]) * ky, dx = cx - ax, dy = cy - ay, L2 = dx * dx + dy * dy;
        if (!L2) continue;
        var t = -(ax * dx + ay * dy) / L2;
        if (t <= 0.001 || t >= 0.999) continue;
        if (Math.hypot(ax + t * dx, ay + t * dy) < 0.5) return true;
      }
      return false;
    };
    Object.keys(edges).forEach(function (key) {
      var e = edges[key];
      [[e.ka, e.a], [e.kc, e.c]].forEach(function (x) {
        if (!edges[key] || (adj[x[0]] || []).length !== 1 || !onOther(x[1], key)) return;
        delete edges[key];
        adj[e.ka] = (adj[e.ka] || []).filter(function (k) { return k !== key; });
        adj[e.kc] = (adj[e.kc] || []).filter(function (k) { return k !== key; });
      });
    });
    // 接成完整的一條：在「只有兩條接在一起、同等級、同樣單行 / 雙向」的點接續，路口(三條以上)斷開
    var used = {}, out = [];
    var live = function (k) { return (adj[k] || []).filter(function (x) { return edges[x]; }); };
    var nextFrom = function (k, e) {   // 從點 k 接下去的那條(沒有就 null)
      var l = live(k);
      if (l.length !== 2) return null;
      var nx = edges[l[0] === e.key ? l[1] : l[0]];
      return nx && !used[nx.key] && nx.cls === e.cls && nx.oneway === e.oneway ? nx : null;
    };
    Object.keys(edges).forEach(function (key) {
      if (used[key]) return;
      var e = edges[key], line = [e.a, e.c], keys = [e.ka, e.kc];
      used[key] = 1;
      [true, false].forEach(function (atEnd) {
        var k = atEnd ? keys[keys.length - 1] : keys[0], cur = e;
        for (;;) {
          var nx = nextFrom(k, cur);
          if (!nx) break;
          used[nx.key] = 1;
          var nk = nx.ka === k ? nx.kc : nx.ka, np = nx.ka === k ? nx.c : nx.a;
          if (atEnd) { line.push(np); keys.push(nk); } else { line.unshift(np); keys.unshift(nk); }
          k = nk; cur = nx;
        }
      });
      out.push({ cls: e.cls, oneway: e.oneway, coords: line, endsDeg: [live(keys[0]).length, live(keys[keys.length - 1]).length] });
    });
    return out;
  }

  // ── 幾何 ──
  function Bucket() { this.p = []; }
  Bucket.prototype.quad = function (a, b, c, d) { this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]); };

  function build() {
    var m = window.map, T = window.THREE, RS = window.RoadShape;
    var bb = m.getBounds(), pw = (bb.getEast() - bb.getWest()) * 0.25, ph = (bb.getNorth() - bb.getSouth()) * 0.25;
    var box = { w: bb.getWest() - pw, e: bb.getEast() + pw, s: bb.getSouth() - ph, n: bb.getNorth() + ph };
    var roads = collect(box);
    var c = m.getCenter(), origin = maplibregl.MercatorCoordinate.fromLngLat([c.lng, c.lat], 0), sc = origin.meterInMercatorCoordinateUnits();
    var local = function (q) { var mc = maplibregl.MercatorCoordinate.fromLngLat(q, 0); return [(mc.x - origin.x) / sc, (mc.y - origin.y) / sc]; };
    var B = { asphalt: new Bucket(), white: new Bucket(), yellow: new Bucket(), concrete: new Bucket() };
    // 路口的大小：每個路口最寬那條路的一半(標線在路口裡面不畫)
    var K = function (q) { return q[0].toFixed(6) + ',' + q[1].toFixed(6); }, junW = {};
    roads.forEach(function (r) { var w = widthOf(r.cls, r.oneway); [r.coords[0], r.coords[r.coords.length - 1]].forEach(function (q) { var k = K(q); junW[k] = Math.max(junW[k] || 0, w / 2); }); });
    roads.forEach(function (r) {
      var P0 = [], last = null;
      r.coords.forEach(function (q) { var p = local(q); if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.3) { P0.push(p); last = p; } });
      if (P0.length < 2) return;
      var P = RS.curve(P0, []), fr = RS.frame(P, function (tx, tz) { return [-tz, tx]; }), n = P.length, S = fr.S, R = fr.R, segR = fr.seg, L = S[n - 1];
      var k = CLASS[r.cls], W = widthOf(r.cls, r.oneway), hw = W / 2;
      // 從平面國道上面跨過去：抬高
      var H = S.map(function () { return 0; }), cross = [];
      if (window._snmRoad3dAt) for (var s0 = 0; s0 <= L; s0 += 4) {
        var i = 0; while (i < n - 2 && S[i + 1] < s0) i++;
        var t = (s0 - S[i]) / ((S[i + 1] - S[i]) || 1), px = P[i][0] + (P[i + 1][0] - P[i][0]) * t, pz = P[i][1] + (P[i + 1][1] - P[i][1]) * t;
        var ll = new maplibregl.MercatorCoordinate(origin.x + px * sc, origin.y + pz * sc, 0).toLngLat(), a = window._snmRoad3dAt(ll.lng, ll.lat, 25);
        if (a && a.side > a.nhalf - 1 && a.side < a.half + 1 && a.h < 3) cross.push([s0, a.h + 5.3]);
      }
      if (cross.length) H = S.map(function (s) { var h = 0; cross.forEach(function (x) { h = Math.max(h, x[1] - 0.04 * Math.max(0, Math.abs(s - x[0]) - 15)); }); return h; });
      var pt = function (q, o, y) { return [P[q][0] + R[q][0] * o, H[q] + y, P[q][1] + R[q][1] * o]; };
      var strip = function (bk, o1, o2, y, from, to) {
        for (var q = 0; q < n - 1; q++) { if (from != null && (S[q + 1] < from || S[q] > to)) continue; bk.quad(pt(q, o1, y), pt(q, o2, y), pt(q + 1, o2, y), pt(q + 1, o1, y)); }
      };
      var dashed = function (bk, o, wd, y, on, period, from, to) {
        for (var q = 0; q < n - 1; q++) {
          var a0 = S[q], a1 = S[q + 1];
          for (var st = Math.floor(a0 / period) * period; st < a1; st += period) {
            var u0 = Math.max(st, a0, from), u1 = Math.min(st + on, a1, to);
            if (u1 - u0 < 0.2) continue;
            var t0 = (u0 - a0) / (a1 - a0), t1 = (u1 - a0) / (a1 - a0), rr = segR[q], h2 = wd / 2;
            var f = function (tt, oo) { return [P[q][0] + (P[q + 1][0] - P[q][0]) * tt + rr[0] * oo, H[q] + (H[q + 1] - H[q]) * tt + y, P[q][1] + (P[q + 1][1] - P[q][1]) * tt + rr[1] * oo]; };
            bk.quad(f(t0, o - h2), f(t0, o + h2), f(t1, o + h2), f(t1, o - h2));
          }
        }
      };
      strip(B.asphalt, -hw, hw, k.y);
      // 標線：路口裡面(路口最寬那條路的一半＋1.5 公尺)不畫
      var from = r.endsDeg[0] >= 3 ? (junW[K(r.coords[0])] || 0) + 1.5 : 0, to = L - (r.endsDeg[1] >= 3 ? (junW[K(r.coords[r.coords.length - 1])] || 0) + 1.5 : 0);
      if (to - from > 2 && k.mark !== 'none') {
        var my = k.y + 0.03;
        strip(B.white, hw - k.edge - 0.15, hw - k.edge, my, from, to);   // 外側邊線
        if (!r.oneway) {
          strip(B.white, -hw + k.edge, -hw + k.edge + 0.15, my, from, to);
          if (k.mark === 'double') { strip(B.yellow, 0.06, 0.18, my, from, to); strip(B.yellow, -0.18, -0.06, my, from, to); }   // 中央雙黃線
          else dashed(B.yellow, 0, 0.15, my, 4, 10, from, to);                                                                    // 中央黃虛線
          for (var ln = 1; ln < k.lanes; ln++) { dashed(B.white, ln * k.lane, 0.12, my, 4, 10, from, to); dashed(B.white, -ln * k.lane, 0.12, my, 4, 10, from, to); }
        } else {
          strip(B.white, -hw + k.edge, -hw + k.edge + 0.15, my, from, to);
          for (var l2 = 1; l2 < k.lanes; l2++) dashed(B.white, -hw + k.edge + l2 * k.lane, 0.12, my, 4, 10, from, to);
        }
      }
      // 抬高的那段：兩側紐澤西護欄＋橋面版側邊
      if (cross.length) {
        var JERSEY = [[0, 0], [0.05, 0.08], [0.18, 0.33], [0.24, 0.85], [0.42, 0.85], [0.48, 0.33], [0.61, 0.08], [0.66, 0]];
        for (var q = 0; q < n - 1; q++) {
          if (H[q] < 0.5 && H[q + 1] < 0.5) continue;
          [[hw, -1], [-hw, 1]].forEach(function (sd) {
            for (var j = 0; j < JERSEY.length - 1; j++) {
              var p0 = JERSEY[j], p1 = JERSEY[j + 1];
              B.concrete.quad(pt(q, sd[0] + sd[1] * p0[0], k.y + p0[1]), pt(q, sd[0] + sd[1] * p1[0], k.y + p1[1]), pt(q + 1, sd[0] + sd[1] * p1[0], k.y + p1[1]), pt(q + 1, sd[0] + sd[1] * p0[0], k.y + p0[1]));
            }
            var d0 = Math.min(1.2, H[q]), d1 = Math.min(1.2, H[q + 1]);
            B.concrete.quad(pt(q, sd[0], k.y), pt(q + 1, sd[0], k.y), pt(q + 1, sd[0], k.y - d1), pt(q, sd[0], k.y - d0));
          });
        }
      }
    });
    var group = new T.Group();
    Object.keys(B).forEach(function (key) {
      if (!B[key].p.length) return;
      var g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(B[key].p, 3));
      g.computeVertexNormals();
      var mesh = new T.Mesh(g, mats[key]); mesh.frustumCulled = false;
      if (key === 'white' || key === 'yellow') mesh.renderOrder = 2;
      group.add(mesh);
    });
    var scene = new T.Scene();
    scene.add(new T.AmbientLight(0xffffff, 0.62));
    var sun = new T.DirectionalLight(0xffffff, 0.6); sun.position.set(0.4, 1, 0.6); scene.add(sun);
    scene.add(group);
    var matrix = new T.Matrix4().makeTranslation(origin.x, origin.y, origin.z).scale(new T.Vector3(sc, -sc, sc)).multiply(new T.Matrix4().makeRotationAxis(new T.Vector3(1, 0, 0), Math.PI / 2));
    if (chunk) chunk.scene.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
    chunk = { scene: scene, matrix: matrix };
    builtFor = { box: box, zoom: m.getZoom() };
    m.triggerRepaint();
  }
  function makeMats() {
    var T = window.THREE, ds = T.DoubleSide;
    var mark = function (color) { return new T.MeshBasicMaterial({ color: color, side: ds, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }); };
    mats = {
      asphalt: new T.MeshLambertMaterial({ color: 0x4A4D52, side: ds }),
      concrete: new T.MeshLambertMaterial({ color: 0xCFCCC4, side: ds }),
      white: mark(0xF4F4F4), yellow: mark(0xF2BE1A)
    };
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
  // 放在綠色道路線、導航路線的下面(那些線照樣畫在一般道路上面)
  function beforeId(m) {
    var ids = ['snm-roads-outline-minor', 'navRoute-outline', 'snm-traffic-casing', 'snm-road-3d', 'building-3d'];
    for (var i = 0; i < ids.length; i++) if (m.getLayer(ids[i])) return ids[i];
    return undefined;
  }
  function check() {
    var m = window.map;
    if (!m || !window.THREE || !window.RoadShape) return;
    if (m.getZoom() < MIN_ZOOM) { if (chunk) m.triggerRepaint(); return; }
    if (!mats) makeMats();
    if (!m.getLayer(LAYER)) m.addLayer(customLayer, beforeId(m));
    // 畫面還在上次建好的範圍裡(而且縮放差不多)就不用重建
    var b = m.getBounds();
    if (builtFor && b.getWest() >= builtFor.box.w && b.getEast() <= builtFor.box.e && b.getSouth() >= builtFor.box.s && b.getNorth() <= builtFor.box.n && Math.abs(m.getZoom() - builtFor.zoom) < 1.5) return;
    build();
  }
  function soon(force) { if (force) builtFor = null; clearTimeout(timer); timer = setTimeout(check, 300); }
  window._snmReloadRoad3dCity = function () { renderer = null; chunk = null; builtFor = null; soon(true); };   // 換地圖樣式後重加
  function init() {
    var m = window.map;
    if (!m) { setTimeout(init, 500); return; }
    var go = function () {
      m.on('moveend', function () { soon(); });
      m.on('sourcedata', function (e) { if (e.isSourceLoaded && (e.sourceId === 'openmaptiles' || e.sourceId === 'snm-roads') && m.getZoom() >= MIN_ZOOM) soon(true); });   // 道路資料載完再建一次
      soon(true);
    };
    if (m.loaded()) go(); else m.once('load', go);
    window.addEventListener('snm-road3d-data', function () { soon(true); });   // 國道 3D 載入後：跨過國道的路重新抬高
  }
  init();
})();
