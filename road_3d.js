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
      return levels[lvl] = levels[lvl] || { asphalt: new Bucket(), concrete: new Bucket(), steel: new Bucket(), white: new Bucket(), yellow: new Bucket(), greenEdge: new Bucket(), green: new Bucket() };
    };
    var lines = {};   // 路 id → 這塊圖磚座標的線(建路、畫槽化線共用)
    oppGrid = makeOppGrid(t.ext || box, origin, sc);   // 對向車道(限制分隔島寬度範圍用)
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
        sep[w.id][i === 0 ? 'onMainStart' : 'onMainEnd'] = true;   // 這頭接在主線上
      });
    });
    // 道路交叉、重疊的地方：護欄、標線落在別條路的路面上就不畫(附近圖磚的路也算進來)
    var e = t.ext || box, near = [];
    Object.keys(ways).forEach(function (id) {
      var w = ways[id];
      if (t.ids.indexOf(id) < 0 && !w.coords.some(function (c) { return c[0] > e.w - 0.002 && c[0] < e.e + 0.002 && c[1] > e.s - 0.002 && c[1] < e.n + 0.002; })) return;
      var ln = lineOf(w); if (ln) near.push({ w: w, ln: ln });
    });
    var cover = makeCover(near);
    t.ids.forEach(function (id) { var w = ways[id]; if (w) { var ln = lineOf(w); if (ln) buildWay(w, ln, bucketsOf(levelOf(w)), nearJunc, sep[w.id], cover); } });

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
        if (k === 'greenEdge') mesh.renderOrder = 3;
        if (k === 'green') mesh.renderOrder = 4;
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
  // 接在這條路頭 / 尾、順著開下去的那一條(只有一條時)：拿它相鄰的那個點，讓曲線、路面在接縫處方向連續
  function continuation(w, atStart) {
    var i = atStart ? 0 : w.coords.length - 1;
    var nb = (nodeIdx[nodeKey(w, i)] || []).filter(function (o) {
      return o.w !== w && o.w.oneway === w.oneway && (atStart ? o.i === o.w.coords.length - 1 : o.i === 0) && o.w.coords.length > 1;
    });
    if (nb.length !== 1) return null;
    var c = nb[0].w.coords;
    return atStart ? c[c.length - 2] : c[1];
  }
  function continuationWay(w, atStart) {
    var i = atStart ? 0 : w.coords.length - 1;
    var nb = (nodeIdx[nodeKey(w, i)] || []).filter(function (o) {
      return o.w !== w && o.w.oneway === w.oneway && (atStart ? o.i === o.w.coords.length - 1 : o.i === 0) && o.w.coords.length > 1;
    });
    return nb.length === 1 ? nb[0].w : null;
  }
  // 貝茲曲線平滑：OSM 道路是一段段直線，轉彎會一折一折的。用向心 Catmull-Rom 曲線(等同一串三次貝茲曲線)
  // 穿過每個原本的點(交流道接點位置不變)，每 3 公尺取一個點；向心參數不會在急彎繞圈、凸出去
  function smooth(P, before, after) {
    if (P.length < 2) return P;
    var ext = [before || [2 * P[0][0] - P[1][0], 2 * P[0][1] - P[1][1]]].concat(P, [after || [2 * P[P.length - 1][0] - P[P.length - 2][0], 2 * P[P.length - 1][1] - P[P.length - 2][1]]]);
    var out = [P[0]];
    for (var i = 1; i < ext.length - 2; i++) {
      var p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
      var d = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), m = Math.min(40, Math.ceil(d / 3));
      if (m <= 1) { out.push(p2); continue; }
      var t0 = 0, t1 = t0 + Math.pow(Math.max(1e-6, Math.hypot(p1[0] - p0[0], p1[1] - p0[1])), 0.5),
          t2 = t1 + Math.pow(Math.max(1e-6, d), 0.5), t3 = t2 + Math.pow(Math.max(1e-6, Math.hypot(p3[0] - p2[0], p3[1] - p2[1])), 0.5);
      for (var j = 1; j <= m; j++) {
        if (j === m) { out.push(p2); break; }
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
    }
    return out;
  }
  // ── 中央分隔島寬度限制在一個範圍內 ──
  // OSM 的南下、北上兩條線間距差很多，照畫的話分隔島一下很寬一下貼在一起。可以有寬有窄，但不能差太多：
  // 找出每段主線的對向車道(同一層、方向相反、55 公尺內)，兩邊路面內緣的距離超出 MEDIAN_MIN～MEDIAN_MAX 才往回拉(兩邊各移一半)，
  // 範圍內的照原本資料不動；移動量沿路慢慢變化(約 30 公尺)，35～55 公尺的慢慢放開(交流道附近上下行分很開的地方維持原樣)。
  var MEDIAN_MIN = 1.0, MEDIAN_MAX = 3.0, oppGrid = null;
  function makeOppGrid(e, origin, sc) {
    var CELL = 60, grid = {};
    Object.keys(ways).forEach(function (id) {
      var w = ways[id];
      if (w.link || !w.oneway) return;
      if (!w.coords.some(function (c) { return c[0] > e.w - 0.003 && c[0] < e.e + 0.003 && c[1] > e.s - 0.003 && c[1] < e.n + 0.003; })) return;
      var half = section(w).W / 2, lv = levelOf(w), prev = null;
      w.coords.forEach(function (c) {
        var m = maplibregl.MercatorCoordinate.fromLngLat(c, 0), p = [(m.x - origin.x) / sc, (m.y - origin.y) / sc];
        if (prev) {
          var dx = p[0] - prev[0], dz = p[1] - prev[1], L = Math.hypot(dx, dz);
          if (L > 0.1) {
            var g = { w: w, a: prev, d: [dx / L, dz / L], L: L, half: half, lv: lv };
            var x0 = Math.floor(Math.min(prev[0], p[0]) / CELL), x1 = Math.floor(Math.max(prev[0], p[0]) / CELL);
            var z0 = Math.floor(Math.min(prev[1], p[1]) / CELL), z1 = Math.floor(Math.max(prev[1], p[1]) / CELL);
            for (var x = x0; x <= x1; x++) for (var z = z0; z <= z1; z++) (grid[x + ',' + z] = grid[x + ',' + z] || []).push(g);
          }
        }
        prev = p;
      });
    });
    return { CELL: CELL, grid: grid };
  }
  // 某一點(方向 dir)左邊的對向車道：回傳兩邊路面內緣的距離 gap 與權重(35 公尺內 1，到 55 公尺漸漸變 0)
  function oppGap(p, dir, half, lv, self) {
    var rgt = [-dir[1], dir[0]], best = null, seen = [];
    var cx = Math.floor(p[0] / oppGrid.CELL), cz = Math.floor(p[1] / oppGrid.CELL);
    for (var x = cx - 1; x <= cx + 1; x++) for (var z = cz - 1; z <= cz + 1; z++) {
      (oppGrid.grid[x + ',' + z] || []).forEach(function (g) {
        if (self.indexOf(g.w) >= 0 || g.lv !== lv || seen.indexOf(g) >= 0) return;
        seen.push(g);
        if (g.d[0] * dir[0] + g.d[1] * dir[1] > -0.85) return;   // 要方向相反
        var t = (p[0] - g.a[0]) * g.d[0] + (p[1] - g.a[1]) * g.d[1];
        if (t < 0 || t > g.L) return;
        var lat = (g.a[0] + g.d[0] * t - p[0]) * rgt[0] + (g.a[1] + g.d[1] * t - p[1]) * rgt[1];
        if (lat >= 0) return;   // 對向車道在左邊(靠右行駛)
        var dist = -lat;
        if (dist > 55 || (best && dist >= best.dist)) return;
        best = { dist: dist, half: g.half };
      });
    }
    return best ? { gap: best.dist - half - best.half, wgt: best.dist <= 35 ? 1 : (55 - best.dist) / 20 } : null;
  }
  // joints：頭 / 尾接到下一段時，接縫處的位置 p、方向 dir、用的半寬與層(兩段算出來的值完全一樣，接縫才不會裂開)
  function limitMedian(w, P, joints) {
    if (!oppGrid || w.link || !w.oneway || P.length < 2) return P;
    var n = P.length, half = section(w).W / 2, lv = levelOf(w), shift = new Array(n), gaps = new Array(n), wgts = new Array(n), any = false, i;
    for (i = 0; i < n; i++) {
      var a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
      var r = oppGap(P[i], [dx / L, dz / L], half, lv, [w]);
      gaps[i] = r ? r.gap : null; wgts[i] = r ? r.wgt : 0;
      if (r) any = true;
    }
    // 接縫處的移動量：只用接縫那一點的原始資料算(前後兩段算出來一樣)
    var J = [joints.start, joints.end].map(function (j) {
      if (!j) return null;
      var r = oppGap(j.p, j.dir, j.half, j.lv, j.self);
      return r ? (r.gap - Math.max(MEDIAN_MIN, Math.min(MEDIAN_MAX, r.gap))) / 2 * r.wgt : 0;
    });
    if (!any && !J[0] && !J[1]) return P;
    var D = [0];
    for (i = 1; i < n; i++) D[i] = D[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    // 沿路距離 ±r 公尺的平均(只算有值的點)
    var avg = function (arr, r, ok) {
      var out = new Array(n), lo = 0, hi = -1, sum = 0, cnt = 0;
      for (var k = 0; k < n; k++) {
        while (hi + 1 < n && D[hi + 1] <= D[k] + r) { hi++; if (ok(hi)) { sum += arr[hi]; cnt++; } }
        while (D[lo] < D[k] - r) { if (ok(lo)) { sum -= arr[lo]; cnt--; } lo++; }
        out[k] = cnt ? sum / cnt : null;
      }
      return out;
    };
    // 分隔島寬度：沿路 ±60 公尺平均後限制在範圍內 → 目標寬度(慢慢變、不會差很多)
    var smGap = avg(gaps, 60, function (k) { return gaps[k] !== null; });
    for (i = 0; i < n; i++) {
      if (gaps[i] === null || smGap[i] === null) { shift[i] = 0; continue; }
      var target = Math.max(MEDIAN_MIN, Math.min(MEDIAN_MAX, smGap[i]));
      shift[i] = (gaps[i] - target) / 2 * wgts[i];   // 正 = 往左(往對向)移；兩邊各移一半
    }
    // 移動量再沿路 ±30 公尺平滑：開始配對、結束配對的地方不會突然一扭
    var sm = avg(shift, 30, function () { return true; });
    // 接縫前後 60 公尺內慢慢對到接縫處的移動量
    var Lw = D[n - 1];
    for (i = 0; i < n; i++) {
      if (J[0] !== null) sm[i] += (J[0] - sm[0]) * Math.max(0, 1 - D[i] / 60);
      if (J[1] !== null) sm[i] += (J[1] - sm[n - 1]) * Math.max(0, 1 - (Lw - D[i]) / 60);
    }
    if (J[0] !== null) sm[0] = J[0];
    if (J[1] !== null) sm[n - 1] = J[1];
    return P.map(function (p, i) {
      // 接縫那一點用接縫的方向移(兩段一樣)，其他點用自己的方向
      var dir;
      if (i === 0 && joints.start) dir = joints.start.dir;
      else if (i === n - 1 && joints.end) dir = joints.end.dir;
      else {
        var a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
        dir = [dx / L, dz / L];
      }
      return [p[0] + dir[1] * sm[i], p[1] - dir[0] * sm[i]];   // 往左 = 右手方向的反方向
    });
  }
  function prepLine(w, origin, sc) {
    var loc = function (c) { var m = maplibregl.MercatorCoordinate.fromLngLat(c, 0); return [(m.x - origin.x) / sc, (m.y - origin.y) / sc]; };
    var P = [], last = null;
    w.coords.forEach(function (c) {
      var p = loc(c);
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.3) { P.push(p); last = p; }
    });
    if (P.length < 2) return null;
    var cb = continuation(w, true), ca = continuation(w, false), before = cb && loc(cb), after = ca && loc(ca);
    P = smooth(P, before, after);
    // 接縫處的方向：用接縫前一點、後一點的原始座標算(前後兩段算出來完全一樣，路面接得密合)
    var unit = function (a, b) { var dx = b[0] - a[0], dz = b[1] - a[1], d = Math.hypot(dx, dz) || 1; return [dx / d, dz / d]; };
    var cw = w.coords, dirS = before ? unit(before, loc(cw[1])) : null, dirE = after ? unit(loc(cw[cw.length - 2]), after) : null;
    var joint = function (atStart, dir) {
      var o = continuationWay(w, atStart);
      if (!o || !dir) return null;
      return { p: loc(cw[atStart ? 0 : cw.length - 1]), dir: dir, half: Math.max(section(w).W, section(o).W) / 2, lv: Math.min(levelOf(w), levelOf(o)), self: [w, o] };
    };
    P = limitMedian(w, P, { start: joint(true, dirS), end: joint(false, dirE) });
    var n = P.length, S = [0], i;
    for (i = 1; i < n; i++) S[i] = S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    var L = S[n - 1], segR = [];
    for (i = 0; i < n - 1; i++) { var dx = P[i + 1][0] - P[i][0], dz = P[i + 1][1] - P[i][1], d = Math.hypot(dx, dz) || 1; segR.push([-dz / d, dx / d]); }
    // 頭尾的斷面方向：有接續的路就跟那條路的方向平均(兩段路面接得密合，不會一邊開口一邊重疊)
    var r0 = dirS ? [-dirS[1], dirS[0]] : null, rn = dirE ? [-dirE[1], dirE[0]] : null;
    var R = P.map(function (_, k) {
      if (k === 0 && r0) return r0;
      if (k === n - 1 && rn) return rn;
      var a = k === 0 && r0 ? r0 : segR[Math.max(0, k - 1)], b = k === n - 1 && rn ? rn : segR[Math.min(n - 2, k)], x = a[0] + b[0], z = a[1] + b[1], l = Math.hypot(x, z) || 1;
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

  // 路面覆蓋查詢：某一點是不是在「別條路」的路面上(用 25 公尺格子加速)
  //   rail：護欄在同層或更高層的路面上 → 不畫(護欄不會橫過路面)
  //   mark：標線在更高層的路面上，或同層的主線路面上(匝道讓主線) → 不畫
  // 標線：A 落在 B 路面上時要不要讓 B(B 層比較高；同層時主線優先，同是主線或同是匝道就車道多的優先，再一樣就固定一條)
  // 只讓一條，重疊的地方還是有一組標線，不會兩條都不畫變成一片空白
  function marksYield(a, la, b, lb) {
    if (lb !== la) return lb > la;
    if (a.link !== b.link) return a.link;
    if (a.lanes !== b.lanes) return b.lanes > a.lanes;
    return b.id < a.id;
  }
  function makeCover(list) {
    var CELL = 25, grid = {};
    list.forEach(function (it) {
      var ln = it.ln, half = section(it.w).W / 2, lv = levelOf(it.w);
      for (var k = 0; k < ln.n - 1; k++) {
        var a = ln.P[k], b = ln.P[k + 1];
        var x0 = Math.floor((Math.min(a[0], b[0]) - half) / CELL), x1 = Math.floor((Math.max(a[0], b[0]) + half) / CELL);
        var z0 = Math.floor((Math.min(a[1], b[1]) - half) / CELL), z1 = Math.floor((Math.max(a[1], b[1]) + half) / CELL);
        for (var x = x0; x <= x1; x++) for (var z = z0; z <= z1; z++) (grid[x + ',' + z] = grid[x + ',' + z] || []).push({ w: it.w, a: a, b: b, half: half, lv: lv });
      }
    });
    return function (p, w, kind) {
      var list2 = grid[Math.floor(p[0] / CELL) + ',' + Math.floor(p[1] / CELL)];
      if (!list2) return false;
      var lvA = levelOf(w);
      for (var i = 0; i < list2.length; i++) {
        var g = list2[i];
        if (g.w === w) continue;
        if (kind === 'rail' ? g.lv < lvA : !marksYield(w, lvA, g.w, g.lv)) continue;
        var dx = g.b[0] - g.a[0], dz = g.b[1] - g.a[1], L2 = dx * dx + dz * dz;
        if (!L2) continue;
        var t = ((p[0] - g.a[0]) * dx + (p[1] - g.a[1]) * dz) / L2;
        if (t < 0 || t > 1) continue;   // 超出那條路的頭尾不算(前後相接的路才不會互相吃掉)
        if (Math.hypot(p[0] - g.a[0] - dx * t, p[1] - g.a[1] - dz * t) < g.half - (kind === 'rail' ? 0.5 : 0.3)) return true;
      }
      return false;
    };
  }
  function buildWay(w, ln, B, nearJunc, sep, cover) {
    var hidden = function (x, z, kind) { return cover ? cover([x, z], w, kind) : false; };
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
      for (var k = 0; k < n - 1; k++) {
        if (skip && skip(k)) continue;
        var q = [pt(k, o1, y), pt(k, o2, y), pt(k + 1, o2, y), pt(k + 1, o1, y)];
        if (bk !== B.asphalt && hidden((q[0][0] + q[2][0]) / 2, (q[0][2] + q[2][2]) / 2, 'mark')) continue;   // 標線落在別條路上
        bk.quad(q[0], q[1], q[2], q[3]);
      }
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
          if (hidden((x0 + x1) / 2 + r[0] * o, (z0 + z1) / 2 + r[1] * o, 'mark')) continue;
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
        var m0 = pt(k, o0, 0), m1 = pt(k + 1, o1, 0);
        if (hidden((m0[0] + m1[0]) / 2, (m0[2] + m1[2]) / 2, 'rail')) continue;   // 護欄落在別條路上(交叉、匯流處)
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
          if (hidden(cx, cz, 'rail')) continue;
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
    strip(B.asphalt, -W / 2, right(W / 2), 0.03, onMain);   // 匝道還跟主線重疊的那段不畫(主線路面就是它)
    // 路的頭尾補圓形路面：匝道分岔、兩條路斜斜接在一起時，接縫不會凸出直角的階梯。
    // 直直接到下一段的頭尾不畫(接縫本來就密合，半圓會蓋到下一段的標線)；匝道接主線那頭也不畫
    [0, n - 1].forEach(function (k) {
      var atStart = k === 0;
      if (sep && (atStart ? sep.onMainStart : sep.onMainEnd)) return;
      if (continuation(w, atStart)) return;
      var rad = (W + Math.min(0, shift[k])) / 2, c = [P[k][0], H[k] + 0.03, P[k][1]], seg = 16;
      for (var j = 0; j < seg; j++) {
        var a0 = j / seg * Math.PI * 2, a1 = (j + 1) / seg * Math.PI * 2;
        B.asphalt.tri(c, [c[0] + Math.cos(a0) * rad, c[1], c[2] + Math.sin(a0) * rad], [c[0] + Math.cos(a1) * rad, c[1], c[2] + Math.sin(a1) * rad]);
      }
    });
    if (hb > 0) {   // 橋：路面兩側的橋面版側邊
      wall(B.concrete, -W / 2, -1, [[0, 0.03], [0, -0.5]], onMain);
      wall(B.concrete, right(W / 2), 1, [[0, 0.03], [0, -0.5]], onMain);
    }
    var my = 0.06;   // 標線比路面高一點點，不會閃
    var skipEnds = function (k) { return S[k + 1] < 60 || S[k] > L - 60; };
    var skipJunc = function (k) { return nearJunc(P[k], 120) || nearJunc(P[k + 1], 120); };
    var edge = function (o, side, skip) {   // 外側：橋上混凝土、平地鋼板
      if (hb > 0) wall(B.concrete, o, side, parapet, skip); else guardrail(o, side, skip);
    };
    // 沒塞車的路況綠線畫在 3D 路面中間(跟著曲線、高架)，取代平面的國道綠線
    var gc = w.oneway ? (a + b) / 2 : 0;
    strip(B.greenEdge, gc - 0.95, gc + 0.95, my + 0.01, onMain);
    strip(B.green, gc - 0.7, gc + 0.7, my + 0.02, onMain);
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
    renderer = null; arranged = null;
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
    m.on('styledata', function () { if (arranged) arrange(); });   // 主程式重排路線圖層後，3D 路面放回一般道路與國道綠線中間
    var go = function () { m.on('moveend', function () { clearTimeout(timer); timer = setTimeout(check, 250); }); check(); };
    if (m.loaded()) go(); else m.once('load', go);
  }
  init();
})();
