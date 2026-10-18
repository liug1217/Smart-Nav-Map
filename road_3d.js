// ===== 🛣 國道、快速道路 3D 路面(第 3 階段：主線＋匝道、交流道、真的高架) =====
// 放大到 zoom 16 以上，把國道、快速道路的主線、匝道畫成立體道路。
// 資料(road3d/，tools/build-road3d.js 產生)在電腦上已經全部算好：貝茲曲線的曲線點、每點路寬、高度、接縫方向、哪段護欄不畫，
// 這裡只照著畫：
//   - 路面：深灰色柏油；車道 3.75 公尺、內側路肩 1、外側路肩 3 公尺(電腦算好的路寬)
//   - 標線：內側黃實線、外側白實線(寬 15 公分)、車道白色虛線(劃 4 公尺、空 6 公尺)；雙向道路中央雙黃線
//   - 中央分隔：紐澤西水泥護欄＋綠色防眩板(主線往左多鋪 0.4 公尺，跟對向之間的空隙鋪滿)；
//     上下行之間 5 公尺內：立在空隙正中間(電腦算好由哪一邊畫)；沒空間 → 一道護欄(兩面斜角)＋防眩板，
//       有空間 → 固定寬度的花台(兩道單斜面護欄＋中間一整排修剪過的灌木，不裝防眩板)；一道 ↔ 兩道之間斜斜地分開 / 合起來
//     5～30 公尺：兩道護欄＋防眩板，中間鋪草地(深淺不均、中間微微隆起、兩邊水泥緣石，夠寬的種一排灌木)
//   - 外側：平地鋼板護欄(W 型鋼板＋每 4 公尺一根立柱)、橋上紐澤西水泥護欄；會落在別條路上的那段不畫
//   - 高架：橋每層 6 公尺(電腦算好高度、上下交叉的淨空)；兩側 1.4 公尺深的箱型梁、底面、每 30 公尺一座橋墩(柱子＋帽梁)，
//     橋墩不會立在底下別條路的路面上
//   - 匝道：內側路肩 1、外側 2 公尺，左右兩側都有護欄(沒有中央分隔)
//   - 交流道：匝道還疊在本線上的那段不畫，本線往那側加寬成減速 / 加速車道(原本的邊線位置改畫虛線)；
//     分開後到尖端之間是槽化區(柏油＋白色斜線＋白邊線)；本線那側、匝道靠本線那側的護欄到尖端之後才有
//   - 路燈：道路兩側外面每 50 公尺一支(有 3D 道路的地方由這裡立，lamps_3d.js 就不畫，不會對不上)
// 圖層放在平面道路線、導航路線、塞車線的上面(高架底下經過的路被橋面蓋住)、路線箭頭和 3D 建築的下面；
// 放大到看得到 3D 時，國道的綠線、塞車顏色、導航路線改畫在 3D 路面上(高架上也對得上)，車子抬到橋面高度。
(function () {
  'use strict';
  // 縮放：zoom 14 以上就畫 3D 路面(縮小也不會不見)；16 以上才把綠線、導航路線畫到橋面上、車子抬高(16 以下綠線照樣畫在地面那層，3D 路面在它下面)
  var MIN_ZOOM = 16, DRAW_ZOOM = 14, DETAIL_ZOOM = 15.5, TILE_Z = 13, MAX_CHUNKS = 24, LANE = 3.75, DASH = 4, GAP = 6, MEDIAN_FILL = 0.4;
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
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 16) return out;   // 太傾斜、看太遠：不抓
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
    return { id: r[0], link: !!(f & 1), cls: f & 2 ? 'trunk' : 'motorway', oneway: !!(f & 4), bridge: !!(f & 8), tunnel: !!(f & 16), lanes: r[2], coords: coords,
      W: perPoint(e.w, n, 10), H: perPoint(e.z, n, 0), hide: e.h || [], aL: perPoint(e.aL, n, 0), aR: perPoint(e.aR, n, 0), skip: e.x || [], gores: e.g || [], grass: e.mg || [], hedge: e.mh || [], medS: e.ms || [],
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
            t.chunk = null;
            if (threeState === 'ready' && t.ids.length) requestBuild(t);
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
  Bucket.prototype.quadC = function (a, b, c, d, col) {   // 帶顏色(草地)
    this.quad(a, b, c, d);
    if (!this.c) this.c = [];
    for (var i = 0; i < 6; i++) this.c.push(col[0], col[1], col[2]);
  };
  // 紐澤西水泥護欄：只有面向車道那一面是斜的(下緣兩段斜角)，背面是直的
  //   JERSEY_IN：車道在 x 大的那邊(中央分隔、花台)；JERSEY_OUT：車道在 x = 0 那邊(橋上外側)
  var JERSEY_IN = [[0.2, 0], [0.2, 0.85], [0.42, 0.85], [0.48, 0.33], [0.61, 0.08], [0.66, 0]];
  var JERSEY_OUT = [[0, 0], [0.05, 0.08], [0.18, 0.33], [0.24, 0.85], [0.46, 0.85], [0.46, 0]];
  // 半個斷面(背面在 x = 0、車道在 x 大的那邊)：兩個背靠背 = 一道兩面斜角的護欄(底寬 0.6、頂寬 0.16，跟實際的一樣)
  var JERSEY_HALF = [[0, 0], [0, 0.85], [0.08, 0.85], [0.14, 0.33], [0.27, 0.08], [0.3, 0]];
  var WBEAM = [[0.06, 0.45], [0, 0.53], [0.06, 0.6], [0, 0.68], [0.06, 0.76]];   // 兩道凸起朝向車道

  // 分批建：一塊圖磚可能有一百多條路、上萬個點，一次建完畫面會卡住一秒多；
  //   改成每格畫面最多花 6 毫秒建幾條路，整塊建完才顯示
  var buildQ = [], building = null, BUDGET = 6;
  function requestBuild(t) {
    if (t.chunk || t.building) return;
    t.building = true; buildQ.push(t);
    if (!building) nextBuild();
  }
  function nextBuild() {
    var t = buildQ.shift();
    if (!t) { building = null; return; }
    var ext = t.ext, origin = maplibregl.MercatorCoordinate.fromLngLat([(ext.w + ext.e) / 2, (ext.n + ext.s) / 2], 0);
    building = { t: t, i: 0, origin: origin, sc: origin.meterInMercatorCoordinateUnits(),
      B: { asphalt: new Bucket(), concrete: new Bucket(), under: new Bucket(), grass: new Bucket(), steel: new Bucket(), glare: new Bucket(), lamp: new Bucket(), white: new Bucket(), yellow: new Bucket() }, geo: [] };
    requestAnimationFrame(buildSlice);
  }
  function buildSlice() {
    var b = building, t = b.t, t0 = performance.now();
    while (b.i < t.ids.length && performance.now() - t0 < BUDGET) { var w = ways[t.ids[b.i++]], g = w && buildWay(w, b.origin, b.sc, b.B); if (g) b.geo.push(g); }
    if (b.i < t.ids.length) { requestAnimationFrame(buildSlice); return; }
    // 路都建完了：每格畫面做一種材質的模型(大的一塊要幾十毫秒)
    if (!b.keys) { b.keys = Object.keys(b.B).filter(function (k) { return b.B[k].p.length; }); b.meshes = []; }
    var k = b.keys.shift();
    if (k) { b.meshes.push(makeMesh(k, b.B[k])); b.B[k] = null; requestAnimationFrame(buildSlice); return; }
    t.building = false;
    if (t.chunk) disposeChunk(t.chunk);
    t.chunk = finishChunk(t, b.origin, b.sc, b.meshes);
    if (t.chunk) { t.chunk.geo = b.geo; if (ovGreen || ovItems.length) addOverlay(t.chunk); }
    if (window.map) window.map.triggerRepaint();
    try { window.dispatchEvent(new Event('snm-road3d-data')); } catch (e) {}   // 電子看板改立在路面高度
    nextBuild();
  }
  function makeMesh(k, bucket) {
    var T = window.THREE, g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(bucket.p, 3));
    if (bucket.c) g.setAttribute('color', new T.Float32BufferAttribute(bucket.c, 3));
    if (k !== 'white' && k !== 'yellow' && k !== 'lamp') g.computeVertexNormals();   // 標線、燈面不受光照，不用法向量
    var mesh = new T.Mesh(g, mats[k]);
    if (k === 'white' || k === 'yellow') mesh.renderOrder = 2;
    mesh.frustumCulled = false;   // 疊在地圖上時 three.js 自己判斷會誤判成看不到
    mesh.userData.detail = k === 'glare' || k === 'lamp';   // 防眩板、路燈燈面：遠看看不出來，縮小時不畫(省效能)
    return mesh;
  }
  function finishChunk(t, origin, sc, meshes) {
    var T = window.THREE, ext = t.ext;
    if (!meshes.length) return null;
    var group = new T.Group();
    meshes.forEach(function (m) { group.add(m); });
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
    // 匝道還疊在本線上的那段：路面、標線、護欄、路燈都不畫
    var skip = [];
    for (i = 0; i + 1 < w.skip.length; i += 2) skip.push([w.skip[i] / 1e6 * L, w.skip[i + 1] / 1e6 * L]);
    skip.forEach(function (r) { hidden['1'].push(r); hidden['-1'].push(r); hidden['0'].push(r); });
    var inSkip = function (s) { return skip.some(function (r) { return s >= r[0] && s <= r[1]; }); };
    // 窄分隔島的花台：這條負責畫的段落 → 每點空隙(-1 = 不是)；兩邊的一般中央護欄、防眩板都不畫
    var hedgeR = [];
    for (i = 0; i + 5 < w.hedge.length; i += 6) hedgeR.push([w.hedge[i] / 1e6 * L, w.hedge[i + 1] / 1e6 * L, w.hedge[i + 2] / 100, w.hedge[i + 3] / 100, w.hedge[i + 4] / 100, w.hedge[i + 5] / 100]);
    hedgeR.forEach(function (h) { hidden['0'].push([h[0], h[1]]); });
    for (i = 0; i + 1 < w.medS.length; i += 2) hidden['0'].push([w.medS[i] / 1e6 * L, w.medS[i + 1] / 1e6 * L]);
    var hedgeGap = S.map(function (sv) { for (var q = 0; q < hedgeR.length; q++) { var h = hedgeR[q]; if (sv >= h[0] - 0.01 && sv <= h[1] + 0.01) return h[2] + (h[3] - h[2]) * ((sv - h[0]) / ((h[1] - h[0]) || 1)); } return -1; });
    var ov = function (o, k) { return typeof o === 'number' ? o : o[k]; };
    var plus = function (o, d) { return typeof o === 'number' ? o + d : o.map(function (v) { return v + d; }); };
    var pt = function (k, o, y) { var v = ov(o, k); return [P[k][0] + R[k][0] * v, H[k] + y, P[k][1] + R[k][1] * v]; };
    var at = function (k, t, o, y) {
      if (t <= 0) return pt(k, o, y);
      if (t >= 1) return pt(k + 1, o, y);
      var v = ov(o, k) + (ov(o, k + 1) - ov(o, k)) * t, r = segR[k];
      return [P[k][0] + (P[k + 1][0] - P[k][0]) * t + r[0] * v, H[k] + (H[k + 1] - H[k]) * t + y, P[k][1] + (P[k + 1][1] - P[k][1]) * t + r[1] * v];
    };
    var visible = function (k, side) {   // 第 k 段去掉不畫的部分，剩下的 [t0, t1](side 沒給 = 只去掉匝道不畫的那段)
      var s0 = S[k], s1 = S[k + 1], len = s1 - s0, out = [[s0, s1]];
      (side == null ? skip : hidden[side]).forEach(function (h) {
        var nx = [];
        out.forEach(function (r) { if (h[1] <= r[0] || h[0] >= r[1]) nx.push(r); else { if (h[0] > r[0]) nx.push([r[0], h[0]]); if (h[1] < r[1]) nx.push([h[1], r[1]]); } });
        out = nx;
      });
      return out.filter(function (r) { return r[1] - r[0] > 0.05; }).map(function (r) { return [(r[0] - s0) / (len || 1), (r[1] - s0) / (len || 1)]; });
    };
    var isHidden = function (side, s) { return hidden[side].some(function (h) { return s >= h[0] && s <= h[1]; }); };
    // 橫斷面：a / b = 最左 / 最右車道外緣
    //   匝道外側路肩 2 公尺；交流道往右 / 左加寬(aR / aL，減速、加速車道)：路面邊緣、護欄、邊線跟著往外
    var inner = w.oneway ? 1.0 : 1.5, outer = w.oneway ? (w.link ? 2.0 : 3.0) : 1.5, aR = w.aR, aL = w.aL;
    var half = W.map(function (v, k) { return v / 2 + aR[k]; }), nhalf = W.map(function (v, k) { return -v / 2 - aL[k]; });
    var a = W.map(function (v) { return -v / 2 + inner; }), b = W.map(function (v) { return v / 2 - outer; });
    var strip = function (bk, o1, o2, y) {
      for (var k = 0; k < n - 1; k++) {
        if (!skip.length) { bk.quad(pt(k, o1, y), pt(k, o2, y), pt(k + 1, o2, y), pt(k + 1, o1, y)); continue; }
        visible(k, null).forEach(function (r) { bk.quad(at(k, r[0], o1, y), at(k, r[0], o2, y), at(k, r[1], o2, y), at(k, r[1], o1, y)); });
      }
    };
    var dashed = function (bk, o, wd, y, ok) {   // 每 10 公尺畫 4 公尺
      var period = DASH + GAP;
      for (var k = 0; k < n - 1; k++) {
        if (ok && !ok(k)) continue;
        var s0 = S[k], s1 = S[k + 1];
        for (var st = Math.floor(s0 / period) * period; st < s1; st += period) {
          var u0 = Math.max(st, s0), u1 = Math.min(st + DASH, s1);
          if (u1 - u0 < 0.2 || inSkip((u0 + u1) / 2)) continue;
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
    // 路面(主線往左多鋪 0.4 公尺：跟對向之間的空隙鋪滿；匝道沒有中央分隔，不多鋪)
    //   花台由這條畫的地方：空隙整個鋪滿
    var deckL = w.oneway && !w.link ? nhalf.map(function (v, k) { return v - (hedgeGap[k] >= 0 ? Math.max(MEDIAN_FILL, hedgeGap[k]) : MEDIAN_FILL); }) : nhalf;
    strip(B.asphalt, deckL, half, 0.03);
    // 高架：兩側 1.4 公尺深的箱型梁、底面(離地不到 1.4 公尺的地方梁到地面為止)、每 30 公尺一座橋墩(柱子＋帽梁)
    var GD = 1.4, depth = function (k) { return Math.min(GD, H[k]); };
    for (var kb = 0; kb < n - 1; kb++) {
      if (H[kb] < 0.3 && H[kb + 1] < 0.3) continue;
      visible(kb, null).forEach(function (r) {
        var dA = depth(kb) + (depth(kb + 1) - depth(kb)) * r[0], dB = depth(kb) + (depth(kb + 1) - depth(kb)) * r[1];
        B.concrete.quad(at(kb, r[0], deckL, 0.03), at(kb, r[1], deckL, 0.03), at(kb, r[1], deckL, -dB), at(kb, r[0], deckL, -dA));
        B.concrete.quad(at(kb, r[0], half, 0.03), at(kb, r[0], half, -dA), at(kb, r[1], half, -dB), at(kb, r[1], half, 0.03));
        if (H[kb] > GD + 0.1 && H[kb + 1] > GD + 0.1) B.under.quad(at(kb, r[0], deckL, -dA), at(kb, r[0], half, -dA), at(kb, r[1], half, -dB), at(kb, r[1], deckL, -dB));
      });
    }
    var box = function (c, u, f, w0, l0, y0, y1) {   // 中心 c、橫向 u、沿路 f、寬 w0、長 l0、從 y0 到 y1(絕對高度)
      var cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function (q) { return [c[0] + u[0] * q[0] * w0 / 2 + f[0] * q[1] * l0 / 2, c[1] + u[1] * q[0] * w0 / 2 + f[1] * q[1] * l0 / 2]; });
      for (var e = 0; e < 4; e++) { var A0 = cs[e], A1 = cs[(e + 1) % 4]; B.concrete.quad([A0[0], y0, A0[1]], [A1[0], y0, A1[1]], [A1[0], y1, A1[1]], [A0[0], y1, A0[1]]); }
      B.concrete.quad([cs[0][0], y1, cs[0][1]], [cs[1][0], y1, cs[1][1]], [cs[2][0], y1, cs[2][1]], [cs[3][0], y1, cs[3][1]]);
    };
    for (var sp = 15; sp < L; sp += 30) {
      if (inSkip(sp)) continue;
      var kp = 0; while (kp < n - 2 && S[kp + 1] < sp) kp++;
      var tp = (sp - S[kp]) / ((S[kp + 1] - S[kp]) || 1), hp = H[kp] + (H[kp + 1] - H[kp]) * tp;
      if (hp < 3.5) continue;
      var r0 = segR[kp], fw = [r0[1], -r0[0]], dl = deckL[kp] + (deckL[kp + 1] - deckL[kp]) * tp, dr = half[kp] + (half[kp + 1] - half[kp]) * tp, mid0 = (dl + dr) / 2, wd = dr - dl;
      var cx = P[kp][0] + (P[kp + 1][0] - P[kp][0]) * tp + r0[0] * mid0, cz = P[kp][1] + (P[kp + 1][1] - P[kp][1]) * tp + r0[1] * mid0;
      var ll = new maplibregl.MercatorCoordinate(origin.x + cx * sc, origin.y + cz * sc, 0).toLngLat();
      if (onLowerRoad([ll.lng, ll.lat], w, hp - GD - 1)) continue;   // 橋墩不能立在底下別條路的路面上
      box([cx, cz], r0, fw, Math.min(3.2, wd * 0.22), 1.8, 0, hp - GD - 1.0);           // 柱子
      box([cx, cz], r0, fw, wd * 0.8, 2.0, hp - GD - 1.0, hp - GD);                      // 帽梁
    }
    var my = 0.06;
    var edge = function (o, side, hs) {   // 外側：橋上紐澤西水泥護欄(外緣貼齊路面邊緣)、平地鋼板護欄、隧道裡是矮的水泥側牆(路緣)
      if (w.tunnel) { wall(B.concrete, plus(o, 0.3 * side), -side, [[0, 0], [0, 0.35], [0.45, 0.35], [0.45, 0]], hs); return; }
      if (onBridge) wall(B.concrete, plus(o, -0.36 * side), side, JERSEY_OUT, hs); else guardrail(o, side, hs);
    };
    if (w.oneway) {
      // 內側黃實線、外側白實線：有加寬(減速 / 加速車道)的地方跟著往外移，原本的位置改畫虛線(加寬超過 1 公尺的地方)
      var aLin = a.map(function (v, k) { return v - aL[k]; }), bOut = b.map(function (v, k) { return v + aR[k]; });
      strip(B.yellow, aLin, plus(aLin, 0.15), my);
      strip(B.white, plus(bOut, -0.15), bOut, my);
      if (aR.some(function (v) { return v > 1; })) dashed(B.white, plus(b, -0.1), 0.2, my, function (k) { return aR[k] > 1 && aR[k + 1] > 1; });
      if (aL.some(function (v) { return v > 1; })) dashed(B.white, plus(a, 0.1), 0.2, my, function (k) { return aL[k] > 1 && aL[k + 1] > 1; });
      for (var k2 = 1; k2 < w.lanes; k2++) (function (kk) {   // 車道線：車道數漸變時，窄掉的那條不畫；隧道裡是雙白實線(禁止變換車道)
        if (w.tunnel) { strip(B.white, plus(a, kk * LANE - 0.2), plus(a, kk * LANE - 0.08), my); strip(B.white, plus(a, kk * LANE + 0.08), plus(a, kk * LANE + 0.2), my); return; }
        dashed(B.white, plus(a, kk * LANE), 0.15, my, function (k) { return a[k] + kk * LANE < b[k] - 1 && a[k + 1] + kk * LANE < b[k + 1] - 1; });
      })(k2);
      edge(plus(half, -0.3), 1, '1');
      if (w.tunnel && !w.link) edge(plus(nhalf, 0.3), -1, '0');   // 隧道左邊也是側牆(沒有中央分隔)
    }
    if (w.oneway && w.link) edge(plus(nhalf, 0.3), -1, '-1');   // 匝道：左邊也是護欄(沒有中央分隔)
    if (w.oneway && !w.link && !w.tunnel) {
      // 中央分隔：紐澤西水泥護欄＋綠色防眩板(每 1 公尺一片、斜 60 度、0.85～1.5 公尺高)
      var med = plus(nhalf, -0.1);
      wall(B.concrete, med, 1, JERSEY_IN, '0');
      every(1, 0.5, '0', function (k, tt) {
        var r = segR[k], f = [r[1], -r[0]], c = at(k, tt, plus(med, 0.33), 0), y0 = c[1] + 0.85, y1 = c[1] + 1.5;
        var u = [f[0] * 0.5 + r[0] * 0.866, f[1] * 0.5 + r[1] * 0.866], v = [-u[1], u[0]];
        var cs = [[-0.11, -0.015], [0.11, -0.015], [0.11, 0.015], [-0.11, 0.015]].map(function (q) { return [c[0] + u[0] * q[0] + v[0] * q[1], c[2] + u[1] * q[0] + v[1] * q[1]]; });
        for (var e = 0; e < 4; e++) { var A = cs[e], C = cs[(e + 1) % 4]; B.glare.quad([A[0], y0, A[1]], [C[0], y0, C[1]], [C[0], y1, C[1]], [A[0], y1, A[1]]); }
      });
    }
    gore(w, origin, sc, B);
    medianGrass(w, P, S, segR, R, H, nhalf, B);
    // 中間那道護欄 / 花台：每 1 公尺一格；c = 空隙正中間，split 0～1：
    //   兩道單斜面護欄的直立背面在 c ± 0.7 × split(split 0 = 背靠背 → 一道兩面斜角的護欄)；
    //   split 小(一道)時頂上裝防眩板，split 大(花台)時兩道護欄中間長樹籬(高度、顏色用位置算的雜訊一團一團變化)
    var HALF_IN = 0.7;
    hedgeR.forEach(function (h) {
      var smp = [];
      for (var sv = h[0]; sv < h[1] + 0.99; sv += 1) {
        var su = Math.min(sv, h[1]), k = 0; while (k < n - 2 && S[k + 1] < su) k++;
        var t = (su - S[k]) / ((S[k + 1] - S[k]) || 1), f = (su - h[0]) / ((h[1] - h[0]) || 1);
        var g = h[2] + (h[3] - h[2]) * f, u = Math.max(0, Math.min(1, h[4] + (h[5] - h[4]) * f));
        smp.push({ s: su, k: k, t: t, c: nhalf[k] + (nhalf[k + 1] - nhalf[k]) * t - g / 2, u: u });
        if (su >= h[1]) break;
      }
      var P3 = function (sm, o, y) { return at(sm.k, sm.t, o, y); };
      for (var q = 0; q < smp.length - 1; q++) {
        var A0 = smp[q], A1 = smp[q + 1];
        var ra = A0.c + A0.u * HALF_IN, rb = A1.c + A1.u * HALF_IN, la = A0.c - A0.u * HALF_IN, lb = A1.c - A1.u * HALF_IN;
        for (var j = 0; j < JERSEY_HALF.length - 1; j++) {
          var p0 = JERSEY_HALF[j], p1 = JERSEY_HALF[j + 1];
          // 這條路這邊的護欄(背面在 ra，斜面朝自己的車道)、對向那邊的護欄(鏡射)
          B.concrete.quad(P3(A0, ra + p0[0], p0[1]), P3(A0, ra + p1[0], p1[1]), P3(A1, rb + p1[0], p1[1]), P3(A1, rb + p0[0], p0[1]));
          B.concrete.quad(P3(A0, la - p0[0], p0[1]), P3(A0, la - p1[0], p1[1]), P3(A1, lb - p1[0], p1[1]), P3(A1, lb - p0[0], p0[1]));
        }
        // 防眩板：一道護欄的地方(split < 0.35)，每 1 公尺一片、斜 60 度、0.85～1.5 公尺高
        if (A0.u < 0.35) {
          var rr0 = segR[A0.k], ff = [rr0[1], -rr0[0]], cc = P3(A0, A0.c, 0), y0 = cc[1] + 0.85, y1 = cc[1] + 1.5;
          var uu = [ff[0] * 0.5 + rr0[0] * 0.866, ff[1] * 0.5 + rr0[1] * 0.866], vv = [-uu[1], uu[0]];
          var cs4 = [[-0.11, -0.015], [0.11, -0.015], [0.11, 0.015], [-0.11, 0.015]].map(function (z) { return [cc[0] + uu[0] * z[0] + vv[0] * z[1], cc[2] + uu[1] * z[0] + vv[1] * z[1]]; });
          for (var e4 = 0; e4 < 4; e4++) { var Q0 = cs4[e4], Q1 = cs4[(e4 + 1) % 4]; B.glare.quad([Q0[0], y0, Q0[1]], [Q1[0], y0, Q1[1]], [Q1[0], y1, Q1[1]], [Q0[0], y1, Q0[1]]); }
        }
        // 樹籬：花台的地方(split > 0.5)，整個收在兩道護欄直立的背面之間，側面直上去、頂上圓圓的；分開時跟著慢慢長高
        if (A0.u > 0.5 && A1.u > 0.5) {
          var prof = function (sm, xr, xl) {
            var n1 = hash(Math.round(sm.s / 1.3), 3.1), n2 = hash(Math.round(sm.s / 0.7), 9.7), grow = Math.min(1, (sm.u - 0.5) * 2);
            var top = 0.85 + (0.9 + n1 * 0.25 + n2 * 0.08) * grow, mid = (xr + xl) / 2, rw = Math.min(0.15, (xr - xl) * 0.25);
            return [[xr, 0.5], [xr, top - 0.32 * grow], [xr - rw, top - 0.08 * grow], [mid + (xr - mid) * 0.4, top], [mid + (xl - mid) * 0.4, top], [xl + rw, top - 0.08 * grow], [xl, top - 0.32 * grow], [xl, 0.5]];
          };
          var pa = prof(A0, ra - 0.03, la + 0.03), pb = prof(A1, rb - 0.03, lb + 0.03), cs = HEDGE[Math.floor(hash(Math.round(A0.s), 5.5) * HEDGE.length)];
          for (var c2 = 0; c2 < pa.length - 1; c2++) {
            var shade = c2 === 3 ? 1.12 : (c2 === 2 || c2 === 4) ? 1.04 : 0.9, col = [cs[0] * shade, cs[1] * shade, cs[2] * shade];
            B.grass.quadC(P3(A0, pa[c2][0], pa[c2][1]), P3(A0, pa[c2 + 1][0], pa[c2 + 1][1]), P3(A1, pb[c2 + 1][0], pb[c2 + 1][1]), P3(A1, pb[c2][0], pb[c2][1]), col);
          }
        }
      }
    });
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
    (w.tunnel ? [] : w.oneway ? [1] : [1, -1]).forEach(function (side) {   // 隧道裡不立路燈
      for (var sl = side > 0 ? 25 : 50; sl < L - 10; sl += 50) {
        var kl = 0; while (kl < n - 2 && S[kl + 1] < sl) kl++;
        var tl = (sl - S[kl]) / ((S[kl + 1] - S[kl]) || 1);
        if (isHidden(side > 0 ? '1' : '-1', sl)) continue;
        var e = side > 0 ? half[kl] + (half[kl + 1] - half[kl]) * tl : nhalf[kl] + (nhalf[kl + 1] - nhalf[kl]) * tl;
        var r = segR[kl], f = [r[1], -r[0]], base = at(kl, tl, onBridge ? e - side * 0.33 : e + side * 0.6, onBridge ? 0.85 : 0);
        lamp(B, base, [-r[0] * side, -r[1] * side], f);   // 燈臂伸向車道
      }
    });
    // 這條路的形狀：疊線(綠線、塞車、導航路線)、車子高度、電子看板高度用
    return { w: w, P: P, S: S, segR: segR, R: R, H: H, a: a, b: b, L: L, half: half, nhalf: nhalf };
  }

  // ── 中央分隔島草地：從這條路路面左緣(含多鋪的 0.4)到對向路面左緣，電腦算好空隙 ──
  //   草：每 2 公尺一格、橫向 4 格，顏色用位置算的雜訊深淺不均(看起來是一塊塊的草皮)，中間微微隆起；
  //   兩邊 0.2 公尺寬、0.15 公尺高的水泥緣石；空隙 2.5 公尺以上每 6 公尺一叢低矮灌木
  var GRASS = [[0.33, 0.52, 0.22], [0.40, 0.58, 0.25], [0.29, 0.46, 0.20], [0.45, 0.60, 0.30], [0.36, 0.50, 0.24]];
  var HEDGE = [[0.36, 0.55, 0.18], [0.42, 0.60, 0.20], [0.31, 0.50, 0.17], [0.47, 0.63, 0.24], [0.39, 0.57, 0.22]];   // 樹籬的綠(照片裡修剪過的灌木，偏黃綠)
  function hash(x, y) { var h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return h - Math.floor(h); }
  function medianGrass(w, P, S, segR, R, H, nhalf, B) {
    if (!w.grass.length) return;
    var n = P.length, L = S[n - 1];
    for (var gi = 0; gi + 3 < w.grass.length; gi += 4) {
      var s0 = w.grass[gi] / 1e6 * L, s1 = w.grass[gi + 1] / 1e6 * L, g0 = w.grass[gi + 2] / 100, g1 = w.grass[gi + 3] / 100;
      // 沿路每 2 公尺取一點
      var pts = [];
      for (var sv = s0; sv < s1 + 1.99; sv += 2) {
        var su = Math.min(sv, s1), k = 0; while (k < n - 2 && S[k + 1] < su) k++;
        var t = (su - S[k]) / ((S[k + 1] - S[k]) || 1), r = segR[k];
        var gap = g0 + (g1 - g0) * ((su - s0) / ((s1 - s0) || 1)), e0 = nhalf[k] + (nhalf[k + 1] - nhalf[k]) * t - MEDIAN_FILL;
        pts.push({ s: su, c: [P[k][0] + (P[k + 1][0] - P[k][0]) * t, P[k][1] + (P[k + 1][1] - P[k][1]) * t], r: r, h: H[k] + (H[k + 1] - H[k]) * t, e0: e0, e1: e0 - (gap - 2 * MEDIAN_FILL), gap: gap });
        if (su >= s1) break;
      }
      if (pts.length < 2) continue;
      var at = function (p, o, y) { return [p.c[0] + p.r[0] * o, p.h + y, p.c[1] + p.r[1] * o]; };
      var CURB = 0.2, CH = 0.15, COLS = 4;
      for (var q = 0; q < pts.length - 1; q++) {
        var A = pts[q], Bp = pts[q + 1];
        if (A.e0 - A.e1 < 0.5 || Bp.e0 - Bp.e1 < 0.5) continue;
        // 緣石(兩邊)
        [[A.e0, Bp.e0, -1], [A.e1, Bp.e1, 1]].forEach(function (cb) {
          var o0 = cb[0], o1 = cb[1], d = cb[2];
          B.concrete.quad(at(A, o0, 0.02), at(Bp, o1, 0.02), at(Bp, o1, CH), at(A, o0, CH));
          B.concrete.quad(at(A, o0, CH), at(Bp, o1, CH), at(Bp, o1 + d * CURB, CH), at(A, o0 + d * CURB, CH));
        });
        // 草地：橫向 COLS 格，中間隆起
        var rise = function (p) { return Math.min(0.3, (p.e0 - p.e1) * 0.06); };
        for (var cI = 0; cI < COLS; cI++) {
          var f0 = cI / COLS, f1 = (cI + 1) / COLS;
          var off = function (p, f) { var a0 = p.e0 - CURB, a1 = p.e1 + CURB; return a0 + (a1 - a0) * f; };
          var yy = function (p, f) { return CH - 0.03 + rise(p) * Math.sin(Math.PI * f); };
          var col = GRASS[Math.floor(hash(Math.round(A.s / 2), cI + Math.round(A.c[0] / 50)) * GRASS.length)];
          B.grass.quadC(at(A, off(A, f0), yy(A, f0)), at(A, off(A, f1), yy(A, f1)), at(Bp, off(Bp, f1), yy(Bp, f1)), at(Bp, off(Bp, f0), yy(Bp, f0)), col);
        }
        // 灌木：空隙 2.5 公尺以上，每 6 公尺一叢(位置、大小稍微錯開)
        if (A.gap >= 2.5 && Math.floor(A.s / 6) !== Math.floor(Bp.s / 6)) {
          var hh = hash(Math.floor(Bp.s / 6), 7.3), rad = 0.45 + hh * 0.35, ht = 0.6 + hh * 0.5;
          var mid = (A.e0 + A.e1) / 2 + (hh - 0.5) * Math.min(1, (A.e0 - A.e1) * 0.2), base = at(A, mid, CH - 0.03 + rise(A));
          bush(B, base, rad, ht, A.r);
        }
      }
    }
  }
  function bush(B, c, rad, ht, r) {   // 低矮灌木：上下兩圈八角形縮起來的一團(深綠)
    var f = [r[1], -r[0]], ring = function (y, rr) { var o = []; for (var q = 0; q < 8; q++) { var a = q / 8 * Math.PI * 2, cs = Math.cos(a) * rr, sn = Math.sin(a) * rr; o.push([c[0] + r[0] * cs + f[0] * sn, c[1] + y, c[2] + r[1] * cs + f[1] * sn]); } return o; };
    var r0 = ring(0, rad * 0.75), r1 = ring(ht * 0.55, rad), r2 = ring(ht, rad * 0.45), col = [0.20, 0.36, 0.16], col2 = [0.25, 0.43, 0.19];
    for (var q = 0; q < 8; q++) {
      var q2 = (q + 1) % 8;
      B.grass.quadC(r0[q], r0[q2], r1[q2], r1[q], col);
      B.grass.quadC(r1[q], r1[q2], r2[q2], r2[q], col2);
      B.grass.quadC(r2[q], r2[q2], [c[0], c[1] + ht * 1.08, c[2]], [c[0], c[1] + ht * 1.08, c[2]], col2);
    }
  }

  // ── 槽化區：本線路面邊緣(l)到匝道路面邊緣(r)之間鋪柏油、畫白邊線和斜線(每 6 公尺一條) ──
  function gore(w, origin, sc, B) {
    w.gores.forEach(function (g) {
      var dec = function (d) {
        var x = d[0], y = d[1], o = [[x, y]];
        for (var i = 2; i < d.length; i += 2) { x += d[i]; y += d[i + 1]; o.push([x, y]); }
        return o.map(function (c) { var m = maplibregl.MercatorCoordinate.fromLngLat([c[0] / 1e6, c[1] / 1e6], 0); return [(m.x - origin.x) / sc, (m.y - origin.y) / sc]; });
      };
      var l = dec(g.l), r = dec(g.r), n = Math.min(l.length, r.length);
      if (n < 2) return;
      var p3 = function (p, i, dy) { return [p[0], (g.z[i] || 0) / 100 + dy, p[1]]; };
      var toward = function (p, q, d) { var dx = q[0] - p[0], dz = q[1] - p[1], L = Math.hypot(dx, dz); if (L < 1e-6) return p; var f = Math.min(d, L / 2) / L; return [p[0] + dx * f, p[1] + dz * f]; };
      for (var i = 0; i < n - 1; i++) {
        B.asphalt.quad(p3(l[i], i, 0.035), p3(r[i], i, 0.035), p3(r[i + 1], i + 1, 0.035), p3(l[i + 1], i + 1, 0.035));
        // 兩側白邊線(往槽化區裡面 0.15 公尺)
        B.white.quad(p3(l[i], i, 0.065), p3(toward(l[i], r[i], 0.15), i, 0.065), p3(toward(l[i + 1], r[i + 1], 0.15), i + 1, 0.065), p3(l[i + 1], i + 1, 0.065));
        B.white.quad(p3(r[i], i, 0.065), p3(toward(r[i], l[i], 0.15), i, 0.065), p3(toward(r[i + 1], l[i + 1], 0.15), i + 1, 0.065), p3(r[i + 1], i + 1, 0.065));
      }
      // 斜線(照標線規則：寬 20 公分、斜 45 度)：從本線那邊斜到匝道那邊，往前的距離 = 那裡的寬度；每 4 公尺一條，太窄的地方不畫
      for (var j = 1; j + 1 < n; j += 2) {
        var gw = Math.hypot(r[j][0] - l[j][0], r[j][1] - l[j][1]);
        if (gw < 0.6) continue;
        var j2 = Math.min(n - 1, j + Math.max(1, Math.round(gw / 2)));   // 點每 2 公尺一個
        var t = [l[j + 1][0] - l[j][0], l[j + 1][1] - l[j][1]], tl = Math.hypot(t[0], t[1]) || 1; t = [t[0] / tl * 0.2, t[1] / tl * 0.2];
        var A0 = l[j], A1 = r[j2];
        B.white.quad(p3(A0, j, 0.065), p3([A0[0] + t[0], A0[1] + t[1]], j, 0.065), p3([A1[0] + t[0], A1[1] + t[1]], j2, 0.065), p3(A1, j2, 0.065));
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
      under: new T.MeshLambertMaterial({ color: 0x9A978F, side: ds }),   // 橋面版底面(陰影處)
      grass: new T.MeshLambertMaterial({ vertexColors: true, side: ds }),   // 分隔島草地、灌木(每格自己的顏色)
      steel: new T.MeshPhongMaterial({ color: 0xC4CACF, specular: 0x8A8F94, shininess: 60, side: ds }),
      glare: new T.MeshLambertMaterial({ color: 0x3F8A55, side: ds }),
      lamp: new T.MeshBasicMaterial({ color: lampColor(), side: ds }),   // 路燈燈面：晚上 6 點到早上 6 點亮(暖白)，白天熄燈(灰)
      white: mark(0xF4F4F4), yellow: mark(0xF2BE1A)
    };
  }

  // ── 路的格子索引(經緯度 → 公尺)：橋墩檢查、疊線對路面、車子高度用 ──
  var KX = 111320 * Math.cos(23.7 * Math.PI / 180), KY = 110540, gIdx = null, gCount = -1;
  function wayGrid() {
    var ids = Object.keys(ways);
    if (gIdx && gCount === ids.length) return gIdx;
    gIdx = {}; gCount = ids.length; connected.memo = {};
    ids.forEach(function (id) {
      var w = ways[id], c = w.coords, acc = 0;
      w._len = [0];
      for (var i = 1; i < c.length; i++) { acc += Math.hypot((c[i][0] - c[i - 1][0]) * KX, (c[i][1] - c[i - 1][1]) * KY); w._len[i] = acc; }
      w._L = acc || 1;
      for (i = 0; i < c.length - 1; i++) {
        var x0 = Math.floor(Math.min(c[i][0], c[i + 1][0]) * KX / 50), x1 = Math.floor(Math.max(c[i][0], c[i + 1][0]) * KX / 50);
        var y0 = Math.floor(Math.min(c[i][1], c[i + 1][1]) * KY / 50), y1 = Math.floor(Math.max(c[i][1], c[i + 1][1]) * KY / 50);
        for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) (gIdx[x + ',' + y] = gIdx[x + ',' + y] || []).push([w, i]);
      }
    });
    return gIdx;
  }
  // 這點(經緯度)在不在別條、比 top 低的路的路面上(橋墩用)
  function onLowerRoad(p, self, top) {
    var g = wayGrid(), x = p[0] * KX, y = p[1] * KY, cx = Math.floor(x / 50), cy = Math.floor(y / 50);
    for (var a = cx - 1; a <= cx + 1; a++) for (var b = cy - 1; b <= cy + 1; b++) {
      var list = g[a + ',' + b] || [];
      for (var q = 0; q < list.length; q++) {
        var w = list[q][0], i = list[q][1];
        if (w === self || Math.min(w.H[i], w.H[i + 1]) >= top) continue;
        var A = w.coords[i], Bc = w.coords[i + 1], ax = A[0] * KX, ay = A[1] * KY, dx = Bc[0] * KX - ax, dy = Bc[1] * KY - ay, L2 = dx * dx + dy * dy;
        if (!L2) continue;
        var t = ((x - ax) * dx + (y - ay) * dy) / L2;
        if (t < 0 || t > 1) continue;
        if (Math.abs((x - ax) * dy - (y - ay) * dx) / Math.sqrt(L2) < w.W[i] / 2 + 1.5) return true;
      }
    }
    return false;
  }

  // ── 畫在橋面上的線：路況綠線、塞車顏色、導航路線(含已行駛的灰色、箭頭)、車子 ──
  // 高架抬高後，地圖上畫在地面的線會跟橋面錯開，所以放大到看得到 3D 時：
  //   - 國道、快速道路的綠色底圖(snm-roads-*-freeway)改畫在每條 3D 路面上，地面那份藏起來(隧道裡的留著)
  //   - 塞車路段、導航路線：把線對到 3D 路面上(每 5 公尺一點，找方向一樣、12 公尺內的路；疊在一起的高架 / 平面用「接得上的那條」決定)，
  //     對到的那段畫在路面上，地面那份只留沒對到的部分(一般道路還是畫在地面)
  //   - 車子：在高架上時圖示往上移到橋面的高度
  //   已行駛的灰色不再接手那份資料(每 0.12 秒更新，整段重比對很卡、又只能幾秒算一次 → 一段一段消失)：
  //   改成照「車子在路線上的那一點」(主程式給的 window._snmPassedPoint)把橋面上的路線切開，前面原色、後面灰色，每 0.25 秒更新
  var OV_SRC = { navRoute: 'route', 'snm-traffic-src': 'traffic' };
  var OV_STYLE = {   // 每種線：外框寬、內線寬(公尺)、高度(比路面高一點，順序：綠色底圖 < 塞車 / 路線 < 已行駛灰色)
    green: { cw: 3.2, iw: 2.4, y: 0.065 }, traffic: { cw: 3.2, iw: 2.4, y: 0.075 }, route: { cw: 3.2, iw: 2.4, y: 0.075 }, passed: { cw: 3.2, iw: 2.4, y: 0.085 }
  };
  var ovData = {}, ovItems = [], ovTimer = null, ovGreen = false, ovCache = {}, ovSig = '', ovLast = 0;
  // 接手這些圖層的資料：原本的 setData 先存起來，算好「地面那份」再交給它
  function hookSources() {
    var m = window.map;
    Object.keys(OV_SRC).forEach(function (id) {
      var src = m.getSource(id);
      if (!src || src._snmOrig) return;
      var orig = src.setData.bind(src);
      src._snmOrig = orig;
      ovData[OV_SRC[id]] = src._data && typeof src._data === 'object' ? src._data : null;
      src.setData = function (d) { ovData[OV_SRC[id]] = d; ovSoon(); return src; };
    });
  }
  // 最多每 1.5 秒重算一次(導航中路線、已行駛的灰色每秒都在更新，每次都重算會卡)
  function ovSoon() { clearTimeout(ovTimer); ovTimer = setTimeout(function () { ovLast = Date.now(); applyOverlays(); }, Math.max(120, 1500 - (Date.now() - ovLast))); }
  // 地面的國道綠線：放大到 3D 出現時藏起來(改畫在路面上)；底圖自己的國道線(隧道除外)也一起藏，不然高架底下的地面會露出一條
  function hideFlatFreeway() {
    var m = window.map;
    var base = ((m.getStyle() || {}).layers || []).filter(function (l) { return l.type === 'line' && /motorway|trunk/.test(l.id) && !/tunnel/.test(l.id) && !/^snm-/.test(l.id); }).map(function (l) { return l.id; });
    ['snm-roads-outline-freeway', 'snm-roads-line-freeway'].forEach(function (id) {
      if (!m.getLayer(id) || m.getLayer(id)._snm3d) return;
      var cur = m.getPaintProperty(id, 'line-opacity');
      if (Array.isArray(cur)) return;   // 已經是跟縮放有關的設定：不動
      var v = typeof cur === 'number' ? cur : 1;
      m.setPaintProperty(id, 'line-opacity', ['step', ['zoom'], v, MIN_ZOOM, 0]);   // 隧道也有 3D 路面了
      m.getLayer(id)._snm3d = true;
    });
    base.forEach(function (id) {
      if (!m.getLayer(id) || m.getLayer(id)._snm3d) return;
      var cur = m.getPaintProperty(id, 'line-opacity');
      if (Array.isArray(cur)) return;
      m.setPaintProperty(id, 'line-opacity', ['step', ['zoom'], typeof cur === 'number' ? cur : 1, MIN_ZOOM, 0]);
      m.getLayer(id)._snm3d = true;
    });
  }
  // 這點(方向 dir)附近的路：[{ w, f(在那條路的比例), lat, opp(雙向道路的反方向) }]
  function candidates(p, dir) {
    var g = wayGrid(), out = {}, x = p[0] * KX, y = p[1] * KY, cx = Math.floor(x / 50), cy = Math.floor(y / 50);
    for (var a = cx - 1; a <= cx + 1; a++) for (var b = cy - 1; b <= cy + 1; b++) (g[a + ',' + b] || []).forEach(function (e) {
      var w = e[0], i = e[1], A = w.coords[i], Bc = w.coords[i + 1];
      var ax = A[0] * KX, ay = A[1] * KY, dx = Bc[0] * KX - ax, dy = Bc[1] * KY - ay, L2 = dx * dx + dy * dy;
      if (!L2) return;
      var t = ((x - ax) * dx + (y - ay) * dy) / L2;
      if (t < -0.02 || t > 1.02) return;
      t = Math.max(0, Math.min(1, t));
      var L = Math.sqrt(L2), lat = Math.abs((x - ax) * dy - (y - ay) * dx) / L, cos = (dx * dir[0] + dy * dir[1]) / L;
      if (lat > 12) return;
      var opp = false;
      if (cos < 0.8) { if (w.oneway || cos > -0.8) return; opp = true; }
      var f = (w._len[i] + L * t) / w._L, o = out[w.id];
      if (!o || lat < o.lat) out[w.id] = { w: w, f: f, lat: lat, opp: opp };
    });
    return Object.keys(out).map(function (k) { return out[k]; });
  }
  // 兩條路有接在一起(一條的頭 / 尾是另一條上的點)
  function keysOf(w) {
    if (!w._keys) { w._keys = {}; w.coords.forEach(function (c) { w._keys[c[0].toFixed(6) + ',' + c[1].toFixed(6)] = 1; }); }
    return w._keys;
  }
  function connected(A, B) {
    if (A === B) return true;
    var key = A.id + '|' + B.id;
    if (connected.memo[key] !== undefined) return connected.memo[key];
    var ends = function (w) { var c = w.coords; return [c[0], c[c.length - 1]].map(function (p) { return p[0].toFixed(6) + ',' + p[1].toFixed(6); }); };
    var kb = keysOf(B), ka = keysOf(A);
    var r = ends(A).some(function (k) { return kb[k]; }) || ends(B).some(function (k) { return ka[k]; });
    connected.memo[key] = connected.memo[B.id + '|' + A.id] = r;
    return r;
  }
  connected.memo = {};
  // 一條線對到路面上：回傳 { on: [{ w, f0, f1, opp }], off: [[座標...], ...] }
  function matchLine(coords) {
    var samples = [], acc = 0, i;
    for (i = 0; i < coords.length - 1; i++) {
      var A = coords[i], Bc = coords[i + 1], L = Math.hypot((Bc[0] - A[0]) * KX, (Bc[1] - A[1]) * KY);
      if (!L) continue;
      var dir = [(Bc[0] - A[0]) * KX / L, (Bc[1] - A[1]) * KY / L], m = Math.max(1, Math.ceil(L / 5));
      for (var j = 0; j < m; j++) { var t = (j + 0.5) / m; samples.push({ p: [A[0] + (Bc[0] - A[0]) * t, A[1] + (Bc[1] - A[1]) * t], dir: dir, d: acc + L * t }); }
      acc += L;
    }
    if (!samples.length) return { on: [], off: [coords] };
    // 動態規劃：每點選一條路(或「不在 3D 路面上」)，同一條 / 接得上的路成本低，跳到沒接在一起的路成本高
    var NONE = 5, prev = null, back = [];
    samples.forEach(function (sm) {
      var st = candidates(sm.p, sm.dir).map(function (c) { return { c: c, e: c.lat / 2 }; });
      st.push({ c: null, e: NONE });
      st.forEach(function (s) {
        if (!prev) { s.cost = s.e; s.from = -1; return; }
        var best = Infinity, bi = -1;
        prev.forEach(function (q, qi) {
          var tr = !s.c && !q.c ? 0 : !s.c || !q.c ? 2 : q.c.w === s.c.w ? 0 : connected(q.c.w, s.c.w) ? 1 : 25;
          if (q.cost + tr < best) { best = q.cost + tr; bi = qi; }
        });
        s.cost = best + s.e; s.from = bi;
      });
      back.push(st); prev = st;
    });
    var pick = [], bi = 0, last = back[back.length - 1];
    last.forEach(function (s, si) { if (s.cost < last[bi].cost) bi = si; });
    for (var k = back.length - 1; k >= 0; k--) { pick[k] = back[k][bi].c; bi = back[k][bi].from; }
    // 連續同一條路 → 一段；沒對到的 → 地面那份
    var on = [], off = [], run = null, offStart = null, half = 2.5;
    for (k = 0; k < samples.length; k++) {
      var c = pick[k];
      if (c) {
        if (offStart !== null) { off.push(slice(coords, offStart, samples[k].d - half)); offStart = null; }
        var df = half / c.w._L;
        if (run && run.w === c.w) { run.f0 = Math.min(run.f0, c.f - df); run.f1 = Math.max(run.f1, c.f + df); }
        else { run = { w: c.w, f0: c.f - df, f1: c.f + df, opp: c.opp }; on.push(run); }
      } else {
        run = null;
        if (offStart === null) offStart = k === 0 ? 0 : samples[k].d - half;
      }
    }
    if (offStart !== null) off.push(slice(coords, offStart, acc));
    return { on: on, off: off.filter(function (x) { return x.length > 1; }) };
  }
  function slice(coords, d0, d1) {   // 沿線距離 d0 ~ d1 那段
    var out = [], acc = 0;
    for (var i = 0; i < coords.length - 1; i++) {
      var A = coords[i], Bc = coords[i + 1], L = Math.hypot((Bc[0] - A[0]) * KX, (Bc[1] - A[1]) * KY);
      if (!L) continue;
      var a = Math.max(d0, acc), b = Math.min(d1, acc + L);
      if (b > a) {
        if (!out.length) out.push([A[0] + (Bc[0] - A[0]) * (a - acc) / L, A[1] + (Bc[1] - A[1]) * (a - acc) / L]);
        out.push([A[0] + (Bc[0] - A[0]) * (b - acc) / L, A[1] + (Bc[1] - A[1]) * (b - acc) / L]);
      }
      acc += L;
    }
    return out;
  }
  // 把線切成「在範圍裡 / 外」的幾段(整條路線 150 公里只對畫面附近那段)
  function splitByBox(lines, b) {
    var out = [], inB = function (c) { return c[0] >= b.w && c[0] <= b.e && c[1] >= b.s && c[1] <= b.n; };
    lines.forEach(function (cs) {
      var cur = null;
      for (var i = 0; i < cs.length; i++) {
        var ins = inB(cs[i]);
        if (!cur || cur.inside !== ins) { if (cur) { cur.c.push(cs[i]); out.push(cur); } cur = { inside: ins, c: i ? [cs[i - 1], cs[i]] : [cs[i]] }; }
        else cur.c.push(cs[i]);
      }
      if (cur && cur.c.length > 1) out.push(cur);
    });
    return out;
  }
  function linesOf(f) {
    var g = f && f.geometry;
    if (!g) return [];
    return g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
  }
  function loadedBox() {
    var e = null;
    Object.keys(tiles).forEach(function (k) { var x = tiles[k].ext; if (!x || !tiles[k].ids.length) return; e = e ? { w: Math.min(e.w, x.w), e: Math.max(e.e, x.e), s: Math.min(e.s, x.s), n: Math.max(e.n, x.n) } : { w: x.w, e: x.e, s: x.s, n: x.n }; });
    return e;
  }
  function active() { var m = window.map; return !!(m && m.getLayer(LAYER) && m.getZoom() >= MIN_ZOOM); }
  // 重算：哪些線畫在路面上、地面那份剩什麼
  function applyOverlays() {
    var m = window.map;
    if (!m) return;
    hookSources();
    var on = active(), items = [], box = loadedBox();
    wayGrid();
    Object.keys(OV_SRC).forEach(function (id) {
      var kind = OV_SRC[id], src = m.getSource(id), data = ovData[kind];
      if (!src || !src._snmOrig) return;
      // 資料、抓到的路、放大縮小都沒變：沿用上次算好的(不重算、也不重設地面那份)
      var c = ovCache[kind];
      if (c && c.data === data && c.gCount === gCount && c.on === on) { items.push.apply(items, c.items); return; }
      // 已行駛的灰色每秒都在變長：最多每 5 秒重算一次
      if (c && kind === 'passed' && c.on === on && Date.now() - c.at < 5000) { items.push.apply(items, c.items); ovSoon(); return; }
      var mine = [];
      ovCache[kind] = { data: data, gCount: gCount, on: on, items: mine, at: Date.now() };
      if (!data || !data.features) { if (data) src._snmOrig(data); return; }
      if (!on || !box) { src._snmOrig(data); return; }
      var keep = [], seq = 0;   // 路線的每一段照前進順序編號(切開已行駛用)
      data.features.forEach(function (f) {
        var p = f.properties || {}, lines = linesOf(f);
        if (!lines.length || (kind === 'traffic' && p.roadClass !== 'motorway' && p.roadClass !== 'trunk')) { keep.push(f); return; }
        splitByBox(lines, box).forEach(function (part) {
          if (!part.inside) { keep.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: part.c }, properties: p }); return; }
          var r = matchLine(part.c);
          r.on.forEach(function (x) { mine.push({ kind: kind, seq: seq++, w: x.w, f0: x.f0, f1: x.f1, opp: x.opp, color: p.color || (kind === 'passed' ? '#C9CDD2' : '#16E098'), casing: p.casing || (kind === 'passed' ? '#9AA0A6' : kind === 'traffic' ? ({ moderate: '#B07C00', slow: '#B34C00', congested: '#A32020', severe: '#4F0000' }[p.trafficLevel] || '#009B65') : '#009B65') }); });
          r.off.forEach(function (c2) { keep.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: c2 }, properties: p }); });
        });
      });
      src._snmOrig({ type: 'FeatureCollection', features: keep });
      items.push.apply(items, mine);
    });
    // 綠色底圖：地面那份看得到的時候(導航中整個藏起來)，每條國道、快速道路的 3D 路面都畫綠線
    ovGreen = on && !!m.getLayer('snm-roads-line-freeway') && m.getLayoutProperty('snm-roads-line-freeway', 'visibility') !== 'none';
    if (on) hideFlatFreeway();
    // 畫在路面上的線跟上次一樣就不用重建
    var sig = (ovGreen ? 'G' : '') + items.map(function (it) { return it.kind + it.w.id + ':' + it.f0.toFixed(4) + '-' + it.f1.toFixed(4) + it.color; }).join('|');
    if (items.filter(function (it) { return it.kind === 'route'; }).length !== ovItems.filter(function (it) { return it.kind === 'route'; }).length) { passCut = null; passLast = null; }   // 換路線：已行駛重算
    ovItems = items;
    if (sig === ovSig) { m.triggerRepaint(); return; }
    ovSig = sig;
    Object.keys(tiles).forEach(function (k) { if (tiles[k].chunk) addOverlay(tiles[k].chunk); });
    m.triggerRepaint();
  }
  // 每塊模型的疊線(換資料時整組重建)
  // 每塊模型的疊線：綠線＋塞車(換資料時重建)、導航路線(另外一組，已行駛前進時只重建這組)
  function addOverlay(chunk) {
    if (chunk.ov) { chunk.scene.remove(chunk.ov); chunk.ov.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); chunk.ov = null; }
    if (!chunk.geo) return;
    var list = [];
    ovItems.forEach(function (it) { if (it.kind !== 'route') list.push(it); });
    chunk.ov = overlayGroup(chunk, list, ovGreen);
    if (chunk.ov) chunk.scene.add(chunk.ov);
    addRouteOverlay(chunk);
  }
  function addRouteOverlay(chunk) {
    if (chunk.ovRoute) { chunk.scene.remove(chunk.ovRoute); chunk.ovRoute.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); chunk.ovRoute = null; }
    if (!chunk.geo) return;
    var list = [];
    ovItems.forEach(function (it) {
      if (it.kind !== 'route') return;
      // 已行駛的切開：前面的段全灰、切到的那段分成灰 + 原色、後面的照原色
      if (passCut && it.seq < passCut.seq) { list.push(Object.assign({}, it, { kind: 'passed', color: '#C9CDD2', casing: '#9AA0A6' })); return; }
      if (passCut && it.seq === passCut.seq) {
        var fp = passCut.f, lo = Math.min(it.f0, it.f1), hi = Math.max(it.f0, it.f1);
        if (it.opp) { list.push(Object.assign({}, it, { f0: fp, f1: hi, kind: 'passed', color: '#C9CDD2', casing: '#9AA0A6' }), Object.assign({}, it, { f0: lo, f1: fp })); }
        else { list.push(Object.assign({}, it, { f0: lo, f1: fp, kind: 'passed', color: '#C9CDD2', casing: '#9AA0A6' }), Object.assign({}, it, { f0: fp, f1: hi })); }
        return;
      }
      list.push(it);
    });
    chunk.ovRoute = list.length ? overlayGroup(chunk, list, false) : null;
    if (chunk.ovRoute) chunk.scene.add(chunk.ovRoute);
  }
  function overlayGroup(chunk, items, green) {
    var T = window.THREE;
    var buckets = {}, bk = function (color) { return (buckets[color] = buckets[color] || new Bucket()); };
    var byWay = {};
    items.forEach(function (it) { (byWay[it.w.id] = byWay[it.w.id] || []).push(it); });
    chunk.geo.forEach(function (g) {
      var list = (byWay[g.w.id] || []).slice();
      if (green) list.unshift({ kind: 'green', f0: 0, f1: 1, opp: false, color: '#16E098', casing: '#009B65' });
      list.forEach(function (it) {
        var st = OV_STYLE[it.kind], s0 = Math.max(0, Math.min(it.f0, it.f1)) * g.L, s1 = Math.min(1, Math.max(it.f0, it.f1)) * g.L;
        if (s1 - s0 < 0.05) return;
        // 線的中心：單行道 = 車道中間；雙向道路 = 自己方向那半邊中間
        var c = function (k) { return !g.w.oneway ? (it.opp ? g.a[k] / 2 : g.b[k] / 2) : (g.a[k] + g.b[k]) / 2; };
        [[st.cw, it.casing, st.y], [st.iw, it.color, st.y + 0.005]].forEach(function (band) {
          var b = bk(band[1]), hw = band[0] / 2;
          for (var k = 0; k < g.P.length - 1; k++) {
            var u0 = Math.max(s0, g.S[k]), u1 = Math.min(s1, g.S[k + 1]);
            if (u1 - u0 < 0.05) continue;
            var len = g.S[k + 1] - g.S[k] || 1, t0 = (u0 - g.S[k]) / len, t1 = (u1 - g.S[k]) / len;
            var at = function (t, o) {
              var r = t <= 0 ? g.R[k] : t >= 1 ? g.R[k + 1] : g.segR[k], cc = c(k) + (c(k + 1) - c(k)) * t;
              return [g.P[k][0] + (g.P[k + 1][0] - g.P[k][0]) * t + r[0] * (cc + o), g.H[k] + (g.H[k + 1] - g.H[k]) * t + band[2], g.P[k][1] + (g.P[k + 1][1] - g.P[k][1]) * t + r[1] * (cc + o)];
            };
            b.quad(at(t0, -hw), at(t0, hw), at(t1, hw), at(t1, -hw));
          }
        });
        // 導航路線(還沒走到的)：白色箭頭(每 20 公尺一個 ^，尖端朝行車方向)
        if (it.kind === 'route') {
          var dirSign = it.opp ? -1 : 1, white = bk('#FFFFFF');
          for (var sp = Math.ceil(s0 / 20) * 20 + 10; sp < s1 - 2; sp += 20) {
            var k = 0; while (k < g.P.length - 2 && g.S[k + 1] < sp) k++;
            var t = (sp - g.S[k]) / ((g.S[k + 1] - g.S[k]) || 1), r = g.segR[k], fw = [r[1] * dirSign, -r[0] * dirSign];   // 前進方向
            var cc = c(k) + (c(k + 1) - c(k)) * t, cx = g.P[k][0] + (g.P[k + 1][0] - g.P[k][0]) * t + r[0] * cc, cz = g.P[k][1] + (g.P[k + 1][1] - g.P[k][1]) * t + r[1] * cc;
            var y = g.H[k] + (g.H[k + 1] - g.H[k]) * t + 0.095, tip = [cx + fw[0] * 0.6, cz + fw[1] * 0.6];
            [-1, 1].forEach(function (sd) {
              var tail = [cx - fw[0] * 0.5 + r[0] * sd * 0.8, cz - fw[1] * 0.5 + r[1] * sd * 0.8], nx = (tail[1] - tip[1]), nz = -(tail[0] - tip[0]), nl = Math.hypot(nx, nz) || 1, h2 = 0.13;
              white.quad([tip[0] + nx / nl * h2, y, tip[1] + nz / nl * h2], [tip[0] - nx / nl * h2, y, tip[1] - nz / nl * h2], [tail[0] - nx / nl * h2, y, tail[1] - nz / nl * h2], [tail[0] + nx / nl * h2, y, tail[1] + nz / nl * h2]);
            });
          }
        }
      });
    });
    var keys = Object.keys(buckets);
    if (!keys.length) return null;
    var group = new T.Group();
    keys.forEach(function (color) {
      var g2 = new T.BufferGeometry();
      g2.setAttribute('position', new T.Float32BufferAttribute(buckets[color].p, 3));
      var mesh = new T.Mesh(g2, ovMat(color));
      mesh.renderOrder = 3; mesh.frustumCulled = false;
      group.add(mesh);
    });
    return group;
  }
  // 已行駛切開的位置：{ seq: 路線第幾段, f: 那段的路上的比例 }；每 0.25 秒照主程式給的點(window._snmPassedPoint)往前找
  var passCut = null, passLast = null;
  function updatePassCut() {
    var p = window._snmPassedPoint, m = window.map;
    if (!p || !m || document.hidden || !active()) { if (passCut && !p) { passCut = null; passLast = null; refreshRoute(); } return; }
    if (passLast && Math.abs(p.lng - passLast.lng) * KX < 2 && Math.abs(p.lat - passLast.lat) * KY < 2) return;   // 動不到 2 公尺不用重畫
    passLast = { lng: p.lng, lat: p.lat };
    var routes = ovItems.filter(function (it) { return it.kind === 'route'; });
    if (!routes.length) return;
    var x = p.lng * KX, y = p.lat * KY, best = null, from = passCut ? passCut.seq : 0;
    routes.forEach(function (it) {
      if (it.seq < from - 1 || it.seq > from + 8) return;   // 只往前找附近幾段(不會跳到很遠、也不會往回)
      var w = it.w, lo = Math.min(it.f0, it.f1) * w._L, hi = Math.max(it.f0, it.f1) * w._L;
      for (var i = 0; i < w.coords.length - 1; i++) {
        if (w._len[i + 1] < lo || w._len[i] > hi) continue;
        var A = w.coords[i], B = w.coords[i + 1], ax = A[0] * KX, ay = A[1] * KY, dx = B[0] * KX - ax, dy = B[1] * KY - ay, L2 = dx * dx + dy * dy;
        if (!L2) continue;
        var t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)), d = Math.hypot(x - ax - dx * t, y - ay - dy * t);
        if (d > 15 || (best && d >= best.d)) continue;
        best = { d: d, seq: it.seq, f: Math.max(lo, Math.min(hi, w._len[i] + Math.sqrt(L2) * t)) / w._L };
      }
    });
    if (!best) {   // 車子不在 3D 路面的路線上(一般道路那段)：前面全部算走過
      var before = routes.filter(function (it) { return it.seq >= from; })[0];
      if (passCut && before && before.seq > passCut.seq) { passCut = { seq: before.seq, f: before.opp ? Math.max(before.f0, before.f1) : Math.min(before.f0, before.f1) }; refreshRoute(); }
      return;
    }
    if (passCut && best.seq === passCut.seq && Math.abs(best.f - passCut.f) * 1e5 < 1) return;
    passCut = { seq: best.seq, f: best.f };
    refreshRoute();
  }
  // 只重建有導航路線的那幾塊模型的路線那組
  function refreshRoute() {
    var ids = {};
    ovItems.forEach(function (it) { if (it.kind === 'route') ids[it.w.id] = 1; });
    Object.keys(tiles).forEach(function (k) { var ch = tiles[k].chunk; if (ch && ch.geo && ch.geo.some(function (g) { return ids[g.w.id]; })) addRouteOverlay(ch); });
    if (window.map) window.map.triggerRepaint();
  }
  setInterval(updatePassCut, 250);

  var ovMats = {};
  function ovMat(color) {
    var T = window.THREE;
    return ovMats[color] || (ovMats[color] = new T.MeshBasicMaterial({ color: new T.Color(color), side: T.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  }
  // 那條路在比例 f 的地方的形狀(從已經建好的模型找)
  function geoAt(w, f) {
    var out = null;
    Object.keys(tiles).some(function (k) {
      var ch = tiles[k].chunk, g = ch && ch.geo && ch.geo.find(function (x) { return x.w === w; });
      if (!g) return false;
      var s = f * g.L, i = 0; while (i < g.S.length - 2 && g.S[i + 1] < s) i++;
      var t = (s - g.S[i]) / ((g.S[i + 1] - g.S[i]) || 1), li = function (arr) { return arr[i] + (arr[i + 1] - arr[i]) * t; };
      out = { h: li(g.H), half: li(g.half), nhalf: li(g.nhalf) };
      return true;
    });
    return out;
  }

  // 車子：在 3D 路面上時往上移到路面的高度(圖示往螢幕上方平移)
  var CAR_LAYERS = ['user-car', 'user-car-plate', 'user-car-avatar', 'user-compass'], carWay = null, carShift = [0, 0], lastMatrix = null;
  function carHeight() {
    var m = window.map, src = m.getSource('user-pos'), d = src && src._data, f = d && d.features && d.features[0];
    if (!f || !f.geometry) return null;
    var p = f.geometry.coordinates, hd = ((f.properties && f.properties.heading) || 0) * Math.PI / 180, dir = [Math.sin(hd), Math.cos(hd)];
    var cs = candidates(p, dir);
    if (!cs.length) { carWay = null; return { p: p, h: 0 }; }
    var routeWays = {}; ovItems.forEach(function (it) { if (it.kind === 'route') routeWays[it.w.id] = 1; });
    var pick = cs.find(function (c) { return carWay && c.w === carWay; }) || cs.find(function (c) { return routeWays[c.w.id]; }) || cs.sort(function (a, b) { return a.lat - b.lat; })[0];
    carWay = pick.w;
    var g = geoAt(pick.w, pick.f);
    return { p: p, h: g ? g.h : 0 };
  }
  function liftCar() {
    var m = window.map;
    if (!m || !lastMatrix) return;
    var c = active() ? carHeight() : null, dx = 0, dy = 0;
    if (c && c.h > 0.3) {
      var mc = maplibregl.MercatorCoordinate.fromLngLat(c.p, 0), z = c.h * mc.meterInMercatorCoordinateUnits(), M = lastMatrix;
      var proj = function (zz) { var x = M[0] * mc.x + M[4] * mc.y + M[8] * zz + M[12], y = M[1] * mc.x + M[5] * mc.y + M[9] * zz + M[13], w = M[3] * mc.x + M[7] * mc.y + M[11] * zz + M[15]; return w > 1e-9 ? [x / w, y / w] : null; };
      var g0 = proj(0), g1 = proj(z), cv = m.getCanvas();
      if (g0 && g1) { dx = (g1[0] - g0[0]) / 2 * cv.clientWidth; dy = -(g1[1] - g0[1]) / 2 * cv.clientHeight; }   // 車子在鏡頭後面時不算
    }
    if (Math.abs(dx - carShift[0]) < 0.5 && Math.abs(dy - carShift[1]) < 0.5) return;
    carShift = [dx, dy];
    CAR_LAYERS.forEach(function (id) {
      if (!m.getLayer(id)) return;
      if (m.getPaintProperty(id, 'icon-translate-anchor') !== 'viewport') m.setPaintProperty(id, 'icon-translate-anchor', 'viewport');
      m.setPaintProperty(id, 'icon-translate', [Math.round(dx * 10) / 10, Math.round(dy * 10) / 10]);
    });
  }
  // 電子看板查路面高度：這點(經緯度)最近的 3D 路面 → { h 高度, bearing, side 在路中心右邊幾公尺, half, nhalf, ... }
  // 電子看板門架：這點附近、跟看板同方向的主線(單行道，找不到才用匝道) → 那一點的路中心、方向、高度、路面左右邊緣(公尺，右正)
  window._snmRoad3dSpan = function (lon, lat, bearing) {
    wayGrid();
    var b = bearing * Math.PI / 180, cs = candidates([lon, lat], [Math.sin(b), Math.cos(b)]).filter(function (c) { return c.w.oneway && !c.opp && c.lat < 40; });
    if (!cs.length) return null;
    cs.sort(function (x, y) { return (x.w.link - y.w.link) || (x.lat - y.lat); });
    var w = cs[0].w, f = cs[0].f, g = geoAt(w, f);
    if (!g) return null;
    // 路中心那一點的經緯度、方向
    var d = f * w._L, i = 0; while (i < w.coords.length - 2 && w._len[i + 1] < d) i++;
    var A = w.coords[i], Bc = w.coords[i + 1], t = (d - w._len[i]) / ((w._len[i + 1] - w._len[i]) || 1);
    var lon0 = A[0] + (Bc[0] - A[0]) * t, lat0 = A[1] + (Bc[1] - A[1]) * t;
    // 中央分隔島中心：左邊對向車道(單行主線)的路面左緣跟這條路面左緣的正中間(門架左柱插在那裡：花台的樹籬中間、一道護欄的中心)
    var med = null, opp = null, gr = wayGrid(), px = lon0 * KX, py = lat0 * KY, fx = Math.sin(b), fy = Math.cos(b), cx0 = Math.floor(px / 50), cy0 = Math.floor(py / 50);
    for (var ga = cx0 - 1; ga <= cx0 + 1; ga++) for (var gb = cy0 - 1; gb <= cy0 + 1; gb++) (gr[ga + ',' + gb] || []).forEach(function (e) {
      var o = e[0], k = e[1];
      if (o === w || !o.oneway || o.link) return;
      var P0 = o.coords[k], P1 = o.coords[k + 1], ax = P0[0] * KX, ay = P0[1] * KY, dx = P1[0] * KX - ax, dy = P1[1] * KY - ay, L2 = dx * dx + dy * dy;
      if (!L2) return;
      var Ls = Math.sqrt(L2);
      if ((dx * fx + dy * fy) / Ls > -0.8) return;   // 方向相反
      var tt = ((px - ax) * dx + (py - ay) * dy) / L2;
      if (tt < 0 || tt > 1) return;
      var qx = ax + dx * tt - px, qy = ay + dy * tt - py, left = -qx * fy + qy * fx;   // 往左為正
      if (left <= 0 || left > 40 || (opp && left >= opp.d)) return;
      opp = { w: o, d: left, f: (o._len[k] + Ls * tt) / o._L };
    });
    if (opp) { var go = geoAt(opp.w, opp.f); if (go && Math.abs(go.h - g.h) < 1) med = -(opp.d + Math.abs(g.nhalf) - Math.abs(go.nhalf)) / 2; }
    return { lon: lon0, lat: lat0, bearing: (Math.atan2((Bc[0] - A[0]) * KX, (Bc[1] - A[1]) * KY) * 180 / Math.PI + 360) % 360,
      h: g.h, left: g.nhalf, right: g.half, med: med, link: w.link, id: w.id };
  };
  window._snmRoad3dAt = function (lon, lat, maxD) {
    var g = wayGrid(), x = lon * KX, y = lat * KY, cx = Math.floor(x / 50), cy = Math.floor(y / 50), best = null;
    for (var a = cx - 1; a <= cx + 1; a++) for (var b = cy - 1; b <= cy + 1; b++) (g[a + ',' + b] || []).forEach(function (e) {
      var w = e[0], i = e[1], A = w.coords[i], Bc = w.coords[i + 1], ax = A[0] * KX, ay = A[1] * KY, dx = Bc[0] * KX - ax, dy = Bc[1] * KY - ay, L2 = dx * dx + dy * dy;
      if (!L2) return;
      var t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)), L = Math.sqrt(L2);
      var side = ((x - ax) * dy - (y - ay) * dx) / L, d = Math.hypot(x - ax - dx * t, y - ay - dy * t);   // 右正
      if (d > (maxD || 25) || (best && d >= best.d)) return;
      best = { d: d, w: w, f: (w._len[i] + L * t) / w._L, side: side, bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 };
    });
    if (!best) return null;
    var gg = geoAt(best.w, best.f);
    return gg ? { h: gg.h, half: gg.half, nhalf: gg.nhalf, bearing: best.bearing, side: best.side, oneway: best.w.oneway, link: best.w.link, id: best.w.id } : null;
  };

  // ── 路燈開關：晚上 6 點到早上 6 點亮燈 ──
  function lampColor() { var h = new Date().getHours(); return h >= 18 || h < 6 ? 0xFFF1C2 : 0x9AA0A6; }
  setInterval(function () {
    if (!mats || document.hidden) return;
    var c = lampColor();
    if (mats.lamp.color.getHex() !== c) { mats.lamp.color.setHex(c); if (window.map) window.map.triggerRepaint(); }
  }, 60000);

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
      lastMatrix = matrix;
      if (!liftTimer) liftTimer = setTimeout(function () { liftTimer = null; liftCar(); }, 100);   // 車子抬到橋面(不在畫面更新中改圖層)
      if (!renderer || m.getZoom() < DRAW_ZOOM) return;
      var T = window.THREE, mapM = new T.Matrix4().fromArray(matrix), b = m.getBounds(), detail = m.getZoom() >= DETAIL_ZOOM;
      Object.keys(tiles).forEach(function (k) {
        var c = tiles[k].chunk;
        if (!c || c.box.e < b.getWest() || c.box.w > b.getEast() || c.box.n < b.getSouth() || c.box.s > b.getNorth()) return;
        if (c.detail !== detail) { c.detail = detail; c.scene.traverse(function (o) { if (o.userData && o.userData.detail) o.visible = detail; }); }
        camera.projectionMatrix = mapM.clone().multiply(c.matrix);
        renderer.resetState();
        renderer.render(c.scene, camera);
      });
    }
  };
  // 放在平面道路線、導航路線、塞車線的上面(高架底下經過的路被橋面蓋住)、路線箭頭、3D 建築的下面
  //   (主程式會把路線類圖層整組重排到 3D 建築下面，排完 3D 道路會被擠到它們底下：init 裡圖層一變動就放回來)
  //   zoom 16 以下：放在綠色道路線下面(綠線照樣畫在 3D 路面上)
  function beforeId(m) {
    if (m.getZoom() < MIN_ZOOM) { var gl = ((m.getStyle() || {}).layers || []).find(function (l) { return /^snm-roads-/.test(l.id); }); if (gl) return gl.id; }
    if (m.getLayer('navRoute-arrows')) return 'navRoute-arrows';
    var ls = (m.getStyle() || {}).layers || [], bl = ls.find(function (l) { return l.type === 'fill-extrusion' && l.id !== 'route'; });
    if (bl) return bl.id;
    return m.getLayer('user-pulse') ? 'user-pulse' : undefined;
  }
  // 放到該在的位置；一般道路 3D(snm-road-3d-city)永遠在國道 3D 下面
  function place(m) {
    if (!m.getLayer(LAYER)) return;
    var bi = beforeId(m);
    try { if (bi) m.moveLayer(LAYER, bi); if (m.getLayer('snm-road-3d-city') && m.getZoom() < MIN_ZOOM) m.moveLayer('snm-road-3d-city', LAYER); } catch (e) {}
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
  var wasActive = false, liftTimer = null;
  function check() {
    var m = window.map;
    if (!m) return;
    var nowActive = m.getZoom() >= MIN_ZOOM;
    if (nowActive !== wasActive) {   // 放大 / 縮小跨過 16：地面的線換回完整的 / 只留沒對到路面的；3D 圖層換到綠線上面 / 下面
      wasActive = nowActive; ovSoon();
      place(m);
    }
    if (m.getZoom() < DRAW_ZOOM || !window.RoadShape) return;
    ensureThree(function () {
      if (!mats) makeMats();
      if (!m.getLayer(LAYER)) { m.addLayer(customLayer, beforeId(m)); }
      hookSources();
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
        requestBuild(t); t.usedAt = now;
      });
      // 太多塊就丟掉最久沒看的模型(資料留著，回來再建)
      var built = Object.keys(tiles).filter(function (k) { return tiles[k].chunk; }).sort(function (x, y) { return tiles[x].usedAt - tiles[y].usedAt; });
      while (built.length > MAX_CHUNKS) { var k0 = built.shift(); disposeChunk(tiles[k0].chunk); tiles[k0].chunk = null; }
      pump();
    });
  }
  // 換地圖樣式後圖層會被清掉，重加
  window._snmReloadRoad3d = function () {
    renderer = null; carShift = [0, 0];
    setTimeout(ovSoon, 300);   // 換樣式後圖層、資料來源都是新的：重新接手
    var m = window.map;
    if (window.THREE && m && m.getZoom() >= DRAW_ZOOM && mats && !m.getLayer(LAYER)) { m.addLayer(customLayer, beforeId(m)); }
  };
  window._snmRoad3dState = function () { return { tiles: tiles, ways: ways, threeState: threeState, ovGreen: ovGreen, ovItems: ovItems, carShift: carShift, passCut: passCut }; };   // 除錯用
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
    // 主程式重排路線圖層後，3D 道路放回路線箭頭(或 3D 建築)正下面
    var placing = false;
    m.on('styledata', function () {
      if (placing || !m.getLayer(LAYER)) return;
      var o = m.style && m.style._order, b = beforeId(m);
      var c = o && o.indexOf('snm-road-3d-city'), okCity = !(c >= 0 && m.getZoom() < MIN_ZOOM) || c === o.indexOf(LAYER) - 1;
      if (!o || !b || (o.indexOf(LAYER) === o.indexOf(b) - 1 && okCity)) return;
      placing = true; place(m); placing = false;
    });
    if (m.loaded()) go(); else m.once('load', go);
  }
  init();
})();
