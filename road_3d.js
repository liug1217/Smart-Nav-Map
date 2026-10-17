// ===== 🛣 國道、快速道路 3D 路面 =====
// 放大到 zoom 16 以上，把國道(motorway)、快速道路(trunk)與匝道畫成立體道路：
//   - 路面寬度照實際車道數：車道 3.75 公尺、外側路肩 3 公尺、內側路肩 1 公尺(匝道外側路肩 2 公尺)
//   - 標線：車道線白色虛線(劃 4 公尺、空 6 公尺)、外側路面邊線白色實線、內側路面邊線黃色實線；雙向道路中間雙黃線
//   - 護欄：外側鋼板護欄(W 型鋼板＋每 4 公尺一根立柱)、中央分隔混凝土護欄(紐澤西護欄)、橋上兩側混凝土護欄
//   - 匝道進出口(分流、匯流)那段不畫外側護欄，車道才接得起來
//   - 轉角都改成貝茲曲線(彎道圓順)，匝道接點不動；接續的路接縫斜接、車道數不同時寬度漸變(road_3d_shape.js)
//   - 電腦先修好的：對向車道疊在一起已推開(中間 0.8 公尺鋪滿)、沒標的車道數已推好、會落在別條路上的護欄那段不畫
// 資料：OpenStreetMap 的車道數 lanes、單行道、橋梁，事先切成 zoom 13 圖磚的小檔案(road3d/，用 tools/build-road3d.js 產生)，
//       只抓畫面附近那幾塊、同一塊只抓一次。沒標車道數的用一般值：國道 3、快速道路 2、匝道 1。
//       檔案抓不到(離線)時改用底圖的道路線。
// 圖層放在路況綠線、導航路線的下面：路況顏色、導航路線、車子都照樣蓋在路面上看得到。
(function () {
  'use strict';
  var MIN_ZOOM = 16, TILE_Z = 13, MAX_CHUNKS = 16;
  var THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  var LAYER = 'snm-road-3d';
  var DATA_DIR = 'road3d/';
  var index = null, indexState = 'none';   // 有資料的圖磚清單
  var LANE = 3.75, DASH = 4, GAP = 6;

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
          var w = makeWay('o' + r[0], f & 2 ? 'trunk' : 'motorway', !!(f & 1), coords, null,
            { oneway: f & 4 ? 'yes' : 'no', lanes: r[2] || '', bridge: f & 8 ? 'yes' : '', layer: r[3] });
          w.hide = (r[5] && r[5].h) || [];   // 這幾段護欄不畫(電腦算好：會落在別條路上)[邊, 起, 迄(占整條的比例 × 1e6)]
          return w;
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
          pump();
        };
        go();
      })(key, t);
    }
  }

  // ── 高度：橋梁抬高(每層 1.2 公尺，剛好高過下面道路的護欄)，橋頭用引道慢慢降到地面 ──
  // 抬太高的話，畫在地面上的導航路線、路況線、車子會跟橋面對不起來，所以只抬一點點
  function baseH(w) { return w.bridge ? 1.2 * Math.max(1, w.layer) : 0; }
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
    var B = { asphalt: new Bucket(), concrete: new Bucket(), steel: new Bucket(), white: new Bucket(), yellow: new Bucket() };
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

    t.ids.forEach(function (id) { var w = ways[id]; if (w) buildWay(w, origin, sc, B, nearJunc); });

    var group = new T.Group(), any = false;
    Object.keys(B).forEach(function (k) {
      if (!B[k].p.length) return;
      var g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(B[k].p, 3));
      g.computeVertexNormals();
      var mesh = new T.Mesh(g, mats[k]);
      if (k === 'white' || k === 'yellow') mesh.renderOrder = 2;
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
    return { scene: scene, matrix: matrix, box: t.ext || box };
  }

  function buildWay(w, origin, sc, B, nearJunc) {
    var RS = window.RoadShape;
    // 經緯度 → 這塊圖磚的公尺座標(x 東、z 南)
    var local = function (c) { var m = maplibregl.MercatorCoordinate.fromLngLat(c, 0); return [(m.x - origin.x) / sc, (m.y - origin.y) / sc]; };
    var P0 = [], shared = [], last = null;
    w.coords.forEach(function (c, ci) {
      var p = local(c);
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.3) { P0.push(p); shared.push((nodeIdx[nodeKey(w, ci)] || []).length > 1); last = p; }
    });
    if (P0.length < 2) return;
    // 形狀(road_3d_shape.js，跟電腦算的一模一樣)：轉角貝茲曲線(接點不動)；接續的路：接縫斜接方向用兩條平均、車道數不同時寬度漸變
    var P = RS.curve(P0, shared);
    if (P.length < 2) return;
    var cont = function (atEnd) {   // 接續的路：這個點只有兩條路用，一條在這裡結束、一條在這裡開始
      var list = nodeIdx[nodeKey(w, atEnd ? w.coords.length - 1 : 0)] || [];
      if (list.length !== 2) return null;
      var o = list[0].w === w ? list[1] : list[0];
      if (o.w === w || o.w.oneway !== w.oneway || (atEnd ? o.i !== 0 : o.i !== o.w.coords.length - 1)) return null;
      return o.w;
    };
    var dirOf = function (o, atEnd) {   // 那條路原始線的第一段 / 最後一段方向
      var c = o.coords, A = local(atEnd ? c[c.length - 2] : c[0]), Bp = local(atEnd ? c[c.length - 1] : c[1]), l = Math.hypot(Bp[0] - A[0], Bp[1] - A[1]) || 1;
      return [(Bp[0] - A[0]) / l, (Bp[1] - A[1]) / l];
    };
    var prev = cont(false), next = cont(true);
    var fr = RS.frame(P, function (tx, tz) { return [-tz, tx]; }, prev ? dirOf(prev, true) : null, next ? dirOf(next, false) : null);
    var n = P.length, S = fr.S, segR = fr.seg, R = fr.R, L = S[n - 1], i;
    var Wv = RS.widths(w, S, prev ? RS.widthOf(prev) : null, next ? RS.widthOf(next) : null);
    var hb = baseH(w), H = RS.heights(S, hb, endH(w, 0), endH(w, w.coords.length - 1));
    // 護欄不畫的段落(沿路距離)：1 右、-1 左、0 中央
    var hidden = { '1': [], '-1': [], '0': [] };
    for (i = 0; i + 2 < w.hide.length; i += 3) hidden[w.hide[i]].push([w.hide[i + 1] / 1e6 * L, w.hide[i + 2] / 1e6 * L]);
    // 偏移：一個數字 = 整條一樣；陣列 = 每點不同(路寬漸變)
    var ov = function (o, k) { return typeof o === 'number' ? o : o[k]; };
    var plus = function (o, d) { return typeof o === 'number' ? o + d : o.map(function (v) { return v + d; }); };
    var pt = function (k, o, y) { var v = ov(o, k); return [P[k][0] + R[k][0] * v, H[k] + y, P[k][1] + R[k][1] * v]; };
    var at = function (k, t, o, y) {   // 第 k 段比例 t 的點(在兩點中間：沿段的右手方向偏移)
      if (t <= 0) return pt(k, o, y);
      if (t >= 1) return pt(k + 1, o, y);
      var v = ov(o, k) + (ov(o, k + 1) - ov(o, k)) * t, r = segR[k];
      return [P[k][0] + (P[k + 1][0] - P[k][0]) * t + r[0] * v, H[k] + (H[k + 1] - H[k]) * t + y, P[k][1] + (P[k + 1][1] - P[k][1]) * t + r[1] * v];
    };
    // 第 k 段去掉不畫的部分，剩下的 [t0, t1]
    var visible = function (k, side) {
      var s0 = S[k], s1 = S[k + 1], len = s1 - s0, out = [[s0, s1]];
      hidden[side].forEach(function (h) {
        var nx = [];
        out.forEach(function (r) { if (h[1] <= r[0] || h[0] >= r[1]) nx.push(r); else { if (h[0] > r[0]) nx.push([r[0], h[0]]); if (h[1] < r[1]) nx.push([h[1], r[1]]); } });
        out = nx;
      });
      return out.filter(function (r) { return r[1] - r[0] > 0.05; }).map(function (r) { return [(r[0] - s0) / (len || 1), (r[1] - s0) / (len || 1)]; });
    };
    var isHidden = function (side, s) { return hidden[side].some(function (h) { return s >= h[0] && s <= h[1]; }); };

    // 橫斷面(每點)：a / b = 最左 / 最右車道外緣
    var inner = w.oneway ? 1.0 : 1.5, outer = w.oneway ? (w.link ? 2.0 : 3.0) : 1.5;
    var half = Wv.map(function (v) { return v / 2; }), nhalf = Wv.map(function (v) { return -v / 2; });
    var a = Wv.map(function (v) { return -v / 2 + inner; }), b = Wv.map(function (v) { return v / 2 - outer; });
    var strip = function (bk, o1, o2, y) {
      for (var k = 0; k < n - 1; k++) bk.quad(pt(k, o1, y), pt(k, o2, y), pt(k + 1, o2, y), pt(k + 1, o1, y));
    };
    var dashed = function (bk, o, wd, y, ok) {
      // 沿線走，每 10 公尺畫 4 公尺；ok(k) = 這段要不要畫
      var period = DASH + GAP;
      for (var k = 0; k < n - 1; k++) {
        if (ok && !ok(k)) continue;
        var s0 = S[k], s1 = S[k + 1];
        var first = Math.ceil(s0 / period) * period - period;
        for (var st = first; st < s1; st += period) {
          var u0 = Math.max(st, s0), u1 = Math.min(st + DASH, s1);
          if (u1 - u0 < 0.2) continue;
          var t0 = (u0 - s0) / (s1 - s0), t1 = (u1 - s0) / (s1 - s0), h = wd / 2;
          bk.quad(at(k, t0 === 0 ? 1e-9 : t0, plus(o, -h), y), at(k, t0 === 0 ? 1e-9 : t0, plus(o, h), y), at(k, t1 === 1 ? 1 - 1e-9 : t1, plus(o, h), y), at(k, t1 === 1 ? 1 - 1e-9 : t1, plus(o, -h), y));
        }
      }
    };
    // 牆(護欄)：profile = [[橫向偏移, 高度], ...]，沿線拉出來；skip(k) = 這一段不畫；hs = 用哪一邊的「不畫的段落」
    var wall = function (bk, o, side, profile, skip, hs) {
      for (var k = 0; k < n - 1; k++) {
        if (skip && skip(k)) continue;
        var parts = hs == null ? [[0, 1]] : visible(k, hs);
        for (var q = 0; q < parts.length; q++) {
          var t0 = parts[q][0], t1 = parts[q][1];
          for (var j = 0; j < profile.length - 1; j++) {
            var p0 = profile[j], p1 = profile[j + 1], o0 = plus(o, side * p0[0]), o1 = plus(o, side * p1[0]);
            bk.quad(at(k, t0, o0, p0[1]), at(k, t0, o1, p1[1]), at(k, t1, o1, p1[1]), at(k, t1, o0, p0[1]));
          }
        }
      }
    };
    // 鋼板護欄：W 型鋼板(兩道折線)＋立柱
    var guardrail = function (o, side, skip, hs) {
      // W 型鋼板：兩道凸起朝向車道(偏移 0)，上下緣和中間往立柱那邊彎(偏移 0.06)
      wall(B.steel, o, side, [[0.06, 0.45], [0, 0.53], [0.06, 0.6], [0, 0.68], [0.06, 0.76]], skip, hs);
      var period = 4;
      for (var k = 0; k < n - 1; k++) {
        if (skip && skip(k)) continue;
        for (var st = Math.ceil(S[k] / period) * period; st < S[k + 1]; st += period) {
          if (hs != null && isHidden(hs, st)) continue;
          var tt = (st - S[k]) / (S[k + 1] - S[k]), r = segR[k], f = [r[1], -r[0]];   // f：沿線方向(往前)
          var oo = ov(o, k) + (ov(o, k + 1) - ov(o, k)) * tt;
          var cx = P[k][0] + (P[k + 1][0] - P[k][0]) * tt + r[0] * (oo + side * 0.12), cz = P[k][1] + (P[k + 1][1] - P[k][1]) * tt + r[1] * (oo + side * 0.12);
          var y0 = H[k] + (H[k + 1] - H[k]) * tt, y1 = y0 + 0.78, hw = 0.07;
          var c = [[-hw, -hw], [hw, -hw], [hw, hw], [-hw, hw]].map(function (p) { return [cx + r[0] * p[0] + f[0] * p[1], cz + r[1] * p[0] + f[1] * p[1]]; });
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

    // 路面：主線往左多鋪一點(跟對向之間的空隙鋪滿，中央護欄底下不會露出地面)
    var deckL = w.oneway && !w.link ? plus(nhalf, -RS.MEDIAN_FILL) : nhalf;
    strip(B.asphalt, deckL, half, 0.03);
    if (hb > 0) {   // 橋：路面兩側的橋面版側邊
      wall(B.concrete, deckL, -1, [[0, 0.03], [0, -0.5]]);
      wall(B.concrete, half, 1, [[0, 0.03], [0, -0.5]]);
    }
    var my = 0.06;   // 標線比路面高一點點，不會閃
    var skipEnds = function (k) { return S[k + 1] < 60 || S[k] > L - 60; };
    var skipJunc = function (k) { return nearJunc(P[k], 120) || nearJunc(P[k + 1], 120); };
    var edge = function (o, side, skip, hs) {   // 外側：橋上混凝土、平地鋼板；hs = 不畫的段落(會落在別條路上)
      if (hb > 0) wall(B.concrete, o, side, parapet, skip, hs); else guardrail(o, side, skip, hs);
    };
    if (w.oneway) {
      strip(B.yellow, a, plus(a, 0.15), my);                // 內側路面邊線(黃實線)
      strip(B.white, plus(b, -0.15), b, my);                // 外側路面邊線(白實線)
      for (var k2 = 1; k2 < w.lanes; k2++) (function (kk) {   // 車道線(白虛線)：車道數漸變時，窄掉的那條不畫
        dashed(B.white, plus(a, kk * LANE), 0.15, my, function (k) { return a[k] + kk * LANE < b[k] - 1 && a[k + 1] + kk * LANE < b[k + 1] - 1; });
      })(k2);
      if (w.link) {
        edge(plus(half, -0.3), 1, skipEnds, '1');
        edge(plus(nhalf, 0.3), -1, skipEnds, '-1');
      } else {
        edge(plus(half, -0.3), 1, skipJunc, '1');
        wall(B.concrete, plus(nhalf, -0.1), 1, jersey, null, '0');   // 中央分隔護欄
      }
    } else {
      var per = Math.max(1, Math.floor(w.lanes / 2)), hl = per * LANE;
      strip(B.yellow, 0.06, 0.18, my); strip(B.yellow, -0.18, -0.06, my);   // 中央雙黃線
      strip(B.white, hl - 0.15, hl, my); strip(B.white, -hl, -hl + 0.15, my);
      for (var k3 = 1; k3 < per; k3++) { dashed(B.white, k3 * LANE, 0.15, my); dashed(B.white, -k3 * LANE, 0.15, my); }
      edge(plus(half, -0.3), 1, skipEnds, '1');
      edge(plus(nhalf, 0.3), -1, skipEnds, '-1');
    }
  }

  function disposeChunk(c) {
    if (!c) return;
    c.scene.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
  }
  function makeMats() {
    var T = window.THREE, ds = T.DoubleSide;
    var mark = function (color) { return new T.MeshBasicMaterial({ color: color, side: ds, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }); };
    mats = {
      asphalt: new T.MeshLambertMaterial({ color: 0x4A4D52, side: ds }),
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
