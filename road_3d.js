// ===== 🛣 國道、快速道路 3D 路面(第 1 階段：主線) =====
// 放大到 zoom 16 以上，把國道、快速道路的主線畫成立體道路(匝道是第 2 階段)。
// 資料(road3d/，tools/build-road3d.js 產生)在電腦上已經全部算好：貝茲曲線的曲線點、每點路寬、高度、接縫方向、哪段護欄不畫，
// 這裡只照著畫：
//   - 路面：深灰色柏油；車道 3.75 公尺、內側路肩 1、外側路肩 3 公尺(電腦算好的路寬)
//   - 標線：內側黃實線、外側白實線(寬 15 公分)、車道白色虛線(劃 4 公尺、空 6 公尺)；雙向道路中央雙黃線
//   - 中央分隔：紐澤西水泥護欄＋綠色防眩板(主線往左多鋪 0.4 公尺，跟對向之間的空隙鋪滿)
//   - 外側：平地鋼板護欄(W 型鋼板＋每 4 公尺一根立柱)、橋上紐澤西水泥護欄；會落在別條路上的那段不畫
//   - 橋：第 1 階段只微抬(每層 1.2 公尺)，兩側有橋面版側邊
//   - 路燈：道路兩側外面每 50 公尺一支(有 3D 主線的地方由這裡立，lamps_3d.js 就不畫，不會對不上)
// 圖層放在路況綠線、導航路線的下面：路況顏色、導航路線、車子照樣畫在路面上看得到。
(function () {
  'use strict';
  var MIN_ZOOM = 16, TILE_Z = 13, MAX_CHUNKS = 16, LANE = 3.75, DASH = 4, GAP = 6, MEDIAN_FILL = 0.4;
  var THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  var LAYER = 'snm-road-3d', DATA_DIR = 'road3d/';
  var index = null, indexState = 'none', ways = {}, tiles = {}, queue = [], busy = 0;
  var renderer = null, camera = null, threeState = 'none', mats = null;

  // ── 圖磚 ──
  function lon2x(lon) { return Math.floor((lon + 180) / 360 * Math.pow(2, TILE_Z)); }
  function lat2y(lat) { var r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, TILE_Z)); }
  function visibleTiles() {
    var m = window.map, b = m.getBounds(), out = [];
    var x0 = lon2x(b.getWest()), x1 = lon2x(b.getEast()), y0 = lat2y(b.getNorth()), y1 = lat2y(b.getSouth());
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 9) return out;   // 太傾斜、看太遠：不抓
    for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) out.push(x + '_' + y);
    return out;
  }

  // ── 資料 ──
  // 每點的值：一個數字 = 整條一樣；陣列 = 第一個值之後存差值(公分)
  function perPoint(v, n, def) {
    var out = new Array(n), i;
    if (v == null) { for (i = 0; i < n; i++) out[i] = def; return out; }
    if (typeof v === 'number') { for (i = 0; i < n; i++) out[i] = v / 100; return out; }
    var acc = 0; for (i = 0; i < n; i++) { acc += v[i] || 0; out[i] = acc / 100; }
    return out;
  }
  function fromRecord(r) {
    var f = r[1], d = r[4], e = r[5] || {}, x = d[0], y = d[1], coords = [[x / 1e6, y / 1e6]];
    for (var i = 2; i < d.length; i += 2) { x += d[i]; y += d[i + 1]; coords.push([x / 1e6, y / 1e6]); }
    var n = coords.length, dd = e.d || [0, 0, 0, 0];
    return { id: r[0], cls: f & 2 ? 'trunk' : 'motorway', oneway: !!(f & 4), bridge: !!(f & 8), lanes: r[2], coords: coords,
      W: perPoint(e.w, n, 10), H: perPoint(e.z, n, 0), hide: e.h || [],
      dirB: dd[0] || dd[1] ? [dd[0] / 1e4, dd[1] / 1e4] : null, dirA: dd[2] || dd[3] ? [dd[2] / 1e4, dd[3] / 1e4] : null };
  }
  function loadIndex(cb) {
    if (indexState === 'ready' || indexState === 'failed') return cb();
    if (indexState === 'loading') return setTimeout(function () { loadIndex(cb); }, 200);
    indexState = 'loading';
    fetch(DATA_DIR + 'index.json').then(function (r) { return r.json(); }).then(function (list) {
      index = {}; list.forEach(function (k) { index[k] = 1; }); indexState = 'ready'; cb();
    }).catch(function () { indexState = 'failed'; cb(); });
  }
  function pump() {
    while (busy < 2 && queue.length) {
      var key = queue.shift(), t = tiles[key];
      if (!t || t.state !== 'queued') continue;
      busy++; t.state = 'loading';
      (function (key, t) {
        loadIndex(function () {
          var p = index && !index[key] ? Promise.resolve({ w: [] }) : fetch(DATA_DIR + TILE_Z + '/' + key + '.json').then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
          p.then(function (j) {
            // 跨圖磚的路：先抓到的那塊負責畫(只建一次)
            var list = (j.w || []).map(fromRecord).filter(function (w) { return !ways[w.id]; });
            list.forEach(function (w) { ways[w.id] = w; });
            t.ids = list.map(function (w) { return w.id; });
            var ext = { w: 180, e: -180, s: 90, n: -90 };
            list.forEach(function (w) { w.coords.forEach(function (c) { ext.w = Math.min(ext.w, c[0]); ext.e = Math.max(ext.e, c[0]); ext.s = Math.min(ext.s, c[1]); ext.n = Math.max(ext.n, c[1]); }); });
            t.ext = ext; t.state = 'ready';
          }).catch(function () { t.state = 'failed'; t.retryAt = Date.now() + 60000; t.ids = []; }).then(function () {
            busy--;
            if (t.chunk) disposeChunk(t.chunk);
            t.chunk = threeState === 'ready' && t.ids.length ? buildChunk(t) : null;
            if (window.map) window.map.triggerRepaint();
            pump();
          });
        });
      })(key, t);
    }
  }

  // ── 幾何 ──
  function Bucket() { this.p = []; }
  Bucket.prototype.tri = function (a, b, c) { this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); };
  Bucket.prototype.quad = function (a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); };
  var JERSEY = [[0, 0], [0.05, 0.08], [0.18, 0.33], [0.24, 0.85], [0.42, 0.85], [0.48, 0.33], [0.61, 0.08], [0.66, 0]];
  var WBEAM = [[0.06, 0.45], [0, 0.53], [0.06, 0.6], [0, 0.68], [0.06, 0.76]];   // 兩道凸起朝向車道

  function buildChunk(t) {
    var T = window.THREE, ext = t.ext;
    var origin = maplibregl.MercatorCoordinate.fromLngLat([(ext.w + ext.e) / 2, (ext.n + ext.s) / 2], 0), sc = origin.meterInMercatorCoordinateUnits();
    var B = { asphalt: new Bucket(), concrete: new Bucket(), steel: new Bucket(), glare: new Bucket(), lamp: new Bucket(), white: new Bucket(), yellow: new Bucket() };
    t.ids.forEach(function (id) { var w = ways[id]; if (w) buildWay(w, origin, sc, B); });
    var group = new T.Group(), any = false;
    Object.keys(B).forEach(function (k) {
      if (!B[k].p.length) return;
      var g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(B[k].p, 3));
      g.computeVertexNormals();
      var mesh = new T.Mesh(g, mats[k]);
      if (k === 'white' || k === 'yellow') mesh.renderOrder = 2;
      mesh.frustumCulled = false;   // 疊在地圖上時 three.js 自己判斷會誤判成看不到
      group.add(mesh); any = true;
    });
    if (!any) return null;
    var scene = new T.Scene();
    scene.add(new T.AmbientLight(0xffffff, 0.62));
    var sun = new T.DirectionalLight(0xffffff, 0.6); sun.position.set(0.4, 1, 0.6); scene.add(sun);
    var fill = new T.DirectionalLight(0xffffff, 0.22); fill.position.set(-0.6, 0.4, -0.5); scene.add(fill);
    scene.add(group);
    var matrix = new T.Matrix4().makeTranslation(origin.x, origin.y, origin.z).scale(new T.Vector3(sc, -sc, sc))
      .multiply(new T.Matrix4().makeRotationAxis(new T.Vector3(1, 0, 0), Math.PI / 2));
    return { scene: scene, matrix: matrix, box: ext };
  }

  function buildWay(w, origin, sc, B) {
    // 曲線點(電腦已經用貝茲曲線算好) → 這塊的公尺座標(x 東、z 南)
    var P = w.coords.map(function (c) { var m = maplibregl.MercatorCoordinate.fromLngLat(c, 0); return [(m.x - origin.x) / sc, (m.y - origin.y) / sc]; });
    var n = P.length, i;
    if (n < 2) return;
    // 接縫方向：資料是(東、北)，這裡是(東、南)
    var fr = window.RoadShape.frame(P, function (tx, tz) { return [-tz, tx]; }, w.dirB ? [w.dirB[0], -w.dirB[1]] : null, w.dirA ? [w.dirA[0], -w.dirA[1]] : null);
    var S = fr.S, segR = fr.seg, R = fr.R, L = S[n - 1], H = w.H, W = w.W;
    var hidden = { '1': [], '-1': [], '0': [] };
    for (i = 0; i + 2 < w.hide.length; i += 3) hidden[w.hide[i]].push([w.hide[i + 1] / 1e6 * L, w.hide[i + 2] / 1e6 * L]);
    var ov = function (o, k) { return typeof o === 'number' ? o : o[k]; };
    var plus = function (o, d) { return typeof o === 'number' ? o + d : o.map(function (v) { return v + d; }); };
    var pt = function (k, o, y) { var v = ov(o, k); return [P[k][0] + R[k][0] * v, H[k] + y, P[k][1] + R[k][1] * v]; };
    var at = function (k, t, o, y) {
      if (t <= 0) return pt(k, o, y);
      if (t >= 1) return pt(k + 1, o, y);
      var v = ov(o, k) + (ov(o, k + 1) - ov(o, k)) * t, r = segR[k];
      return [P[k][0] + (P[k + 1][0] - P[k][0]) * t + r[0] * v, H[k] + (H[k + 1] - H[k]) * t + y, P[k][1] + (P[k + 1][1] - P[k][1]) * t + r[1] * v];
    };
    var visible = function (k, side) {   // 第 k 段去掉不畫的部分，剩下的 [t0, t1]
      var s0 = S[k], s1 = S[k + 1], len = s1 - s0, out = [[s0, s1]];
      hidden[side].forEach(function (h) {
        var nx = [];
        out.forEach(function (r) { if (h[1] <= r[0] || h[0] >= r[1]) nx.push(r); else { if (h[0] > r[0]) nx.push([r[0], h[0]]); if (h[1] < r[1]) nx.push([h[1], r[1]]); } });
        out = nx;
      });
      return out.filter(function (r) { return r[1] - r[0] > 0.05; }).map(function (r) { return [(r[0] - s0) / (len || 1), (r[1] - s0) / (len || 1)]; });
    };
    var isHidden = function (side, s) { return hidden[side].some(function (h) { return s >= h[0] && s <= h[1]; }); };
    // 橫斷面：a / b = 最左 / 最右車道外緣
    var inner = w.oneway ? 1.0 : 1.5, outer = w.oneway ? 3.0 : 1.5;
    var half = W.map(function (v) { return v / 2; }), nhalf = W.map(function (v) { return -v / 2; });
    var a = W.map(function (v) { return -v / 2 + inner; }), b = W.map(function (v) { return v / 2 - outer; });
    var strip = function (bk, o1, o2, y) { for (var k = 0; k < n - 1; k++) bk.quad(pt(k, o1, y), pt(k, o2, y), pt(k + 1, o2, y), pt(k + 1, o1, y)); };
    var dashed = function (bk, o, wd, y, ok) {   // 每 10 公尺畫 4 公尺
      var period = DASH + GAP;
      for (var k = 0; k < n - 1; k++) {
        if (ok && !ok(k)) continue;
        var s0 = S[k], s1 = S[k + 1];
        for (var st = Math.floor(s0 / period) * period; st < s1; st += period) {
          var u0 = Math.max(st, s0), u1 = Math.min(st + DASH, s1);
          if (u1 - u0 < 0.2) continue;
          var t0 = Math.max(1e-9, (u0 - s0) / (s1 - s0)), t1 = Math.min(1 - 1e-9, (u1 - s0) / (s1 - s0)), h = wd / 2;
          bk.quad(at(k, t0, plus(o, -h), y), at(k, t0, plus(o, h), y), at(k, t1, plus(o, h), y), at(k, t1, plus(o, -h), y));
        }
      }
    };
    var wall = function (bk, o, side, profile, hs) {   // 沿線的牆(護欄)；hs = 用哪一邊的「不畫的段落」
      for (var k = 0; k < n - 1; k++) {
        var parts = hs == null ? [[0, 1]] : visible(k, hs);
        for (var q = 0; q < parts.length; q++) {
          for (var j = 0; j < profile.length - 1; j++) {
            var p0 = profile[j], p1 = profile[j + 1], o0 = plus(o, side * p0[0]), o1 = plus(o, side * p1[0]);
            bk.quad(at(k, parts[q][0], o0, p0[1]), at(k, parts[q][0], o1, p1[1]), at(k, parts[q][1], o1, p1[1]), at(k, parts[q][1], o0, p0[1]));
          }
        }
      }
    };
    var every = function (period, from, hs, fn) {   // 沿線每隔 period 公尺：fn(段, 比例)
      for (var k = 0; k < n - 1; k++) for (var st = Math.ceil((S[k] - from) / period) * period + from; st < S[k + 1]; st += period) {
        if (hs != null && isHidden(hs, st)) continue;
        fn(k, (st - S[k]) / ((S[k + 1] - S[k]) || 1));
      }
    };
    var post = function (bk, c, r, f, hw, y0, y1) {   // 方柱
      var cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function (q) { return [c[0] + r[0] * q[0] * hw + f[0] * q[1] * hw, c[1] + r[1] * q[0] * hw + f[1] * q[1] * hw]; });
      for (var e = 0; e < 4; e++) { var A = cs[e], C = cs[(e + 1) % 4]; bk.quad([A[0], y0, A[1]], [C[0], y0, C[1]], [C[0], y1, C[1]], [A[0], y1, A[1]]); }
      bk.quad([cs[0][0], y1, cs[0][1]], [cs[1][0], y1, cs[1][1]], [cs[2][0], y1, cs[2][1]], [cs[3][0], y1, cs[3][1]]);
    };
    var guardrail = function (o, side, hs) {   // 鋼板護欄：W 型鋼板＋每 4 公尺一根立柱(在鋼板後面)
      wall(B.steel, o, side, WBEAM, hs);
      every(4, 0, hs, function (k, tt) {
        var r = segR[k], f = [r[1], -r[0]], c = at(k, tt, plus(o, side * 0.12), 0);
        post(B.steel, [c[0], c[2]], r, f, 0.07, c[1], c[1] + 0.78);
      });
    };
    var onBridge = w.bridge;
    // 路面(主線往左多鋪 0.4 公尺：跟對向之間的空隙鋪滿)
    var deckL = w.oneway ? plus(nhalf, -MEDIAN_FILL) : nhalf;
    strip(B.asphalt, deckL, half, 0.03);
    if (onBridge) {   // 橋：路面兩側的橋面版側邊
      wall(B.concrete, deckL, -1, [[0, 0.03], [0, -0.5]]);
      wall(B.concrete, half, 1, [[0, 0.03], [0, -0.5]]);
    }
    var my = 0.06;
    var edge = function (o, side, hs) {   // 外側：橋上紐澤西水泥護欄(外緣貼齊路面邊緣)、平地鋼板護欄
      if (onBridge) wall(B.concrete, plus(o, -0.36 * side), side, JERSEY, hs); else guardrail(o, side, hs);
    };
    if (w.oneway) {
      strip(B.yellow, a, plus(a, 0.15), my);   // 內側黃實線
      strip(B.white, plus(b, -0.15), b, my);   // 外側白實線
      for (var k2 = 1; k2 < w.lanes; k2++) (function (kk) {   // 車道線：車道數漸變時，窄掉的那條不畫
        dashed(B.white, plus(a, kk * LANE), 0.15, my, function (k) { return a[k] + kk * LANE < b[k] - 1 && a[k + 1] + kk * LANE < b[k + 1] - 1; });
      })(k2);
      edge(plus(half, -0.3), 1, '1');
      // 中央分隔：紐澤西水泥護欄＋綠色防眩板(每 1 公尺一片、斜 60 度、0.85～1.5 公尺高)
      var med = plus(nhalf, -0.1);
      wall(B.concrete, med, 1, JERSEY, '0');
      every(1, 0.5, '0', function (k, tt) {
        var r = segR[k], f = [r[1], -r[0]], c = at(k, tt, plus(med, 0.33), 0), y0 = c[1] + 0.85, y1 = c[1] + 1.5;
        var u = [f[0] * 0.5 + r[0] * 0.866, f[1] * 0.5 + r[1] * 0.866], v = [-u[1], u[0]];
        var cs = [[-0.11, -0.015], [0.11, -0.015], [0.11, 0.015], [-0.11, 0.015]].map(function (q) { return [c[0] + u[0] * q[0] + v[0] * q[1], c[2] + u[1] * q[0] + v[1] * q[1]]; });
        for (var e = 0; e < 4; e++) { var A = cs[e], C = cs[(e + 1) % 4]; B.glare.quad([A[0], y0, A[1]], [C[0], y0, C[1]], [C[0], y1, C[1]], [A[0], y1, A[1]]); }
      });
    }
    if (!w.oneway) {
      var per = Math.max(1, Math.floor(w.lanes / 2)), hl = per * LANE;
      strip(B.yellow, 0.06, 0.18, my); strip(B.yellow, -0.18, -0.06, my);   // 中央雙黃線
      strip(B.white, hl - 0.15, hl, my); strip(B.white, -hl, -hl + 0.15, my);
      for (var k3 = 1; k3 < per; k3++) { dashed(B.white, k3 * LANE, 0.15, my); dashed(B.white, -k3 * LANE, 0.15, my); }
      edge(plus(half, -0.3), 1, '1');
      edge(plus(nhalf, 0.3), -1, '-1');
    }
    // 路燈：立在道路兩側外面(單行道立在自己右邊外側 → 上下行合起來就是整條路兩側；雙向道路兩邊都立)，每 50 公尺一支；
    //   平地在鋼板護欄外 0.6 公尺、橋上在外側水泥護欄頂上；護欄不畫的地方(接到別條路)不立
    (w.oneway ? [1] : [1, -1]).forEach(function (side) {
      for (var sl = side > 0 ? 25 : 50; sl < L - 10; sl += 50) {
        var kl = 0; while (kl < n - 2 && S[kl + 1] < sl) kl++;
        var tl = (sl - S[kl]) / ((S[kl + 1] - S[kl]) || 1);
        if (isHidden(side > 0 ? '1' : '-1', sl)) continue;
        var e = side > 0 ? half[kl] + (half[kl + 1] - half[kl]) * tl : nhalf[kl] + (nhalf[kl + 1] - nhalf[kl]) * tl;
        var r = segR[kl], f = [r[1], -r[0]], base = at(kl, tl, onBridge ? e - side * 0.33 : e + side * 0.6, onBridge ? 0.85 : 0);
        lamp(B, base, [-r[0] * side, -r[1] * side], f);   // 燈臂伸向車道
      }
    });
  }

  // ── 路燈：圓的鋼管燈桿(下粗上細)＋底座，往上彎再伸向車道的燈臂，扁長 LED 燈頭(朝下發光) ──
  function tube(bk, a0, a1, r0, r1) {
    var d = [a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]], L0 = Math.hypot(d[0], d[1], d[2]) || 1;
    d = [d[0] / L0, d[1] / L0, d[2] / L0];
    var u = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    var e1 = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]], l1 = Math.hypot(e1[0], e1[1], e1[2]); e1 = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
    var e2 = [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]];
    var ring = function (c, r) { var o = []; for (var q = 0; q < 8; q++) { var t = q / 8 * Math.PI * 2, cs = Math.cos(t) * r, sn = Math.sin(t) * r; o.push([c[0] + e1[0] * cs + e2[0] * sn, c[1] + e1[1] * cs + e2[1] * sn, c[2] + e1[2] * cs + e2[2] * sn]); } return o; };
    var A0 = ring(a0, r0), A1 = ring(a1, r1);
    for (var q = 0; q < 8; q++) bk.quad(A0[q], A0[(q + 1) % 8], A1[(q + 1) % 8], A1[q]);
  }
  function lamp(B, base, r, f) {   // base = 燈桿底 [x, y, z]；r = 燈臂伸出去的方向；f = 沿路方向
    var x = base[0], y0 = base[1], z = base[2], top = y0 + 11, reach = 2.6;
    var P1 = [x, top - 0.6, z];
    tube(B.steel, [x, y0, z], P1, 0.13, 0.08);
    var cs0 = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function (q) { return [x + r[0] * q[0] * 0.25 + f[0] * q[1] * 0.25, z + r[1] * q[0] * 0.25 + f[1] * q[1] * 0.25]; });
    for (var e = 0; e < 4; e++) { var c0 = cs0[e], c1 = cs0[(e + 1) % 4]; B.steel.quad([c0[0], y0, c0[1]], [c1[0], y0, c1[1]], [c1[0], y0 + 0.12, c1[1]], [c0[0], y0 + 0.12, c0[1]]); }
    var out = function (dist, y) { return [x + r[0] * dist, y, z + r[1] * dist]; };
    var A1 = out(0.35, top - 0.15), A2 = out(1.0, top + 0.05), A3 = out(reach, top + 0.12);
    tube(B.steel, P1, A1, 0.08, 0.065); tube(B.steel, A1, A2, 0.065, 0.055); tube(B.steel, A2, A3, 0.055, 0.05);
    var hx = A3[0] + r[0] * 0.4, hz = A3[2] + r[1] * 0.4, hy = A3[1];
    var hc = [[-0.55, -0.17], [0.55, -0.17], [0.55, 0.17], [-0.55, 0.17]].map(function (q) { return [hx + r[0] * q[0] + f[0] * q[1], hz + r[1] * q[0] + f[1] * q[1]]; });
    B.steel.quad([hc[0][0], hy + 0.08, hc[0][1]], [hc[1][0], hy + 0.06, hc[1][1]], [hc[2][0], hy + 0.06, hc[2][1]], [hc[3][0], hy + 0.08, hc[3][1]]);
    for (var k = 0; k < 4; k++) { var d0 = hc[k], d1 = hc[(k + 1) % 4]; B.steel.quad([d0[0], hy - 0.04, d0[1]], [d1[0], hy - 0.04, d1[1]], [d1[0], hy + 0.07, d1[1]], [d0[0], hy + 0.07, d0[1]]); }
    B.lamp.quad([hc[0][0], hy - 0.045, hc[0][1]], [hc[3][0], hy - 0.045, hc[3][1]], [hc[2][0], hy - 0.045, hc[2][1]], [hc[1][0], hy - 0.045, hc[1][1]]);
  }
  function disposeChunk(c) { if (c) c.scene.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); }
  function makeMats() {
    var T = window.THREE, ds = T.DoubleSide;
    var mark = function (color) { return new T.MeshBasicMaterial({ color: color, side: ds, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }); };
    mats = {
      asphalt: new T.MeshLambertMaterial({ color: 0x4A4D52, side: ds }),
      concrete: new T.MeshLambertMaterial({ color: 0xCFCCC4, side: ds }),
      steel: new T.MeshPhongMaterial({ color: 0xC4CACF, specular: 0x8A8F94, shininess: 60, side: ds }),
      glare: new T.MeshLambertMaterial({ color: 0x3F8A55, side: ds }),
      lamp: new T.MeshBasicMaterial({ color: 0xFFF3C4, side: ds }),   // 路燈燈面(看起來是亮的)
      white: mark(0xF4F4F4), yellow: mark(0xF2BE1A)
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
  // 放在路況綠線、導航路線的下面(路況顏色、導航路線、車子還是看得到)
  function beforeId(m) {
    var ids = ['snm-roads-outline-minor', 'navRoute-outline', 'snm-traffic-casing', 'navRoute-arrows', 'user-car'];
    for (var i = 0; i < ids.length; i++) if (m.getLayer(ids[i])) return ids[i];
    return undefined;
  }
  function ensureThree(cb) {
    if (window.THREE) { threeState = 'ready'; cb(); return; }
    if (threeState === 'loading' || threeState === 'failed') return;
    threeState = 'loading';
    var s = document.createElement('script'); s.src = THREE_URL;
    s.onload = function () { threeState = window.THREE ? 'ready' : 'failed'; if (window.THREE) cb(); };
    s.onerror = function () { threeState = 'failed'; };
    document.head.appendChild(s);
  }
  function check() {
    var m = window.map;
    if (!m || m.getZoom() < MIN_ZOOM || !window.RoadShape) return;
    ensureThree(function () {
      if (!mats) makeMats();
      if (!m.getLayer(LAYER)) m.addLayer(customLayer, beforeId(m));
      var now = Date.now();
      visibleTiles().forEach(function (k) {
        var t = tiles[k];
        if (!t) { t = tiles[k] = { state: 'queued', ids: [], chunk: null }; queue.push(k); }
        else if (t.state === 'failed' && now > t.retryAt) { t.state = 'queued'; queue.push(k); }
        t.usedAt = now;
      });
      // 模型被丟掉的，路有在畫面裡就重建
      var b = m.getBounds();
      Object.keys(tiles).forEach(function (k) {
        var t = tiles[k], e = t.ext;
        if (t.chunk || !t.ids.length || !e || e.e < b.getWest() || e.w > b.getEast() || e.n < b.getSouth() || e.s > b.getNorth()) return;
        t.chunk = buildChunk(t); t.usedAt = now;
      });
      // 太多塊就丟掉最久沒看的模型(資料留著，回來再建)
      var built = Object.keys(tiles).filter(function (k) { return tiles[k].chunk; }).sort(function (x, y) { return tiles[x].usedAt - tiles[y].usedAt; });
      while (built.length > MAX_CHUNKS) { var k0 = built.shift(); disposeChunk(tiles[k0].chunk); tiles[k0].chunk = null; }
      pump();
    });
  }
  // 換地圖樣式後圖層會被清掉，重加
  window._snmReloadRoad3d = function () { renderer = null; var m = window.map; if (window.THREE && m && m.getZoom() >= MIN_ZOOM && mats && !m.getLayer(LAYER)) m.addLayer(customLayer, beforeId(m)); };
  window._snmRoad3dState = function () { return { tiles: tiles, ways: ways, threeState: threeState }; };   // 除錯用
  function init() {
    var m = window.map;
    if (!m) { setTimeout(init, 500); return; }
    var timer = null, lastMove = 0;
    var go = function () {
      m.on('moveend', function () { clearTimeout(timer); timer = setTimeout(check, 250); });
      // 導航時鏡頭一直跟著車子動、不會有「移動結束」：移動中也每 0.7 秒檢查一次(開到新的地方才抓得到 3D 路)
      m.on('move', function () { var now = Date.now(); if (now - lastMove > 700) { lastMove = now; check(); } });
      check();
    };
    if (m.loaded()) go(); else m.once('load', go);
  }
  init();
})();
