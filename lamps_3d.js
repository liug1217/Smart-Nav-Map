// ===== 💡 國道、快速道路路燈(3D) =====
// 放大到 zoom 16 以上，沿著底圖的國道(motorway)、快速道路(trunk)立路燈：
//   - 立在道路兩側外面：單行道(上下行分開畫的線)立在自己右邊外側 → 上下行合起來就是整條路兩側；雙向道路兩邊都立
//   - 每 50 公尺一支；離道路中心線：國道 9.5 公尺、快速道路 7.5 公尺、匝道 5 公尺(路面一半＋路肩外)；隧道裡不立
//   - 造型：圓的鋼管燈桿(下粗上細)＋底座，頂端往上彎再水平伸向車道的燈臂，扁長的 LED 燈頭(朝下發光)
// 底圖的道路被切成一塊一塊(圖磚)，重複的路燈(5 公尺內)只留一支
(function () {
  'use strict';
  var MIN_ZOOM = 16, LAYER = 'snm-lamps-3d', SPACING = 50, LAMP_H = 11, REACH = 2.6;
  var THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  var renderer = null, camera = null, chunk = null, builtFor = null, timer = null, loading = false, mats = null;

  function offsetOf(p) {
    if (p.ramp === 1) return 5;
    return p.class === 'motorway' ? 9.5 : 7.5;
  }
  // 底圖的國道、快速道路 → 路燈位置 [{ lon, lat, bearing(行車方向), side(1 右 / -1 左) }]
  function lampSpots(box) {
    var m = window.map, srcId = m.getSource('openmaptiles') ? 'openmaptiles' : m.getSource('snm-roads') ? 'snm-roads' : null;
    if (!srcId) return [];
    var feats;
    try { feats = m.querySourceFeatures(srcId, { sourceLayer: 'transportation', filter: ['match', ['get', 'class'], ['motorway', 'trunk'], true, false] }); } catch (e) { return []; }
    var out = [], seen = {}, kx = 111320 * Math.cos((box.s + box.n) / 2 * Math.PI / 180), ky = 110540;
    feats.forEach(function (f) {
      var p = f.properties || {}, g = f.geometry;
      if (p.brunnel === 'tunnel') return;
      var oneway = p.oneway === 1 || p.oneway === -1 || p.class === 'motorway', off = offsetOf(p);
      (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []).forEach(function (cs) {
        if (p.oneway === -1) cs = cs.slice().reverse();
        var acc = 0;
        for (var i = 0; i < cs.length - 1; i++) {
          var a = cs[i], b = cs[i + 1], dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky, L = Math.hypot(dx, dy);
          if (!L) continue;
          // 每 50 公尺一支：用「沿路距離」決定，同一條路在不同圖磚的那幾段立的位置一樣
          for (var s = Math.ceil(acc / SPACING) * SPACING; s < acc + L; s += SPACING) {
            var t = (s - acc) / L, lon = a[0] + (b[0] - a[0]) * t, lat = a[1] + (b[1] - a[1]) * t;
            if (lon < box.w || lon > box.e || lat < box.s || lat > box.n) continue;
            var ux = dx / L, uy = dy / L, rx = uy, ry = -ux;   // 行車方向的右邊(東、北)
            (oneway ? [1] : [1, -1]).forEach(function (side) {
              var px = lon + rx * side * off / kx, py = lat + ry * side * off / ky;
              var key = Math.round(px * kx / 5) + ',' + Math.round(py * ky / 5);   // 5 公尺內重複的只留一支
              if (seen[key]) return;
              seen[key] = 1;
              out.push({ lon: px, lat: py, ux: ux * side, uy: uy * side, rx: rx * side, ry: ry * side });
            });
          }
          acc += L;
        }
      });
    });
    return out;
  }

  // ── 模型(全部路燈合成一個網格) ──
  function Bucket() { this.p = []; }
  Bucket.prototype.quad = function (a, b, c, d) { this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]); };
  function tube(bk, a0, a1, r0, r1) {   // 兩點之間的八角管(r0 → r1 粗細)
    var d = [a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]], L0 = Math.hypot(d[0], d[1], d[2]) || 1;
    d = [d[0] / L0, d[1] / L0, d[2] / L0];
    var u = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    var e1 = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]], l1 = Math.hypot(e1[0], e1[1], e1[2]); e1 = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
    var e2 = [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]];
    var ring = function (c, r) { var o = []; for (var q = 0; q < 8; q++) { var t = q / 8 * Math.PI * 2, cs = Math.cos(t) * r, sn = Math.sin(t) * r; o.push([c[0] + e1[0] * cs + e2[0] * sn, c[1] + e1[1] * cs + e2[1] * sn, c[2] + e1[2] * cs + e2[2] * sn]); } return o; };
    var A0 = ring(a0, r0), A1 = ring(a1, r1);
    for (var q = 0; q < 8; q++) bk.quad(A0[q], A0[(q + 1) % 8], A1[(q + 1) % 8], A1[q]);
  }
  // 一支路燈：x 東、y 上、z 南；r = 燈臂伸出去的方向(往車道 = 右手方向的反方向)，f = 沿路方向
  function lamp(B, x, z, r, f) {
    var top = LAMP_H, P0 = [x, 0, z], P1 = [x, top - 0.6, z];
    tube(B.steel, P0, P1, 0.13, 0.08);                                                       // 燈桿
    var cs0 = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function (q) { return [x + r[0] * q[0] * 0.25 + f[0] * q[1] * 0.25, z + r[1] * q[0] * 0.25 + f[1] * q[1] * 0.25]; });
    for (var e = 0; e < 4; e++) { var c0 = cs0[e], c1 = cs0[(e + 1) % 4]; B.steel.quad([c0[0], 0, c0[1]], [c1[0], 0, c1[1]], [c1[0], 0.12, c1[1]], [c0[0], 0.12, c0[1]]); }   // 底座
    var out = function (dist, y) { return [x + r[0] * dist, y, z + r[1] * dist]; };
    var A1 = out(0.35, top - 0.15), A2 = out(1.0, top + 0.05), A3 = out(REACH, top + 0.12);
    tube(B.steel, P1, A1, 0.08, 0.065); tube(B.steel, A1, A2, 0.065, 0.055); tube(B.steel, A2, A3, 0.055, 0.05);   // 燈臂(往上彎再伸向車道)
    var hx = A3[0] + r[0] * 0.4, hz = A3[2] + r[1] * 0.4, hy = A3[1];
    var hc = [[-0.55, -0.17], [0.55, -0.17], [0.55, 0.17], [-0.55, 0.17]].map(function (q) { return [hx + r[0] * q[0] + f[0] * q[1], hz + r[1] * q[0] + f[1] * q[1]]; });
    B.steel.quad([hc[0][0], hy + 0.08, hc[0][1]], [hc[1][0], hy + 0.06, hc[1][1]], [hc[2][0], hy + 0.06, hc[2][1]], [hc[3][0], hy + 0.08, hc[3][1]]);   // 燈頭上蓋
    for (var k = 0; k < 4; k++) { var d0 = hc[k], d1 = hc[(k + 1) % 4]; B.steel.quad([d0[0], hy - 0.04, d0[1]], [d1[0], hy - 0.04, d1[1]], [d1[0], hy + 0.07, d1[1]], [d0[0], hy + 0.07, d0[1]]); }
    B.lamp.quad([hc[0][0], hy - 0.045, hc[0][1]], [hc[3][0], hy - 0.045, hc[3][1]], [hc[2][0], hy - 0.045, hc[2][1]], [hc[1][0], hy - 0.045, hc[1][1]]);   // 發光面(朝下)
  }

  function build() {
    var m = window.map, T = window.THREE;
    var bb = m.getBounds(), pw = (bb.getEast() - bb.getWest()) * 0.6, ph = (bb.getNorth() - bb.getSouth()) * 0.6;
    var box = { w: bb.getWest() - pw, e: bb.getEast() + pw, s: bb.getSouth() - ph, n: bb.getNorth() + ph };
    var spots = lampSpots(box), c = m.getCenter();
    var origin = maplibregl.MercatorCoordinate.fromLngLat([c.lng, c.lat], 0), sc = origin.meterInMercatorCoordinateUnits();
    var B = { steel: new Bucket(), lamp: new Bucket() };
    spots.forEach(function (s) {
      var mc = maplibregl.MercatorCoordinate.fromLngLat([s.lon, s.lat], 0), x = (mc.x - origin.x) / sc, z = (mc.y - origin.y) / sc;
      // 地圖座標(東、北) → 這裡(x 東、z 南)：北要變號
      lamp(B, x, z, [-s.rx, s.ry], [s.ux, -s.uy]);   // 燈臂往左伸(伸向車道)
    });
    var group = new T.Group();
    Object.keys(B).forEach(function (k) {
      if (!B[k].p.length) return;
      var g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(B[k].p, 3));
      g.computeVertexNormals();
      var mesh = new T.Mesh(g, mats[k]); mesh.frustumCulled = false;
      group.add(mesh);
    });
    var scene = new T.Scene();
    scene.add(new T.AmbientLight(0xffffff, 0.62));
    var sun = new T.DirectionalLight(0xffffff, 0.6); sun.position.set(0.4, 1, 0.6); scene.add(sun);
    scene.add(group);
    if (chunk) chunk.scene.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
    chunk = { scene: scene, matrix: new T.Matrix4().makeTranslation(origin.x, origin.y, origin.z).scale(new T.Vector3(sc, -sc, sc)).multiply(new T.Matrix4().makeRotationAxis(new T.Vector3(1, 0, 0), Math.PI / 2)) };
    builtFor = { box: box, zoom: m.getZoom(), at: Date.now(), n: spots.length };
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
  function check() {
    var m = window.map;
    if (!m || m.getZoom() < MIN_ZOOM) return;
    if (!window.THREE) {   // 放大到 zoom 16 才載入 three.js(畫 3D 的工具)
      if (!loading) { loading = true; var sc = document.createElement('script'); sc.src = THREE_URL; sc.onload = check; document.head.appendChild(sc); }
      return;
    }
    if (!mats) {
      var T = window.THREE;
      mats = { steel: new T.MeshPhongMaterial({ color: 0xC4CACF, specular: 0x8A8F94, shininess: 60, side: T.DoubleSide }), lamp: new T.MeshBasicMaterial({ color: 0xFFF3C4, side: T.DoubleSide }) };
    }
    if (!m.getLayer(LAYER)) m.addLayer(customLayer, m.getLayer('user-car') ? 'user-car' : undefined);
    // 還在上次建好的範圍裡就不重建；道路資料剛載入(上次沒抓到什麼)最多每 3 秒補建一次
    var b = m.getBounds();
    var inside = builtFor && b.getWest() >= builtFor.box.w && b.getEast() <= builtFor.box.e && b.getSouth() >= builtFor.box.s && b.getNorth() <= builtFor.box.n && Math.abs(m.getZoom() - builtFor.zoom) < 1.5;
    if (inside && !(dirty && Date.now() - builtFor.at > 3000)) return;
    dirty = false;
    build();
  }
  var dirty = false;
  window._snmReloadLamps3d = function () { renderer = null; chunk = null; builtFor = null; clearTimeout(timer); timer = setTimeout(check, 300); };   // 換地圖樣式後重加
  function init() {
    var m = window.map;
    if (!m) { setTimeout(init, 500); return; }
    var go = function () {
      m.on('moveend', function () { clearTimeout(timer); timer = setTimeout(check, 250); });
      var lastMove = 0;   // 導航時鏡頭一直在動(不會有「移動結束」)：移動中也每 1 秒檢查
      m.on('move', function () { var now = Date.now(); if (now - lastMove > 1000) { lastMove = now; check(); } });
      m.on('sourcedata', function (e) { if (e.isSourceLoaded && (e.sourceId === 'openmaptiles' || e.sourceId === 'snm-roads')) dirty = true; });
      check();
    };
    if (m.loaded()) go(); else m.once('load', go);
  }
  init();
})();
