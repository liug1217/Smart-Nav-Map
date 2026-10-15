// ===== 🛣 國道、快速道路 3D 路面 =====
// 放大到 zoom 16 以上，把國道(motorway)、快速道路(trunk)與匝道畫成立體道路。
// 所有計算(接成完整的路、曲線平滑、橋梁高度、分隔島、車道漸變、哪些標線護欄要畫、槽化線)都在電腦上事先算好
// (tools/build-road3d.js、tools/road3d-core.js)，這裡只把算好的資料畫出來：
//   路面：車道 3.75 公尺、內側路肩 1、外側路肩 3(匝道 2)；橋面有側邊
//   標線：車道線白虛線(線段 4 公尺、間距 6 公尺、線寬 10 公分)、外側白實線、內側黃實線；雙向道路中間雙黃線；匝道分岔處白色槽化線
//   護欄：外側鋼板護欄(W 型鋼板＋每 4 公尺一根立柱)、中央紐澤西護欄、橋上混凝土護欄
//   路況綠線(沒塞車)畫在路面中間，跟著主程式的綠色道路開關
// 資料：road3d/13/x_y.json(zoom 13 圖磚，一塊約 4.9 公里)，只抓畫面附近那幾塊，同一塊只抓一次。
// 上下層靠真的高度(橋每層 1.2 公尺)用深度判斷遮擋；圖層放在路況綠線、導航路線的下面，路況顏色、導航路線、車子照樣看得到。
(function () {
  'use strict';
  var MIN_ZOOM = 16, TILE_Z = 13, MAX_CHUNKS = 16;
  var THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  var LAYER = 'snm-road-3d';
  var DATA_DIR = 'road3d/';
  var DASH = 4, PERIOD = 10;   // 車道線：線段 4 公尺、間距 6 公尺
  var index = null, indexState = 'none';   // 有資料的圖磚清單
  var tiles = {};            // 'x/y' → { state, data(解好的資料), chunk(模型), usedAt }
  var renderer = null, camera = null, threeState = 'none', mats = null;
  var queue = [], busy = 0;

  // ── 圖磚 ──
  function lon2x(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
  function lat2y(lat, z) { var r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z)); }
  function visibleTiles() {
    var m = window.map, b = m.getBounds(), out = [];
    var x0 = lon2x(b.getWest(), TILE_Z), x1 = lon2x(b.getEast(), TILE_Z), y0 = lat2y(b.getNorth(), TILE_Z), y1 = lat2y(b.getSouth(), TILE_Z);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 9) return out;   // 太傾斜、看太遠：不抓
    for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) out.push(x + '/' + y);
    return out;
  }

  // ── 資料 ──
  function loadIndex(cb) {
    if (indexState === 'ready' || indexState === 'failed') return cb();
    if (indexState === 'loading') return setTimeout(function () { loadIndex(cb); }, 200);
    indexState = 'loading';
    fetch(DATA_DIR + 'index.json').then(function (r) { return r.json(); }).then(function (list) {
      index = {}; list.forEach(function (k) { index[k] = 1; }); indexState = 'ready'; cb();
    }).catch(function () { indexState = 'failed'; cb(); });
  }
  function fetchTile(key) {
    var f = key.replace('/', '_');
    if (index && !index[f]) return Promise.resolve(null);   // 這塊沒有國道、快速道路
    return fetch(DATA_DIR + TILE_Z + '/' + f + '.json').then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  function pump() {
    while (busy < 2 && queue.length) {
      var key = queue.shift(), t = tiles[key];
      if (!t || t.state !== 'queued') continue;
      busy++; t.state = 'loading';
      (function (key, t) {
        loadIndex(function () {
          fetchTile(key).then(function (j) {
            t.data = j && j.f === 2 ? decode(j) : null; t.state = 'ready';
          }).catch(function () { t.state = 'failed'; t.retryAt = Date.now() + 60000; }).then(function () {
            busy--;
            if (t.data && threeState === 'ready') { t.chunk = buildChunk(t.data); t.usedAt = Date.now(); }
            if (window.map) window.map.triggerRepaint();
            if (t.data && window._snmOnRoad3dData) window._snmOnRoad3dData();   // 電子看板門架對準路面
            pump();
          });
        });
      })(key, t);
    }
  }

  // ── 解資料 ──
  function undelta(a, stride) { var o = a.slice(); for (var i = stride; i < o.length; i++) o[i] += o[i - stride]; return o; }
  function perV(val, n) {
    if (typeof val === 'number') { var a = new Array(n); for (var i = 0; i < n; i++) a[i] = val / 100; return a; }
    return undelta(val, 1).map(function (x) { return x / 100; });
  }
  function decode(j) {
    var mc = maplibregl.MercatorCoordinate.fromLngLat(j.o, 0), sc = mc.meterInMercatorCoordinateUnits();
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    var pieces = j.p.map(function (p) {
      var v = undelta(p.v, 3), n = v.length / 3, P = [];
      for (var i = 0; i < n; i++) {
        var x = v[i * 3] / 100, y = v[i * 3 + 1] / 100;
        P.push([x, y, v[i * 3 + 2] / 100]);
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      return {
        P: P, n: n, i0: p.pre, i1: n - 1 - p.post, S: undelta(p.s, 1).map(function (x) { return x / 100; }),
        eL: perV(p.e[0], n), a: perV(p.e[1], n), b: perV(p.e[2], n), eR: perV(p.e[3], n), link: !!p.lk, oneway: !!p.ow,
        L: p.L.map(function (l) { return { t: l.t, w: l.w / 100, d: l.d, o: perV(l.o, n), v: l.v.map(function (x) { return x / 100; }) }; }),
        R: p.R.map(function (r) { return { t: r.t, sd: r.sd, o: perV(r.o, n), v: r.v.map(function (x) { return x / 100; }) }; }),
      };
    });
    var corner = function (x, y) { return new maplibregl.MercatorCoordinate(mc.x + x * sc, mc.y + y * sc, 0).toLngLat(); };
    var nw = corner(minX - 30, minY - 30), se = corner(maxX + 30, maxY + 30);
    return { o: j.o, mc: mc, sc: sc, pieces: pieces, gores: j.g || [], caps: j.c || [],
      box: { w: nw.lng, n: nw.lat, e: se.lng, s: se.lat } };
  }

  // ── 模型 ──
  function Bucket() { this.p = []; }
  Bucket.prototype.tri = function (a, b, c) { this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); };
  Bucket.prototype.quad = function (a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); };

  // 頂點的右手方向(斜接，最多放大 2 倍)；x 往東、y 往南
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

  function buildPiece(pc, B) {
    var P = pc.P, S = pc.S, R = rights(P);
    var lerp = function (a, b, t) { return a + (b - a) * t; };
    // 第 k 段、比例 t、橫向偏移 off(數列)、往上 dy 的點 → three.js 座標(x 東、y 上、z 南)
    var at = function (k, t, off, dy) {
      var o = lerp(off[k], off[k + 1], t), rx = lerp(R[k][0], R[k + 1][0], t), ry = lerp(R[k][1], R[k + 1][1], t);
      return [lerp(P[k][0], P[k + 1][0], t) + rx * o, lerp(P[k][2], P[k + 1][2], t) + dy, lerp(P[k][1], P[k + 1][1], t) + ry * o];
    };
    var shiftArr = function (arr, d) { return arr.map(function (x) { return x + d; }); };
    // 看得到的區間 vis([s0, s1, ...]) 跟每一段重疊的部分：fn(k, t0, t1)
    var spans = function (vis, fn) {
      for (var k = pc.i0; k < pc.i1; k++) {
        var s0 = S[k], s1 = S[k + 1], len = s1 - s0;
        if (len <= 0) continue;
        for (var j = 0; j < vis.length; j += 2) {
          var u0 = Math.max(vis[j], s0), u1 = Math.min(vis[j + 1], s1);
          if (u1 - u0 > 0.01) fn(k, (u0 - s0) / len, (u1 - s0) / len, u0, u1);
        }
      }
    };
    // 路面
    for (var k = pc.i0; k < pc.i1; k++) {
      B.asphalt.quad(at(k, 0, pc.eL, 0.03), at(k, 0, pc.eR, 0.03), at(k, 1, pc.eR, 0.03), at(k, 1, pc.eL, 0.03));
      if (P[k][2] > 0.3 && P[k + 1][2] > 0.3) {   // 橋：橋面版側邊
        [pc.eL, pc.eR].forEach(function (e) { B.concrete.quad(at(k, 0, e, 0.03), at(k, 1, e, 0.03), at(k, 1, e, -0.3), at(k, 0, e, -0.3)); });
      }
    }
    // 標線、路況綠線
    pc.L.forEach(function (l) {
      var bk = l.t === 'y' ? B.yellow : l.t === 'g' ? B.green : l.t === 'g2' ? B.greenEdge : B.white;
      var dy = l.t === 'g' ? 0.08 : l.t === 'g2' ? 0.07 : 0.06, lo = shiftArr(l.o, -l.w / 2), hi = shiftArr(l.o, l.w / 2);
      spans(l.v, function (k, t0, t1, u0, u1) {
        if (!l.d) { bk.quad(at(k, t0, lo, dy), at(k, t0, hi, dy), at(k, t1, hi, dy), at(k, t1, lo, dy)); return; }
        var len = S[k + 1] - S[k];
        for (var st = Math.floor(u0 / PERIOD) * PERIOD; st < u1; st += PERIOD) {   // 沿路距離算虛線，跨路段、跨圖磚都接得上
          var d0 = Math.max(st, u0), d1 = Math.min(st + DASH, u1);
          if (d1 - d0 < 0.05) continue;
          var a = (d0 - S[k]) / len, b = (d1 - S[k]) / len;
          bk.quad(at(k, a, lo, dy), at(k, a, hi, dy), at(k, b, hi, dy), at(k, b, lo, dy));
        }
      });
    });
    // 護欄：profile = [[往外偏移, 高度], ...] 沿線拉出來
    var WBEAM = [[0, 0.45], [0.06, 0.53], [0, 0.6], [0.06, 0.68], [0, 0.76]];
    var JERSEY = [[0, 0], [0.05, 0.08], [0.18, 0.33], [0.24, 0.85], [0.42, 0.85], [0.48, 0.33], [0.61, 0.08], [0.66, 0]];
    var PARAPET = [[0, 0], [0.04, 0.95], [0.3, 0.95], [0.3, 0]];
    pc.R.forEach(function (r) {
      var prof = r.t === 'nj' ? JERSEY : r.t === 'pp' ? PARAPET : WBEAM, bk = r.t === 'wb' ? B.steel : B.concrete;
      var offs = prof.map(function (q) { return shiftArr(r.o, r.sd * q[0]); });
      spans(r.v, function (k, t0, t1, u0, u1) {
        for (var j = 0; j < prof.length - 1; j++) {
          bk.quad(at(k, t0, offs[j], prof[j][1]), at(k, t0, offs[j + 1], prof[j + 1][1]), at(k, t1, offs[j + 1], prof[j + 1][1]), at(k, t1, offs[j], prof[j][1]));
        }
        if (r.t !== 'wb') return;
        // 立柱：每 4 公尺一根
        var len = S[k + 1] - S[k], po = shiftArr(r.o, r.sd * 0.12);
        for (var st = Math.ceil(u0 / 4) * 4; st < u1; st += 4) {
          var t = (st - S[k]) / len, c = at(k, t, po, 0), dx = P[k + 1][0] - P[k][0], dz = P[k + 1][1] - P[k][1], dl = Math.hypot(dx, dz) || 1;
          var f = [dx / dl * 0.07, dz / dl * 0.07], g = [-dz / dl * 0.07, dx / dl * 0.07], top = c[1] + 0.78;
          var cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function (q) { return [c[0] + f[0] * q[0] + g[0] * q[1], c[2] + f[1] * q[0] + g[1] * q[1]]; });
          for (var e = 0; e < 4; e++) {
            var A = cs[e], C2 = cs[(e + 1) % 4];
            B.steel.quad([A[0], c[1], A[1]], [C2[0], c[1], C2[1]], [C2[0], top, C2[1]], [A[0], top, A[1]]);
          }
          B.steel.quad([cs[0][0], top, cs[0][1]], [cs[1][0], top, cs[1][1]], [cs[2][0], top, cs[2][1]], [cs[3][0], top, cs[3][1]]);
        }
      });
    });
  }

  function buildChunk(d) {
    var T = window.THREE;
    var B = { asphalt: new Bucket(), concrete: new Bucket(), steel: new Bucket(), white: new Bucket(), yellow: new Bucket(), greenEdge: new Bucket(), green: new Bucket() };
    d.pieces.forEach(function (pc) { if (pc.i1 > pc.i0) buildPiece(pc, B); });
    // 路的頭尾補圓形路面(分岔、匯流處接縫平順)
    d.caps.forEach(function (c) {
      var x = c[0] / 100, y = c[1] / 100, z = c[2] / 100, r = c[3] / 100, seg = 16;
      for (var j = 0; j < seg; j++) {
        var a0 = j / seg * Math.PI * 2, a1 = (j + 1) / seg * Math.PI * 2;
        B.asphalt.tri([x, z, y], [x + Math.cos(a0) * r, z, y + Math.sin(a0) * r], [x + Math.cos(a1) * r, z, y + Math.sin(a1) * r]);
      }
    });
    // 槽化線
    d.gores.forEach(function (g) {
      var q = []; for (var i = 0; i < 4; i++) q.push([g[i * 3] / 100, g[i * 3 + 2] / 100, g[i * 3 + 1] / 100]);
      B.white.quad(q[0], q[1], q[2], q[3]);
    });
    var scene = new T.Scene(), any = false;
    scene.add(new T.AmbientLight(0xffffff, 0.62));
    var sun = new T.DirectionalLight(0xffffff, 0.6); sun.position.set(0.4, 1, 0.6); scene.add(sun);
    var fill = new T.DirectionalLight(0xffffff, 0.22); fill.position.set(-0.6, 0.4, -0.5); scene.add(fill);
    Object.keys(B).forEach(function (k) {
      if (!B[k].p.length) return;
      var g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(B[k].p, 3));
      g.computeVertexNormals();
      var mesh = new T.Mesh(g, mats[k]);
      mesh.renderOrder = { white: 2, yellow: 2, greenEdge: 3, green: 4 }[k] || 0;
      mesh.frustumCulled = false;   // 不要讓 three.js 自己判斷在不在畫面裡(疊在地圖上時放大、傾斜會誤判成看不到而消失)
      scene.add(mesh); any = true;
    });
    if (!any) return null;
    var mc = d.mc, sc = d.sc;
    var matrix = new T.Matrix4().makeTranslation(mc.x, mc.y, mc.z).scale(new T.Vector3(sc, -sc, sc))
      .multiply(new T.Matrix4().makeRotationAxis(new T.Vector3(1, 0, 0), Math.PI / 2));
    return { scene: scene, matrix: matrix, box: d.box };
  }
  function disposeChunk(c) { if (c) c.scene.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); }
  function makeMats() {
    var T = window.THREE, ds = T.DoubleSide;
    var mark = function (color) { return new T.MeshBasicMaterial({ color: color, side: ds, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }); };
    mats = {
      asphalt: new T.MeshLambertMaterial({ color: 0x4A4D52, side: ds }),
      concrete: new T.MeshLambertMaterial({ color: 0xCFCCC4, side: ds }),
      steel: new T.MeshPhongMaterial({ color: 0xC4CACF, specular: 0x8A8F94, shininess: 60, side: ds }),
      white: mark(0xF4F4F4),
      yellow: mark(0xF2BE1A),
      greenEdge: mark(0x009B65),   // 路況綠線(同導航路線的顏色)：外框
      green: mark(0x16E098),
    };
  }

  // ── 圖層 ──
  var customLayer = {
    id: LAYER, type: 'custom', renderingMode: '3d',
    onAdd: function (map, gl) {
      var T = window.THREE;
      camera = new T.Camera();
      renderer = new T.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    render: function (gl, matrix) {
      var m = window.map;
      if (!renderer || m.getZoom() < MIN_ZOOM) return;
      var gv = m.getLayer('snm-roads-line-freeway') ? m.getLayoutProperty('snm-roads-line-freeway', 'visibility') !== 'none' : true;
      if (mats && mats.green.visible !== gv) { mats.green.visible = gv; mats.greenEdge.visible = gv; }   // 路況綠線跟著主程式的開關
      var T = window.THREE, mapM = new T.Matrix4().fromArray(matrix), b = m.getBounds();
      Object.keys(tiles).forEach(function (k) {
        var c = tiles[k].chunk;
        if (!c || c.box.e < b.getWest() || c.box.w > b.getEast() || c.box.n < b.getSouth() || c.box.s > b.getNorth()) return;
        camera.projectionMatrix = mapM.clone().multiply(c.matrix);
        renderer.resetState();
        renderer.render(c.scene, camera);
      });
    }
  };
  // 放在路況綠線、導航路線的下面(路況顏色、導航路線還是看得到)
  function beforeId(m) {
    var ids = ['snm-roads-outline-minor', 'navRoute-outline', 'snm-traffic-casing', 'navRoute-arrows', 'user-car'];
    for (var i = 0; i < ids.length; i++) if (m.getLayer(ids[i])) return ids[i];
    return undefined;
  }
  function addLayer() {
    var m = window.map;
    if (!m || !window.THREE || m.getLayer(LAYER)) return;
    if (!mats) makeMats();
    m.addLayer(customLayer, beforeId(m));
    arrange();
  }
  // 圖層順序(主程式的路線圖層排序也照這個)：一般道路綠線 → 3D 路面 → 國道綠線 → 陸橋綠線
  // 從國道底下穿過的一般道路不會畫在國道路面上；本身是橋的一般道路(從國道上方跨過的陸橋)另外畫一份在上面
  var OVER = 'snm-road-3d-over', arranged = null;
  function arrange() {
    var m = window.map;
    if (!m || !m.getLayer(LAYER) || !m.getLayer('snm-roads-line-main') || !m.getLayer('snm-roads-outline-freeway')) return;
    // 主程式照 window._snmRoad3dActive 排路線圖層(放大到 3D 才把一般道路綠線排到國道下面)
    var on = m.getZoom() >= MIN_ZOOM;
    if (window._snmRoad3dActive !== on) { window._snmRoad3dActive = on; if (window.snmSinkRouteLayers) window.snmSinkRouteLayers(); }
    var order = (m.style && m.style._order) || [];
    if (on && order.indexOf(LAYER) !== order.indexOf('snm-roads-outline-freeway') - 1) m.moveLayer(LAYER, 'snm-roads-outline-freeway');
    if (on) {
      if (!m.getLayer(OVER + '-casing')) {
        var cls = ['match', ['get', 'class'], ['primary', 'secondary', 'tertiary', 'minor', 'service'], true, false];
        var filter = ['all', cls, ['==', ['get', 'brunnel'], 'bridge']];
        var src = m.getLayer('snm-roads-line-main');
        m.addLayer({ id: OVER + '-casing', type: 'line', source: src.source, 'source-layer': src.sourceLayer, minzoom: MIN_ZOOM, filter: filter,
          layout: { 'line-cap': 'butt', 'line-join': 'round' }, paint: { 'line-color': m.getPaintProperty('snm-roads-outline-main', 'line-color') || '#009B65', 'line-width': 15, 'line-opacity': 0.9 } }, 'snm-roads-outline-freeway');
        m.addLayer({ id: OVER + '-line', type: 'line', source: src.source, 'source-layer': src.sourceLayer, minzoom: MIN_ZOOM, filter: filter,
          layout: { 'line-cap': 'butt', 'line-join': 'round' }, paint: { 'line-color': m.getPaintProperty('snm-roads-line-main', 'line-color') || '#16E098', 'line-width': 11, 'line-opacity': 0.95 } }, 'snm-roads-outline-freeway');
      }
    }
    // 底圖自己畫的國道、快速道路線(很寬的米黃色帶)：3D 路面出現時隱藏，不然會從兩個方向車道中間的空地露出來(隧道照舊)
    (m.getStyle().layers || []).forEach(function (l) {
      if (l.source !== 'openmaptiles' || l.type !== 'line' || !/^(road|bridge)_.*(motorway|trunk)/.test(l.id)) return;
      if (m.getPaintProperty(l.id, 'line-opacity') !== undefined) return;   // 已經設過(或底圖本來有設)
      m.setPaintProperty(l.id, 'line-opacity', ['step', ['zoom'], 1, MIN_ZOOM, ['case', ['match', ['get', 'class'], ['motorway', 'trunk'], true, false], 0, 1]]);
    });
    // 平面的國道路況綠線在 3D 路面出現時隱藏：改畫在 3D 路面上(跟著曲線、高架，不會亂穿過匝道)
    [['snm-roads-outline-freeway', 0], ['snm-roads-line-freeway', 0]].forEach(function (x) {
      var id = x[0], cur = m.getPaintProperty(id, 'line-width');
      if (typeof cur === 'number') m.setPaintProperty(id, 'line-width', ['step', ['zoom'], cur, MIN_ZOOM, x[1]]);
    });
    // 陸橋那份跟著一般道路綠線的顯示 / 隱藏
    var vis = m.getLayoutProperty('snm-roads-line-main', 'visibility') || 'visible';
    [OVER + '-casing', OVER + '-line'].forEach(function (id) { if (m.getLayer(id) && m.getLayoutProperty(id, 'visibility') !== vis) m.setLayoutProperty(id, 'visibility', vis); });
    arranged = true;
  }
  function ensureThree(cb) {
    if (window.THREE) { threeState = 'ready'; cb(); return; }
    if (threeState === 'loading' || threeState === 'failed') return;
    threeState = 'loading';
    var sc = document.createElement('script'); sc.src = THREE_URL;
    sc.onload = function () { threeState = window.THREE ? 'ready' : 'failed'; if (window.THREE) cb(); };
    sc.onerror = function () { threeState = 'failed'; };
    document.head.appendChild(sc);
  }
  function check() {
    var m = window.map;
    if (!m) return;
    if (m.getZoom() < MIN_ZOOM) { if (arranged) arrange(); return; }
    ensureThree(function () {
      addLayer(); arrange();
      var now = Date.now();
      visibleTiles().forEach(function (k) {
        var t = tiles[k];
        if (!t) { t = tiles[k] = { state: 'queued', data: null, chunk: null }; queue.push(k); }
        else if (t.state === 'failed' && now > t.retryAt) { t.state = 'queued'; queue.push(k); }
        t.usedAt = now;
      });
      // 模型被丟掉的，畫面裡有就重建
      var b = m.getBounds();
      Object.keys(tiles).forEach(function (k) {
        var t = tiles[k], e = t.data && t.data.box;
        if (t.chunk || !e || e.e < b.getWest() || e.w > b.getEast() || e.n < b.getSouth() || e.s > b.getNorth()) return;
        t.chunk = buildChunk(t.data); t.usedAt = now;
      });
      // 太多塊就丟掉最久沒看的模型(資料留著，回來再建)
      var built = Object.keys(tiles).filter(function (k) { return tiles[k].chunk; }).sort(function (a, b2) { return tiles[a].usedAt - tiles[b2].usedAt; });
      while (built.length > MAX_CHUNKS) { var k0 = built.shift(); disposeChunk(tiles[k0].chunk); tiles[k0].chunk = null; }
      pump();
    });
  }
  // 換地圖樣式後圖層會被清掉，重加
  window._snmReloadRoad3d = function () {
    if (window.map && !window.map.getLayer(LAYER)) renderer = null;   // 圖層真的被換樣式清掉了才重建
    arranged = null;
    if (window.THREE && window.map && window.map.getZoom() >= MIN_ZOOM) addLayer();
  };
  // 某個位置、行車方向上的國道主線：回傳投影到中心線的位置、那段的方向、路面全寬(找不到回 null)；電子看板門架用
  window._snmRoad3dFit = function (lon, lat, bearing) {
    var best = null;
    Object.keys(tiles).forEach(function (k) {
      var d = tiles[k].data;
      if (!d) return;
      var M = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0), qx = (M.x - d.mc.x) / d.sc, qy = (M.y - d.mc.y) / d.sc;
      d.pieces.forEach(function (pc) {
        if (pc.link || !pc.oneway) return;
        for (var i = pc.i0; i < pc.i1; i++) {
          var A = pc.P[i], B2 = pc.P[i + 1], dx = B2[0] - A[0], dy = B2[1] - A[1], L2 = dx * dx + dy * dy;
          if (!L2 || Math.min(Math.abs(A[0] - qx), Math.abs(B2[0] - qx)) > 400 || Math.min(Math.abs(A[1] - qy), Math.abs(B2[1] - qy)) > 400) continue;
          var t = Math.max(0, Math.min(1, ((qx - A[0]) * dx + (qy - A[1]) * dy) / L2)), px = A[0] + dx * t, py = A[1] + dy * t, dist = Math.hypot(qx - px, qy - py);
          if (dist > 45 || (best && dist >= best.d)) continue;
          var brg = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;   // y 往南
          if (Math.abs(((brg - bearing) % 360 + 540) % 360 - 180) > 50) continue;
          var ll = new maplibregl.MercatorCoordinate(d.mc.x + px * d.sc, d.mc.y + py * d.sc, 0).toLngLat();
          best = { d: dist, lon: ll.lng, lat: ll.lat, bearing: brg, W: pc.eR[i] - pc.eL[i] };
        }
      });
    });
    return best;
  };
  window._snmRoad3dState = function () { return { tiles: tiles, threeState: threeState }; };   // 除錯用
  var timer = null;
  function init() {
    var m = window.map;
    if (!m) { setTimeout(init, 500); return; }
    m.on('styledata', function () { if (arranged) arrange(); });   // 主程式重排路線圖層後，3D 路面放回一般道路與國道綠線中間
    var go = function () { m.on('moveend', function () { clearTimeout(timer); timer = setTimeout(check, 250); }); check(); };
    if (m.loaded()) go(); else m.once('load', go);
  }
  init();
})();
