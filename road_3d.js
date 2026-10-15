// ===== 🛣 國道、快速道路 3D 路面 =====
// 放大到 zoom 16 以上，把國道(motorway)、快速道路(trunk)與匝道畫成立體道路：
//   - 路面寬度照實際車道數：車道 3.75 公尺、外側路肩 3 公尺、內側路肩 1 公尺(匝道外側路肩 2 公尺)
//   - 標線：車道線白色虛線(線段 4 公尺、間距 6 公尺、線寬 10 公分)、外側路面邊線白色實線、內側路面邊線黃色實線；雙向道路中間雙黃線
//   - 出口、入口匝道分岔處：主線與匝道之間畫白色槽化線(外框＋斜紋)
//   - 護欄：外側鋼板護欄(W 型鋼板＋每 4 公尺一根立柱)、中央分隔混凝土護欄(紐澤西護欄)、橋上兩側混凝土護欄
//   - 匝道進出口(分流、匯流)那段不畫外側護欄，車道才接得起來
// 資料：OpenStreetMap 的車道數 lanes、單行道、橋梁，事先切成 zoom 13 圖磚的小檔案(road3d/，用 tools/build-road3d.js 產生)，
//       只抓畫面附近那幾塊、同一塊只抓一次。沒標車道數的用一般值：國道 3、快速道路 2、匝道 1。
//       檔案抓不到(離線)時改用底圖的道路線。
// 圖層放在路況綠線、導航路線的下面：路況顏色、導航路線、車子都照樣蓋在路面上看得到。
// 上下交錯的道路：由下往上一層一層畫(先平面、再一層橋、再二層橋…)，上層路面一定蓋住下層，不會互相裁切。
(function () {
  'use strict';
  var MIN_ZOOM = 16, TILE_Z = 13, MAX_CHUNKS = 16;
  var THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  var LAYER = 'snm-road-3d';
  var DATA_DIR = 'road3d/';
  var index = null, indexState = 'none';   // 有資料的圖磚清單
  var LANE = 3.75, DASH = 4, GAP = 6, LANE_LINE_W = 0.10;   // 車道線：線段 4 公尺、間距 6 公尺、線寬 10 公分

  var ways = {};            // id → way(全部抓到的，跨圖磚共用)
  var tiles = {};           // 'x/y' → { state: loading/ready/fallback/failed, ids: [...], chunk, usedAt, retryAt }
  var nodeIdx = {};         // 節點 key → [{ w, i }]：算匝道接點、橋梁高度用
  var renderer = null, camera = null, threeState = 'none', mats = null;
  var queue = [], busy = 0;

  // ── 圖磚 ──
  function lon2x(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
  function lat2y(lat, z) { var r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z)); }
  function x2lon(x, z) { return x / Math.pow(2, z) * 360 - 180; }
  function y2lat(y, z) { var n = Math.PI - 2 * Math.PI * y / Math.pow(2, z); return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); }
  function tileBox(x, y) { return { w: x2lon(x, TILE_Z), e: x2lon(x + 1, TILE_Z), n: y2lat(y, TILE_Z), s: y2lat(y + 1, TILE_Z) }; }
  function visibleTiles() {
    var m = window.map, b = m.getBounds(), out = [];
    var x0 = lon2x(b.getWest(), TILE_Z), x1 = lon2x(b.getEast(), TILE_Z), y0 = lat2y(b.getNorth(), TILE_Z), y1 = lat2y(b.getSouth(), TILE_Z);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 9) return out;   // 太傾斜、看太遠：不抓
    for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) out.push(x + '/' + y);
    return out;
  }

  // ── 資料 ──
  function num(v) { var n = parseInt(v, 10); return n > 0 ? n : 0; }
  function makeWay(id, cls, link, coords, nodes, t) {
    var oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === '-1' || t.oneway === true || (cls === 'motorway' && t.oneway !== 'no');
    if (t.oneway === '-1') { coords = coords.slice().reverse(); if (nodes) nodes = nodes.slice().reverse(); }
    var lanes = num(t.lanes) || (oneway ? (link ? 1 : cls === 'motorway' ? 3 : 2) : (link ? 2 : 4));
    var bridge = !!t.bridge && t.bridge !== 'no', layer = parseInt(t.layer, 10) || (bridge ? 1 : 0);
    return { id: id, cls: cls, link: link, coords: coords, nodes: nodes, oneway: oneway, lanes: Math.min(lanes, 8),
      bridge: bridge, layer: Math.max(0, layer) };
  }
  function fetchTile(key) {
    if (index && !index[key.replace('/', '_')]) return Promise.resolve([]);   // 這塊沒有國道、快速道路
    return fetch(DATA_DIR + TILE_Z + '/' + key.replace('/', '_') + '.json')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        return (j.w || []).map(function (r) {
          var f = r[1], d = r[4], x = d[0], y = d[1], coords = [[x / 1e6, y / 1e6]];
          for (var i = 2; i < d.length; i += 2) { x += d[i]; y += d[i + 1]; coords.push([x / 1e6, y / 1e6]); }
          return makeWay('o' + r[0], f & 2 ? 'trunk' : 'motorway', !!(f & 1), coords, null,
            { oneway: f & 4 ? 'yes' : 'no', lanes: r[2] || '', bridge: f & 8 ? 'yes' : '', layer: r[3] });
        });
      });
  }
  function loadIndex(cb) {
    if (indexState === 'ready' || indexState === 'failed') return cb();
    if (indexState === 'loading') return setTimeout(function () { loadIndex(cb); }, 200);
    indexState = 'loading';
    fetch(DATA_DIR + 'index.json').then(function (r) { return r.json(); }).then(function (list) {
      index = {}; list.forEach(function (k) { index[k] = 1; }); indexState = 'ready'; cb();
    }).catch(function () { indexState = 'failed'; cb(); });
  }
  // 備用：底圖的道路線(沒有車道數；圖磚邊界會切斷，用座標接起來)
  function fromBasemap(box) {
    var m = window.map, out = [], seen = {};
    if (!m.getSource('openmaptiles')) return out;
    var fs = m.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation', filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk']]] });
    fs.forEach(function (f, n) {
      var g = f.geometry, p = f.properties || {};
      if (p.brunnel === 'tunnel') return;
      (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []).forEach(function (c, j) {
        if (c.length < 2) return;
        var mid = c[Math.floor(c.length / 2)];
        if (mid[0] < box.w || mid[0] > box.e || mid[1] < box.s || mid[1] > box.n) return;
        var key = c[0].join() + c[c.length - 1].join();
        if (seen[key]) return; seen[key] = 1;
        out.push(makeWay('b' + key, p.class, p.ramp === 1, c, null,
          { oneway: p.oneway === 1 ? 'yes' : p.oneway === -1 ? '-1' : (p.class === 'motorway' ? 'yes' : 'no'), bridge: p.brunnel === 'bridge' ? 'yes' : '', layer: p.layer }));
      });
    });
    return out;
  }
  function nodeKey(w, i) { return w.coords[i][0].toFixed(6) + ',' + w.coords[i][1].toFixed(6); }   // OSM 相連的路共用同一個點，座標完全一樣
  function indexWay(w) {
    w.coords.forEach(function (c, i) { var k = nodeKey(w, i); (nodeIdx[k] = nodeIdx[k] || []).push({ w: w, i: i }); });
  }

  function pump() {
    while (busy < 2 && queue.length) {
      var key = queue.shift(), t = tiles[key];
      if (!t || t.state !== 'queued') continue;
      busy++; t.state = 'loading';
      (function (key, t) {
        var xy = key.split('/'), box = tileBox(+xy[0], +xy[1]);
        var go = function () {
          loadIndex(function () {
            fetchTile(key).then(function (list) { done(list, 'ready'); }).catch(function () {
              done(fromBasemap(box), 'fallback');   // 抓不到(離線)：先用底圖的線，1 分鐘後再試
            });
          });
        };
        var done = function (list, state) {
          busy--;
          // 跨圖磚的路：先抓到的那塊負責畫(只建一次)；模型範圍用路實際的範圍
          var mine = list.filter(function (w) { return !ways[w.id] || t.ids.indexOf(w.id) >= 0; });
          mine.forEach(function (w) { if (!ways[w.id]) { ways[w.id] = w; indexWay(w); } });
          t.ids = mine.map(function (w) { return w.id; });
          var ext = { w: 180, e: -180, s: 90, n: -90 };
          mine.forEach(function (w) { w.coords.forEach(function (c) { ext.w = Math.min(ext.w, c[0]); ext.e = Math.max(ext.e, c[0]); ext.s = Math.min(ext.s, c[1]); ext.n = Math.max(ext.n, c[1]); }); });
          t.ext = ext;
          t.state = state; t.retryAt = state === 'fallback' ? Date.now() + 60000 : 0;
          if (t.chunk) disposeChunk(t.chunk);
          t.chunk = threeState === 'ready' ? buildChunk(key) : null;
          window.map && window.map.triggerRepaint();
          if (window._snmOnRoad3dData) window._snmOnRoad3dData();   // 電子看板門架改對準路面
          pump();
        };
        go();
      })(key, t);
    }
  }

  // ── 高度：橋梁抬高(每層 1.2 公尺，剛好高過下面道路的護欄)，橋頭用引道慢慢降到地面 ──
  // 抬太高的話，畫在地面上的導航路線、路況線、車子會跟橋面對不起來，所以只抬一點點
  function baseH(w) { return w.bridge ? 1.2 * Math.max(1, w.layer) : 0; }
  function levelOf(w) { return w.bridge ? Math.max(1, w.layer) : 0; }
  // 橫斷面：W 全寬；a / b = 最左 / 最右車道外緣(相對中心線，右正)
  function section(w) {
    if (w.oneway) {
      var inner = 1.0, outer = w.link ? 2.0 : 3.0, W = w.lanes * LANE + inner + outer, a = -W / 2 + inner;
      return { W: W, a: a, b: a + w.lanes * LANE, inner: inner, outer: outer };
    }
    var W2 = w.lanes * LANE + 3;
    return { W: W2, a: -W2 / 2 + 1.5, b: W2 / 2 - 1.5, inner: 1.5, outer: 1.5 };
  }
  function endH(w, i) {
    var list = nodeIdx[nodeKey(w, i)] || [], inner = -1, sum = 0, n = 0;
    list.forEach(function (o) {
      var last = o.w.coords.length - 1;
      if (o.i > 0 && o.i < last) inner = Math.max(inner, baseH(o.w));   // 接在別條路中間：照那條路的高度
      else { sum += baseH(o.w); n++; }
    });
    return inner >= 0 ? inner : n ? sum / n : baseH(w);
  }

  // ── 幾何 ──
  function Bucket() { this.p = []; }
  Bucket.prototype.tri = function (a, b, c) { this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); };
  Bucket.prototype.quad = function (a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); };

  function buildChunk(key) {
    var T = window.THREE, t = tiles[key], xy = key.split('/'), box = tileBox(+xy[0], +xy[1]);
    var origin = maplibregl.MercatorCoordinate.fromLngLat([(box.w + box.e) / 2, (box.n + box.s) / 2], 0), sc = origin.meterInMercatorCoordinateUnits();
    var levels = {};
    var bucketsOf = function (lvl) {
      return levels[lvl] = levels[lvl] || { asphalt: new Bucket(), concrete: new Bucket(), steel: new Bucket(), white: new Bucket(), yellow: new Bucket() };
    };
    var lines = {};   // 路 id → 這塊圖磚座標的線(建路、畫槽化線共用)
    var lineOf = function (w) { return lines[w.id] = lines[w.id] || prepLine(w, origin, sc); };
    // 匝道接點：主線外側護欄在這附近 120 公尺不畫；匝道兩端 60 公尺不畫
    var junc = [];
    t.ids.forEach(function (id) {
      var w = ways[id];
      if (w && w.link) [0, w.coords.length - 1].forEach(function (i) { junc.push(w.coords[i]); });
    });
    // 鄰近圖磚的匝道接點也算進來(主線可能跨圖磚)
    Object.keys(ways).forEach(function (id) {
      var w = ways[id];
      if (!w.link) return;
      [0, w.coords.length - 1].forEach(function (i) {
        var c = w.coords[i];
        if (c[0] > box.w - 0.01 && c[0] < box.e + 0.01 && c[1] > box.s - 0.01 && c[1] < box.n + 0.01) junc.push(c);
      });
    });
    var juncLocal = junc.map(function (c) { var m = maplibregl.MercatorCoordinate.fromLngLat(c, 0); return [(m.x - origin.x) / sc, (m.y - origin.y) / sc]; });
    var nearJunc = function (p, d) { for (var k = 0; k < juncLocal.length; k++) { var dx = p[0] - juncLocal[k][0], dz = p[1] - juncLocal[k][1]; if (dx * dx + dz * dz < d * d) return true; } return false; };

    // 匝道分岔、匯入處的槽化線(畫在主線那一層)；記下匝道離頭 / 尾多遠才跟主線分開(重疊那段匝道不畫標線)
    var sep = {};
    t.ids.forEach(function (id) {
      var w = ways[id];
      if (!w || !w.link || !w.oneway) return;
      [0, w.coords.length - 1].forEach(function (i) {
        var main = (nodeIdx[nodeKey(w, i)] || []).map(function (o) { return o.w; }).filter(function (m) { return !m.link && m.oneway && m !== w; })[0];
        if (!main) return;
        var lm = lineOf(main), ll = lineOf(w);
        if (!lm || !ll) return;
        var u = gore(w, ll, i === 0, main, lm, bucketsOf(levelOf(main))) || 0;
        sep[w.id] = sep[w.id] || { start: 0, end: 0 };
        sep[w.id][i === 0 ? 'start' : 'end'] = u;
      });
    });
    t.ids.forEach(function (id) { var w = ways[id]; if (w) { var ln = lineOf(w); if (ln) buildWay(w, ln, bucketsOf(levelOf(w)), nearJunc, sep[w.id]); } });

    var out = [];
    Object.keys(levels).map(Number).sort(function (a, b) { return a - b; }).forEach(function (lvl) {
      var Bk = levels[lvl], deck = null, rest = null;
      Object.keys(Bk).forEach(function (k) {
        if (!Bk[k].p.length) return;
        var g = new T.BufferGeometry();
        g.setAttribute('position', new T.Float32BufferAttribute(Bk[k].p, 3));
        g.computeVertexNormals();
        var mesh = new T.Mesh(g, mats[k]);
        if (k === 'white' || k === 'yellow') mesh.renderOrder = 2;
        if (k === 'asphalt') (deck = deck || makeScene()).add(mesh); else (rest = rest || makeScene()).add(mesh);
      });
      if (deck || rest) out.push({ lvl: lvl, deck: deck, rest: rest });
    });
    if (!out.length) return null;
    var matrix = new T.Matrix4().makeTranslation(origin.x, origin.y, origin.z).scale(new T.Vector3(sc, -sc, sc))
      .multiply(new T.Matrix4().makeRotationAxis(new T.Vector3(1, 0, 0), Math.PI / 2));
    return { levels: out, matrix: matrix, box: t.ext || box };
  }
  function makeScene() {
    var T = window.THREE, scene = new T.Scene();
    scene.add(new T.AmbientLight(0xffffff, 0.62));
    var sun = new T.DirectionalLight(0xffffff, 0.6); sun.position.set(0.4, 1, 0.6); scene.add(sun);
    var fill = new T.DirectionalLight(0xffffff, 0.22); fill.position.set(-0.6, 0.4, -0.5); scene.add(fill);
    return scene;
  }

  // 一條路換成圖磚公尺座標：P 點、S 累積距離、segR 每段右手方向、R 頂點斜接方向、H 高度
  function prepLine(w, origin, sc) {
    var P = [], last = null;
    w.coords.forEach(function (c) {
      var m = maplibregl.MercatorCoordinate.fromLngLat(c, 0), p = [(m.x - origin.x) / sc, (m.y - origin.y) / sc];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.3) { P.push(p); last = p; }
    });
    if (P.length < 2) return null;
    var n = P.length, S = [0], i;
    for (i = 1; i < n; i++) S[i] = S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    var L = S[n - 1], segR = [];
    for (i = 0; i < n - 1; i++) { var dx = P[i + 1][0] - P[i][0], dz = P[i + 1][1] - P[i][1], d = Math.hypot(dx, dz); segR.push([-dz / d, dx / d]); }
    var R = P.map(function (_, k) {
      var a = segR[Math.max(0, k - 1)], b = segR[Math.min(n - 2, k)], x = a[0] + b[0], z = a[1] + b[1], l = Math.hypot(x, z) || 1;
      x /= l; z /= l;
      var cos = x * b[0] + z * b[1], f = Math.min(2, 1 / Math.max(0.5, cos));
      return [x * f, z * f];
    });
    var hb = baseH(w), hs = endH(w, 0), he = endH(w, w.coords.length - 1), ramp = Math.min(150, L / 2);
    var H = S.map(function (s) { return hb + (hs - hb) * Math.max(0, 1 - s / ramp) + (he - hb) * Math.max(0, 1 - (L - s) / ramp); });
    return { P: P, S: S, L: L, n: n, segR: segR, R: R, H: H, hb: hb };
  }
  // 沿線距離 s、橫向偏移 o 的點(用那一段的右手方向)
  function posAt(ln, s, o, y) {
    var k = 0;
    while (k < ln.n - 2 && ln.S[k + 1] < s) k++;
    var t = Math.max(0, Math.min(1, (s - ln.S[k]) / ((ln.S[k + 1] - ln.S[k]) || 1))), r = ln.segR[k];
    return [ln.P[k][0] + (ln.P[k + 1][0] - ln.P[k][0]) * t + r[0] * o, ln.H[k] + (ln.H[k + 1] - ln.H[k]) * t + y,
            ln.P[k][1] + (ln.P[k + 1][1] - ln.P[k][1]) * t + r[1] * o];
  }
  // 點投影到線上：沿線距離 s、橫向偏移 d(右正)；超出線頭尾 out = true
  function project(ln, p) {
    var best = null;
    for (var k = 0; k < ln.n - 1; k++) {
      var A = ln.P[k], Bp = ln.P[k + 1], dx = Bp[0] - A[0], dz = Bp[1] - A[1], L2 = dx * dx + dz * dz;
      var t = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dz) / L2, tc = Math.max(0, Math.min(1, t));
      var qx = A[0] + dx * tc, qz = A[1] + dz * tc, dist = Math.hypot(p[0] - qx, p[1] - qz);
      if (!best || dist < best.dist) {
        best = { dist: dist, s: ln.S[k] + Math.sqrt(L2) * tc, d: (p[0] - qx) * ln.segR[k][0] + (p[1] - qz) * ln.segR[k][1],
          out: (k === 0 && t < -0.01) || (k === ln.n - 2 && t > 1.01) };
      }
    }
    return best;
  }
  // 槽化線：匝道跟主線分開的那段三角形區域，白色外框＋斜紋(每 4 公尺一條)
  function gore(link, ll, atStart, main, lm, B) {
    var sl = section(link), sm = section(main), samples = [];
    for (var u = 0; u <= Math.min(300, ll.L); u += 2) {
      var sLink = atStart ? u : ll.L - u, c = posAt(ll, sLink, 0, 0), pr = project(lm, [c[0], c[2]]);
      if (pr.out) break;
      samples.push(pr);
    }
    if (samples.length < 5) return;
    var probe = samples[Math.min(samples.length - 1, 15)], sg = probe.d >= 0 ? 1 : -1;   // 匝道在主線右邊(大部分)或左邊
    var edgeM = sg > 0 ? sm.b : sm.a, edgeL = sg > 0 ? sl.a : sl.b;
    var pts = [], started = false, sepU = 0;
    for (var i = 0; i < samples.length; i++) {
      var gap = sg * (samples[i].d + edgeL - edgeM);
      if (gap > 0.15) { if (!started) sepU = i * 2; started = true; pts.push({ s: samples[i].s, gap: gap }); }
      else if (started) break;
      if (gap > 8) break;   // 分得夠開了：之後是護欄、草地
    }
    if (pts.length < 3) return sepU;
    pts.sort(function (a, b) { return a.s - b.s; });
    var y = 0.075, lw = 0.15;
    // 外框：匝道那一側的白實線(主線那一側就是主線的外側邊線)
    for (i = 0; i < pts.length - 1; i++) {
      var o0 = edgeM + sg * pts[i].gap, o1 = edgeM + sg * pts[i + 1].gap;
      B.white.quad(posAt(lm, pts[i].s, o0 - lw / 2, y), posAt(lm, pts[i].s, o0 + lw / 2, y), posAt(lm, pts[i + 1].s, o1 + lw / 2, y), posAt(lm, pts[i + 1].s, o1 - lw / 2, y));
    }
    // 斜紋：從主線邊線斜向匝道邊線，往缺口變寬的方向斜
    var widen = pts[pts.length - 1].gap >= pts[0].gap ? 1 : -1, gapAt = function (s) {
      for (var k = 0; k < pts.length - 1; k++) if (s <= pts[k + 1].s) { var t = (s - pts[k].s) / ((pts[k + 1].s - pts[k].s) || 1); return pts[k].gap + (pts[k + 1].gap - pts[k].gap) * t; }
      return pts[pts.length - 1].gap;
    };
    var sw = 0.3;
    for (var s0 = pts[0].s + 2; s0 < pts[pts.length - 1].s; s0 += 4) {
      var g0 = gapAt(s0);
      if (g0 < 0.8) continue;
      var s1 = Math.max(pts[0].s, Math.min(pts[pts.length - 1].s, s0 + widen * g0 * 0.8)), g1 = Math.min(g0, gapAt(s1));
      var a0 = edgeM + sg * 0.1, a1 = edgeM + sg * (g1 - 0.1);
      B.white.quad(posAt(lm, s0, a0, y), posAt(lm, s0 + sw, a0, y), posAt(lm, s1 + sw, a1, y), posAt(lm, s1, a1, y));
    }
    return sepU;
  }

  function buildWay(w, ln, B, nearJunc, sep) {
    var P = ln.P, S = ln.S, L = ln.L, n = ln.n, segR = ln.segR, R = ln.R, H = ln.H, hb = ln.hb;
    // 偏移 o 可以是數字，或 function(k)(右側跟著車道縮減漸變的那些線)
    var pt = function (k, o, y) { var v = typeof o === 'function' ? o(k) : o; return [P[k][0] + R[k][0] * v, H[k] + y, P[k][1] + R[k][1] * v]; };

    // 橫斷面
    var sec = section(w), W = sec.W, a = sec.a, b = sec.b;
    // 車道數變少(例如 5 線接 3 線)：路的頭尾 90 公尺內，右側慢慢縮到下一段的寬度，不會一刀切成直角
    var shift = S.map(function () { return 0; });
    if (w.oneway) [0, w.coords.length - 1].forEach(function (i) {
      var nb = (nodeIdx[nodeKey(w, i)] || []).filter(function (o) {
        return o.w !== w && !o.w.link && o.w.oneway && (i === 0 ? o.i === o.w.coords.length - 1 : o.i === 0);
      });
      if (nb.length !== 1) return;
      var d = section(nb[0].w).b - b, T = Math.min(90, L / 2);
      if (d > -0.1) return;   // 下一段比較寬：由那一段自己處理
      for (var k = 0; k < n; k++) { var dist = i === 0 ? S[k] : L - S[k]; if (dist < T) shift[k] += d * (1 - dist / T); }
    });
    var right = function (o) { return function (k) { return o + shift[k]; }; };
    // 匝道還跟主線重疊的那段(分岔點到分開處)不畫匝道自己的標線，不然會畫到主線車道上
    var sepS = sep ? sep.start : 0, sepE = sep ? sep.end : 0;
    var onMain = function (k) { return S[k + 1] <= sepS || S[k] >= L - sepE; };
    var strip = function (bk, o1, o2, y, skip) {
      for (var k = 0; k < n - 1; k++) if (!skip || !skip(k)) bk.quad(pt(k, o1, y), pt(k, o2, y), pt(k + 1, o2, y), pt(k + 1, o1, y));
    };
    var dashed = function (bk, o, wd, y) {
      // 沿線走，每 10 公尺畫 4 公尺；縮減掉的車道那段不畫
      var period = DASH + GAP;
      for (var k = 0; k < n - 1; k++) {
        if (o > b + Math.min(shift[k], shift[k + 1]) - 1 || onMain(k)) continue;
        var s0 = S[k], s1 = S[k + 1];
        var first = Math.ceil(s0 / period) * period - period;
        for (var st = first; st < s1; st += period) {
          var u0 = Math.max(st, s0), u1 = Math.min(st + DASH, s1);
          if (u1 - u0 < 0.2) continue;
          var t0 = (u0 - s0) / (s1 - s0), t1 = (u1 - s0) / (s1 - s0), r = segR[k];
          var y0 = H[k] + (H[k + 1] - H[k]) * t0 + y, y1 = H[k] + (H[k + 1] - H[k]) * t1 + y;
          var x0 = P[k][0] + (P[k + 1][0] - P[k][0]) * t0, z0 = P[k][1] + (P[k + 1][1] - P[k][1]) * t0;
          var x1 = P[k][0] + (P[k + 1][0] - P[k][0]) * t1, z1 = P[k][1] + (P[k + 1][1] - P[k][1]) * t1;
          var h = wd / 2;
          bk.quad([x0 + r[0] * (o - h), y0, z0 + r[1] * (o - h)], [x0 + r[0] * (o + h), y0, z0 + r[1] * (o + h)],
                  [x1 + r[0] * (o + h), y1, z1 + r[1] * (o + h)], [x1 + r[0] * (o - h), y1, z1 + r[1] * (o - h)]);
        }
      }
    };
    // 牆(護欄)：profile = [[橫向偏移, 高度], ...]，沿線拉出來；skip(k) = 這一段不畫
    var wall = function (bk, o, side, profile, skip) {
      for (var k = 0; k < n - 1; k++) {
        if (skip && skip(k)) continue;
        var o0 = typeof o === 'function' ? o(k) : o, o1 = typeof o === 'function' ? o(k + 1) : o;
        for (var j = 0; j < profile.length - 1; j++) {
          var p0 = profile[j], p1 = profile[j + 1];
          bk.quad(pt(k, o0 + side * p0[0], p0[1]), pt(k, o0 + side * p1[0], p1[1]), pt(k + 1, o1 + side * p1[0], p1[1]), pt(k + 1, o1 + side * p0[0], p0[1]));
        }
      }
    };
    // 鋼板護欄：W 型鋼板(兩道折線)＋立柱
    var guardrail = function (o, side, skip) {
      wall(B.steel, o, side, [[0, 0.45], [0.06, 0.53], [0, 0.6], [0.06, 0.68], [0, 0.76]], skip);
      var period = 4;
      for (var k = 0; k < n - 1; k++) {
        if (skip && skip(k)) continue;
        for (var st = Math.ceil(S[k] / period) * period; st < S[k + 1]; st += period) {
          var tt = (st - S[k]) / (S[k + 1] - S[k]), r = segR[k], f = [r[1], -r[0]];   // f：沿線方向(往前)
          var ov = (typeof o === 'function' ? o(k) * (1 - tt) + o(k + 1) * tt : o) + side * 0.12;
          var cx = P[k][0] + (P[k + 1][0] - P[k][0]) * tt + r[0] * ov, cz = P[k][1] + (P[k + 1][1] - P[k][1]) * tt + r[1] * ov;
          var y0 = H[k] + (H[k + 1] - H[k]) * tt, y1 = y0 + 0.78, hw = 0.07;
          var c = [[-hw, -hw], [hw, -hw], [hw, hw], [-hw, hw]].map(function (q) { return [cx + r[0] * q[0] + f[0] * q[1], cz + r[1] * q[0] + f[1] * q[1]]; });
          for (var e = 0; e < 4; e++) {
            var A = c[e], Bq = c[(e + 1) % 4];
            B.steel.quad([A[0], y0, A[1]], [Bq[0], y0, Bq[1]], [Bq[0], y1, Bq[1]], [A[0], y1, A[1]]);
          }
          B.steel.quad([c[0][0], y1, c[0][1]], [c[1][0], y1, c[1][1]], [c[2][0], y1, c[2][1]], [c[3][0], y1, c[3][1]]);
        }
      }
    };
    // 混凝土護欄：紐澤西型(下寬上窄)；橋上護欄直立
    var jersey = [[0, 0], [0.05, 0.08], [0.18, 0.33], [0.24, 0.85], [0.42, 0.85], [0.48, 0.33], [0.61, 0.08], [0.66, 0]];
    var parapet = [[0, 0], [0.04, 0.95], [0.3, 0.95], [0.3, 0]];

    // 路面
    strip(B.asphalt, -W / 2, right(W / 2), 0.03);
    if (hb > 0) {   // 橋：路面兩側的橋面版側邊
      wall(B.concrete, -W / 2, -1, [[0, 0.03], [0, -0.5]]);
      wall(B.concrete, right(W / 2), 1, [[0, 0.03], [0, -0.5]]);
    }
    var my = 0.06;   // 標線比路面高一點點，不會閃
    var skipEnds = function (k) { return S[k + 1] < 60 || S[k] > L - 60; };
    var skipJunc = function (k) { return nearJunc(P[k], 120) || nearJunc(P[k + 1], 120); };
    var edge = function (o, side, skip) {   // 外側：橋上混凝土、平地鋼板
      if (hb > 0) wall(B.concrete, o, side, parapet, skip); else guardrail(o, side, skip);
    };
    if (w.oneway) {
      strip(B.yellow, a, a + 0.15, my, onMain);             // 內側路面邊線(黃實線)
      strip(B.white, right(b - 0.15), right(b), my, onMain);   // 外側路面邊線(白實線)
      for (var k2 = 1; k2 < w.lanes; k2++) dashed(B.white, a + k2 * LANE, LANE_LINE_W, my);   // 車道線(白虛線)
      if (w.link) {
        edge(right(W / 2 - 0.3), 1, skipEnds);
        edge(-W / 2 + 0.3, -1, skipEnds);
      } else {
        edge(right(W / 2 - 0.3), 1, skipJunc);
        wall(B.concrete, -W / 2 - 0.1, 1, jersey);           // 中央分隔護欄
      }
    } else {
      var per = Math.max(1, Math.floor(w.lanes / 2)), half = per * LANE;
      strip(B.yellow, 0.06, 0.18, my); strip(B.yellow, -0.18, -0.06, my);   // 中央雙黃線
      strip(B.white, half - 0.15, half, my); strip(B.white, -half, -half + 0.15, my);
      for (var k3 = 1; k3 < per; k3++) { dashed(B.white, k3 * LANE, LANE_LINE_W, my); dashed(B.white, -k3 * LANE, LANE_LINE_W, my); }
      edge(W / 2 - 0.3, 1, skipEnds);
      edge(-W / 2 + 0.3, -1, skipEnds);
    }
  }

  function disposeChunk(c) {
    if (!c) return;
    c.levels.forEach(function (l) { [l.deck, l.rest].forEach(function (sc) { if (sc) sc.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); }); });
  }
  function makeMats() {
    var T = window.THREE, ds = T.DoubleSide;
    var mark = function (color) { return new T.MeshBasicMaterial({ color: color, side: ds, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }); };
    mats = {
      asphalt: new T.MeshLambertMaterial({ color: 0x4A4D52, side: ds, depthFunc: T.AlwaysDepth }),   // 路面一律蓋過(下層的路先畫，上層後畫)
      concrete: new T.MeshLambertMaterial({ color: 0xCFCCC4, side: ds }),
      steel: new T.MeshPhongMaterial({ color: 0xC4CACF, specular: 0x8A8F94, shininess: 60, side: ds }),
      white: mark(0xF4F4F4),
      yellow: mark(0xF2BE1A),
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
      var T = window.THREE, mapM = new T.Matrix4().fromArray(matrix), b = m.getBounds(), list = [], lvls = {};
      Object.keys(tiles).forEach(function (k) {
        var c = tiles[k].chunk;
        if (!c || c.box.e < b.getWest() || c.box.w > b.getEast() || c.box.n < b.getSouth() || c.box.s > b.getNorth()) return;
        list.push(c); c.levels.forEach(function (l) { lvls[l.lvl] = 1; });
      });
      var draw = function (c, sc) { camera.projectionMatrix = mapM.clone().multiply(c.matrix); renderer.resetState(); renderer.render(sc, camera); };
      // 由下往上一層一層畫：每層先畫所有圖磚的路面，再畫標線、護欄
      Object.keys(lvls).map(Number).sort(function (a, b2) { return a - b2; }).forEach(function (lvl) {
        list.forEach(function (c) { c.levels.forEach(function (l) { if (l.lvl === lvl && l.deck) draw(c, l.deck); }); });
        list.forEach(function (c) { c.levels.forEach(function (l) { if (l.lvl === lvl && l.rest) draw(c, l.rest); }); });
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
    if (!m || m.getZoom() < MIN_ZOOM) return;
    ensureThree(function () {
      addLayer();
      var now = Date.now();
      visibleTiles().forEach(function (k) {
        var t = tiles[k];
        if (!t) { t = tiles[k] = { state: 'queued', ids: [], chunk: null }; queue.push(k); }
        else if (t.state === 'fallback' && now > t.retryAt) { t.state = 'queued'; queue.push(k); }
        t.usedAt = now;
      });
      // 模型被丟掉的，路有在畫面裡就重建(路可能跨出自己的圖磚)
      var b = m.getBounds();
      Object.keys(tiles).forEach(function (k) {
        var t = tiles[k], e = t.ext;
        if (t.chunk || !t.ids.length || !e || e.e < b.getWest() || e.w > b.getEast() || e.n < b.getSouth() || e.s > b.getNorth()) return;
        t.chunk = buildChunk(k); t.usedAt = now;
      });
      // 太多塊就丟掉最久沒看的模型(資料留著，回來再建)
      var built = Object.keys(tiles).filter(function (k) { return tiles[k].chunk; }).sort(function (a, b) { return tiles[a].usedAt - tiles[b].usedAt; });
      while (built.length > MAX_CHUNKS) { var k0 = built.shift(); disposeChunk(tiles[k0].chunk); tiles[k0].chunk = null; }
      pump();
    });
  }
  // 換地圖樣式後圖層會被清掉，重加
  window._snmReloadRoad3d = function () {
    renderer = null;
    if (window.THREE && window.map && window.map.getZoom() >= MIN_ZOOM) addLayer();
  };
  // 某個位置、行車方向上的國道主線：回傳投影到中心線的位置、那段的方向、路面全寬(找不到回 null)
  window._snmRoad3dFit = function (lon, lat, bearing) {
    var kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540, best = null;
    Object.keys(ways).forEach(function (id) {
      var w = ways[id];
      if (w.link || !w.oneway || id.charAt(0) !== 'o') return;
      var c = w.coords;
      for (var i = 0; i < c.length - 1; i++) {
        var ax = (c[i][0] - lon) * kx, ay = (c[i][1] - lat) * ky, bx = (c[i + 1][0] - lon) * kx, by = (c[i + 1][1] - lat) * ky;
        if (Math.abs(ax) > 400 && Math.abs(bx) > 400 || Math.abs(ay) > 400 && Math.abs(by) > 400) continue;
        var dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        if (!L2) continue;
        var t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)), d = Math.hypot(ax + t * dx, ay + t * dy);
        if (d > 45 || (best && d >= best.d)) continue;
        var b = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
        if (Math.abs(((b - bearing) % 360 + 540) % 360 - 180) > 50) continue;
        best = { d: d, lon: c[i][0] + (c[i + 1][0] - c[i][0]) * t, lat: c[i][1] + (c[i + 1][1] - c[i][1]) * t, bearing: b, W: section(w).W };
      }
    });
    return best;
  };
  window._snmRoad3dState = function () { return { tiles: tiles, ways: ways, threeState: threeState }; };   // 除錯用
  var timer = null;
  function init() {
    var m = window.map;
    if (!m) { setTimeout(init, 500); return; }
    var go = function () { m.on('moveend', function () { clearTimeout(timer); timer = setTimeout(check, 250); }); check(); };
    if (m.loaded()) go(); else m.once('load', go);
  }
  init();
})();
