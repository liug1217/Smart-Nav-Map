// ===== 🛣 國道、快速道路 3D 路面 =====
// 放大到 zoom 16 以上，把國道(motorway)、快速道路(trunk)與匝道畫成立體道路：
//   - 路面寬度照實際車道數：車道 3.75 公尺、外側路肩 3 公尺、內側路肩 1 公尺(匝道外側路肩 2 公尺)
//   - 標線：車道線白色虛線(劃 4 公尺、空 6 公尺)、外側路面邊線白色實線、內側路面邊線黃色實線；雙向道路中間雙黃線
//   - 護欄：外側鋼板護欄(W 型鋼板＋每 4 公尺一根立柱)、中央分隔混凝土護欄(紐澤西護欄)、橋上外側也是紐澤西護欄
//   - 路燈：道路兩側外面，每 50 公尺一支
//   - 匝道進出口(分流、匯流)那段不畫外側護欄，車道才接得起來
//   - 轉角都改成貝茲曲線(彎道圓順)，匝道接點不動；接續的路接縫斜接、車道數不同時寬度漸變(road_3d_shape.js)
//   - 電腦先修好的：對向車道疊在一起已推開(中間 0.8 公尺鋪滿)、沒標的車道數已推好、會落在別條路上的護欄那段不畫
// 資料：OpenStreetMap 的車道數 lanes、單行道、橋梁，事先切成 zoom 13 圖磚的小檔案(road3d/，用 tools/build-road3d.js 產生)，
//       只抓畫面附近那幾塊、同一塊只抓一次。沒標車道數的用一般值：國道 3、快速道路 2、匝道 1。
//       檔案抓不到(離線)時改用底圖的道路線。
// 圖層放在平面道路線、導航路線的上面(高架底下經過的路被橋面蓋住)、3D 建築和文字標籤的下面；放大到看得到 3D 時，國道的綠線、塞車顏色、導航路線改畫在 3D 路面上(高架上也對得上)，車子抬到橋面高度。
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
          var ex = r[5] || {};
          w.hide = ex.h || [];
          w.ends = ex.e ? [ex.e[0] / 100, ex.e[1] / 100] : null;   // 頭尾高度(電腦算好)
          w.bumps = [];   // 上下交叉要抬到的高度 [比例, 公尺]
          for (var bi = 0; ex.b && bi + 1 < ex.b.length; bi += 2) w.bumps.push([ex.b[bi] / 1e6, ex.b[bi + 1] / 100]);
            // 這幾段護欄不畫(電腦算好：會落在別條路上)[邊, 起, 迄(占整條的比例 × 1e6)]
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
          ovSoon();   // 抓到新的路：線重新對一次
          window.dispatchEvent(new Event('snm-road3d-data'));   // 看板、監視器照路面高度重新擺
          window.map && window.map.triggerRepaint();
          pump();
        };
        go();
      })(key, t);
    }
  }

  // ── 高度：橋梁每層 6 公尺(真的高架)，橋頭用引道慢慢降到地面；上下交叉的淨空、頭尾高度電腦都算好了(w.ends、w.bumps) ──
  function baseH(w) { return window.RoadShape.baseH(w); }
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
    var B = { asphalt: new Bucket(), concrete: new Bucket(), under: new Bucket(), steel: new Bucket(), lamp: new Bucket(), white: new Bucket(), yellow: new Bucket() };
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

    var geo = [];
    t.ids.forEach(function (id) { var w = ways[id], g = w && buildWay(w, origin, sc, B, nearJunc); if (g) geo.push(g); });

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
    var chunk = { scene: scene, matrix: matrix, box: t.ext || box, geo: geo };
    addOverlay(chunk);
    return chunk;
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
    // 曲線(向心 Catmull-Rom)：接續的前一條倒數第二點、下一條第二點當延伸點，跨路段也平順
    var P = RS.curve(P0, shared, prev ? local(prev.coords[prev.coords.length - 2]) : null, next ? local(next.coords[1]) : null);
    if (P.length < 2) return;
    var fr = RS.frame(P, function (tx, tz) { return [-tz, tx]; }, prev ? dirOf(prev, true) : null, next ? dirOf(next, false) : null);
    var n = P.length, S = fr.S, segR = fr.seg, R = fr.R, L = S[n - 1], i;
    var Wv = RS.widths(w, S, prev ? RS.widthOf(prev) : null, next ? RS.widthOf(next) : null);
    var hb = baseH(w), H = RS.heights(S, hb, w.ends ? w.ends[0] : endH(w, 0), w.ends ? w.ends[1] : endH(w, w.coords.length - 1), w.bumps);
    // 護欄不畫的段落(沿路距離)：1 右、-1 左、0 中央
    var hidden = { '1': [], '-1': [], '0': [] };
    var hideList = w.hide || [];
    for (i = 0; i + 2 < hideList.length; i += 3) hidden[hideList[i]].push([hideList[i + 1] / 1e6 * L, hideList[i + 2] / 1e6 * L]);
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
    // 高架：兩側 1.4 公尺深的箱型梁、底面、每 30 公尺一座橋墩(柱子＋帽梁)
    var GD = 1.4;
    var depth = function (k) { return Math.min(GD, H[k]); };
    for (var kb = 0; kb < n - 1; kb++) {
      if (H[kb] < 0.3 && H[kb + 1] < 0.3) continue;
      var d0 = depth(kb), d1 = depth(kb + 1);
      B.concrete.quad(pt(kb, deckL, 0.03), pt(kb + 1, deckL, 0.03), pt(kb + 1, deckL, -d1), pt(kb, deckL, -d0));
      B.concrete.quad(pt(kb, half, 0.03), pt(kb, half, -d0), pt(kb + 1, half, -d1), pt(kb + 1, half, 0.03));
      if (H[kb] > GD + 0.1 && H[kb + 1] > GD + 0.1) B.under.quad(pt(kb, deckL, -d0), pt(kb, half, -d0), pt(kb + 1, half, -d1), pt(kb + 1, deckL, -d1));
    }
    var box = function (c, u, f, w0, l0, y0, y1) {   // 中心 c、橫向 u、沿路 f、寬 w0、長 l0、從 y0 到 y1(絕對高度)
      var cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function (q) { return [c[0] + u[0] * q[0] * w0 / 2 + f[0] * q[1] * l0 / 2, c[1] + u[1] * q[0] * w0 / 2 + f[1] * q[1] * l0 / 2]; });
      for (var e = 0; e < 4; e++) { var A0 = cs[e], A1 = cs[(e + 1) % 4]; B.concrete.quad([A0[0], y0, A0[1]], [A1[0], y0, A1[1]], [A1[0], y1, A1[1]], [A0[0], y1, A0[1]]); }
      B.concrete.quad([cs[0][0], y1, cs[0][1]], [cs[1][0], y1, cs[1][1]], [cs[2][0], y1, cs[2][1]], [cs[3][0], y1, cs[3][1]]);
    };
    for (var sp = 15; sp < L; sp += 30) {
      var kp = 0; while (kp < n - 2 && S[kp + 1] < sp) kp++;
      var tp = (sp - S[kp]) / ((S[kp + 1] - S[kp]) || 1), hp = H[kp] + (H[kp + 1] - H[kp]) * tp;
      if (hp < 3.5) continue;
      var r0 = segR[kp], fw = [r0[1], -r0[0]], mid0 = (deckL[kp] + half[kp]) / 2, wd = half[kp] - deckL[kp];
      var cx = P[kp][0] + (P[kp + 1][0] - P[kp][0]) * tp + r0[0] * mid0, cz = P[kp][1] + (P[kp + 1][1] - P[kp][1]) * tp + r0[1] * mid0;
      var ll = new maplibregl.MercatorCoordinate(origin.x + cx * sc, origin.y + cz * sc, 0).toLngLat();
      if (onLowerRoad([ll.lng, ll.lat], w, hp - GD - 1)) continue;   // 橋墩不能立在底下別條路的路面上
      box([cx, cz], r0, fw, Math.min(3.2, wd * 0.22), 1.8, 0, hp - GD - 1.0);           // 柱子
      box([cx, cz], r0, fw, wd * 0.8, 2.0, hp - GD - 1.0, hp - GD);                      // 帽梁
    }
    var my = 0.06;   // 標線比路面高一點點，不會閃
    var skipEnds = function (k) { return S[k + 1] < 60 || S[k] > L - 60; };
    var skipJunc = function (k) { return nearJunc(P[k], 120) || nearJunc(P[k + 1], 120); };
    var edge = function (o, side, skip, hs) {   // 外側：橋上混凝土、平地鋼板；hs = 不畫的段落(會落在別條路上)
      // 橋上：紐澤西型混凝土護欄(跟中央分隔一樣，底寬 0.66，外緣貼齊路面邊緣)；平地：鋼板護欄
      if (hb > 0) wall(B.concrete, plus(o, -0.36 * side), side, jersey, skip, hs); else guardrail(o, side, skip, hs);
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
    // 路燈：立在道路兩側的外面(單行道的主線、匝道立在自己右邊外側 → 上下行合起來就是整條路的兩側；雙向道路兩邊都立、前後錯開)
    //   造型：圓的鋼管燈桿(下粗上細)＋底座，頂端往上彎再水平伸向車道的燈臂，扁長的 LED 燈頭(朝下發光)
    //   平地立在鋼板護欄外面，橋上立在外側混凝土護欄頂上；每 50 公尺一支，護欄不畫的地方(接到別條路)不立
    var LAMP_H = 11, REACH = 2.6;
    var tube = function (a0, a1, r0, r1, bk) {   // 兩點之間的八角管(r0 → r1 粗細)
      var d = [a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]], L0 = Math.hypot(d[0], d[1], d[2]) || 1;
      d = [d[0] / L0, d[1] / L0, d[2] / L0];
      var u = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      var e1 = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]], l1 = Math.hypot(e1[0], e1[1], e1[2]); e1 = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
      var e2 = [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]];
      var ring = function (c, r) { var out = []; for (var q = 0; q < 8; q++) { var t = q / 8 * Math.PI * 2, cs = Math.cos(t) * r, sn = Math.sin(t) * r; out.push([c[0] + e1[0] * cs + e2[0] * sn, c[1] + e1[1] * cs + e2[1] * sn, c[2] + e1[2] * cs + e2[2] * sn]); } return out; };
      var A0 = ring(a0, r0), A1 = ring(a1, r1);
      for (var q = 0; q < 8; q++) bk.quad(A0[q], A0[(q + 1) % 8], A1[(q + 1) % 8], A1[q]);
    };
    var lamp = function (k, tt, o, dirArm, baseY) {
      var r = segR[k], fw = [r[1], -r[0]], g0 = at(k, tt, o, baseY), y0 = g0[1], top = y0 + LAMP_H;
      var P0 = [g0[0], y0, g0[2]], P1 = [g0[0], top - 0.6, g0[2]];
      tube(P0, P1, 0.13, 0.08, B.steel);                                                        // 燈桿(下粗上細)
      // 底座
      var cs0 = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function (q) { return [g0[0] + r[0] * q[0] * 0.25 + fw[0] * q[1] * 0.25, g0[2] + r[1] * q[0] * 0.25 + fw[1] * q[1] * 0.25]; });
      for (var e = 0; e < 4; e++) { var c0 = cs0[e], c1 = cs0[(e + 1) % 4]; B.steel.quad([c0[0], y0, c0[1]], [c1[0], y0, c1[1]], [c1[0], y0 + 0.12, c1[1]], [c0[0], y0 + 0.12, c0[1]]); }
      // 燈臂：往上彎再伸向車道(三段)
      var out = function (dist, y) { return [g0[0] + r[0] * dirArm * dist, y, g0[2] + r[1] * dirArm * dist]; };
      var A1 = out(0.35, top - 0.15), A2 = out(1.0, top + 0.05), A3 = out(REACH, top + 0.12);
      tube(P1, A1, 0.08, 0.065, B.steel); tube(A1, A2, 0.065, 0.055, B.steel); tube(A2, A3, 0.055, 0.05, B.steel);
      // LED 燈頭：扁長、沿著燈臂方向，底下是發光面
      var hx = A3[0] + r[0] * dirArm * 0.4, hz = A3[2] + r[1] * dirArm * 0.4, hy = A3[1];
      var hc = [[-0.55, -0.17], [0.55, -0.17], [0.55, 0.17], [-0.55, 0.17]].map(function (q) { return [hx + r[0] * dirArm * q[0] + fw[0] * q[1], hz + r[1] * dirArm * q[0] + fw[1] * q[1]]; });
      B.steel.quad([hc[0][0], hy + 0.08, hc[0][1]], [hc[1][0], hy + 0.06, hc[1][1]], [hc[2][0], hy + 0.06, hc[2][1]], [hc[3][0], hy + 0.08, hc[3][1]]);   // 上蓋
      for (var e2 = 0; e2 < 4; e2++) { var d0 = hc[e2], d1 = hc[(e2 + 1) % 4]; B.steel.quad([d0[0], hy - 0.04, d0[1]], [d1[0], hy - 0.04, d1[1]], [d1[0], hy + 0.07, d1[1]], [d0[0], hy + 0.07, d0[1]]); }
      B.lamp.quad([hc[0][0], hy - 0.045, hc[0][1]], [hc[3][0], hy - 0.045, hc[3][1]], [hc[2][0], hy - 0.045, hc[2][1]], [hc[1][0], hy - 0.045, hc[1][1]]);   // 發光面(朝下)
    };
    // 外側位置：平地在鋼板護欄外面 0.6 公尺；橋上在外側混凝土護欄頂上(護欄外緣往內 0.33、高 0.85)
    var sideSpot = function (k, tt, side) {
      var e = side > 0 ? half[k] + (half[k + 1] - half[k]) * tt : nhalf[k] + (nhalf[k + 1] - nhalf[k]) * tt;
      return hb > 0 ? { o: e - side * 0.33, y: 0.85 } : { o: e + side * 0.6, y: 0 };
    };
    var sides = w.oneway ? [1] : [1, -1];
    sides.forEach(function (side) {
      for (var sl = side > 0 ? 25 : 50; sl < L - 10; sl += 50) {
        var kl = 0; while (kl < n - 2 && S[kl + 1] < sl) kl++;
        var tl = (sl - S[kl]) / ((S[kl + 1] - S[kl]) || 1);
        if (isHidden(side > 0 ? '1' : '-1', sl) || ((w.link || !w.oneway) && skipEnds(kl))) continue;
        var sp = sideSpot(kl, tl, side);
        lamp(kl, tl, sp.o, -side, sp.y);   // 燈臂伸向車道
      }
    });
    return { w: w, P: P, segR: segR, R: R, H: H, S: S, L: L, a: a, b: b, half: half, nhalf: nhalf };   // 疊線(路況、導航路線)、車子、監視器、看板高度用
  }

  // 這點(經緯度)在不在別條、比 top 低的路的路面上(橋墩用)
  function onLowerRoad(p, self, top) {
    var g = wayGrid(), x = p[0] * KX, y = p[1] * KY, cx = Math.floor(x / 50), cy = Math.floor(y / 50);
    for (var a = cx - 1; a <= cx + 1; a++) for (var b = cy - 1; b <= cy + 1; b++) {
      var list = g[a + ',' + b] || [];
      for (var q = 0; q < list.length; q++) {
        var w = list[q][0], i = list[q][1];
        if (w === self || baseH(w) >= top) continue;
        var A = w.coords[i], Bc = w.coords[i + 1], ax = A[0] * KX, ay = A[1] * KY, dx = Bc[0] * KX - ax, dy = Bc[1] * KY - ay, L2 = dx * dx + dy * dy;
        if (!L2) continue;
        var t = ((x - ax) * dx + (y - ay) * dy) / L2;
        if (t < 0 || t > 1) continue;
        if (Math.abs((x - ax) * dy - (y - ay) * dx) / Math.sqrt(L2) < window.RoadShape.widthOf(w) / 2 + 1.5) return true;
      }
    }
    return false;
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
      under: new T.MeshLambertMaterial({ color: 0x9A978F, side: ds }),   // 橋面版底面(陰影處)
      lamp: new T.MeshBasicMaterial({ color: 0xFFF3C4, side: ds }),      // 路燈燈面(不受光線影響，看起來是亮的)
      steel: new T.MeshPhongMaterial({ color: 0xC4CACF, specular: 0x8A8F94, shininess: 60, side: ds }),
      white: mark(0xF4F4F4),
      yellow: mark(0xF2BE1A),
    };
  }

  // ── 畫在橋面上的線：路況綠線、塞車顏色、導航路線(含已行駛的灰色)、車子 ──
  // 高架抬高後，地圖上畫在地面的線會跟橋面錯開，所以放大到看得到 3D 時：
  //   - 國道、快速道路的綠色底圖(snm-roads-*-freeway)改畫在每條 3D 路面上，地面那份藏起來
  //   - 塞車路段、導航路線：把線對到 3D 路面上(每 5 公尺一點，找方向一樣、12 公尺內的路；疊在一起的高架 / 平面用「接得上的那條」決定)，
  //     對到的那段畫在路面上，地面那份只留沒對到的部分(一般道路還是畫在地面)
  //   - 車子：在高架上時圖示往上移到橋面的高度
  var OV_SRC = { navRoute: 'route', navRoutePassed: 'passed', 'snm-traffic-src': 'traffic' };
  var OV_STYLE = {   // 每種線：外框寬、內線寬(公尺)、高度(比路面高一點，順序：綠色底圖 < 塞車 / 路線 < 已行駛灰色)
    green: { cw: 3.2, iw: 2.4, y: 0.065 }, traffic: { cw: 3.2, iw: 2.4, y: 0.075 }, route: { cw: 3.2, iw: 2.4, y: 0.075 }, passed: { cw: 3.2, iw: 2.4, y: 0.085 }
  };
  var ovData = {}, ovItems = [], ovTimer = null, ovGreen = false, ovCache = {}, ovSig = '';
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
  var ovLast = 0;
  function ovSoon() { clearTimeout(ovTimer); ovTimer = setTimeout(function () { ovLast = Date.now(); applyOverlays(); }, Math.max(120, 1500 - (Date.now() - ovLast))); }
  // 地面的國道綠線：放大到 3D 出現時藏起來(改畫在路面上)
  //   底圖自己的國道線(橘色那幾層，隧道除外)也一起藏，不然高架底下的地面會露出一條
  function hideFlatFreeway() {
    var m = window.map;
    var base = ((m.getStyle() || {}).layers || []).filter(function (l) { return l.type === 'line' && /motorway|trunk/.test(l.id) && !/tunnel/.test(l.id) && !/^snm-/.test(l.id); }).map(function (l) { return l.id; });
    ['snm-roads-outline-freeway', 'snm-roads-line-freeway'].concat(base).forEach(function (id) {
      if (!m.getLayer(id) || m.getLayer(id)._snm3d) return;
      var cur = m.getPaintProperty(id, 'line-opacity');
      if (Array.isArray(cur)) return;   // 已經是跟縮放有關的設定：不動
      m.setPaintProperty(id, 'line-opacity', ['step', ['zoom'], typeof cur === 'number' ? cur : 1, MIN_ZOOM, 0]);
      m.getLayer(id)._snm3d = true;
    });
  }

  // 路的格子索引(經緯度 → 本地公尺)
  var KX = 111320 * Math.cos(23.7 * Math.PI / 180), KY = 110540, gIdx = null, gCount = -1;
  function wayGrid() {
    var ids = Object.keys(ways);
    if (gIdx && gCount === ids.length) return gIdx;
    gIdx = {}; gCount = ids.length;
    ids.forEach(function (id) {
      var w = ways[id], c = w.coords, acc = 0;
      w._len = []; w._len[0] = 0;
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
  function connected(A, B) {   // 兩條路有接在一起(共用一個點)
    if (A === B) return true;
    var key = A.id + '|' + B.id;
    if (connected.memo[key] !== undefined) return connected.memo[key];
    var r = A.coords.some(function (c) { return (nodeIdx[c[0].toFixed(6) + ',' + c[1].toFixed(6)] || []).some(function (o) { return o.w === B; }); });
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
    samples.forEach(function (sm, k) {
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
    var on = [], off = [], run = null, offStart = null;
    var half = 2.5;
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
        var p0 = [A[0] + (Bc[0] - A[0]) * (a - acc) / L, A[1] + (Bc[1] - A[1]) * (a - acc) / L], p1 = [A[0] + (Bc[0] - A[0]) * (b - acc) / L, A[1] + (Bc[1] - A[1]) * (b - acc) / L];
        if (!out.length) out.push(p0);
        out.push(p1);
      }
      acc += L;
    }
    return out;
  }
  // 把線切成「在範圍裡 / 外」的幾段(範圍外多留 50 公尺重疊，接得起來)
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
  // 線有沒有經過已經抓到的 3D 路(沒有就不用對，直接留在地面)
  function inLoaded(cs) {
    var e = loadedBox(); if (!e) return false;
    return cs.some(function (c) { return c[0] >= e.w && c[0] <= e.e && c[1] >= e.s && c[1] <= e.n; });
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
      var keep = [];
      data.features.forEach(function (f) {
        var p = f.properties || {}, lines = linesOf(f);
        if (!lines.length || !lines.some(inLoaded) || (kind === 'traffic' && p.roadClass !== 'motorway' && p.roadClass !== 'trunk')) { keep.push(f); return; }
        // 只對已經抓到 3D 路的範圍裡那一段(整條路線 150 公里只算畫面附近)，範圍外的直接留在地面
        splitByBox(lines, box).forEach(function (part) {
          if (!part.inside) { keep.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: part.c }, properties: p }); return; }
          var cs = part.c;
          var r = matchLine(cs);
          r.on.forEach(function (x) { mine.push({ kind: kind, w: x.w, f0: x.f0, f1: x.f1, opp: x.opp, color: p.color || (kind === 'passed' ? '#C9CDD2' : '#16E098'), casing: p.casing || (kind === 'passed' ? '#9AA0A6' : kind === 'traffic' ? ({ moderate: '#B07C00', slow: '#B34C00', congested: '#A32020', severe: '#4F0000' }[p.trafficLevel] || '#009B65') : '#009B65') }); });
          r.off.forEach(function (c2) { keep.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: c2 }, properties: p }); });
        });
      });
      src._snmOrig({ type: 'FeatureCollection', features: keep });
      items.push.apply(items, mine);
    });
    // 綠色底圖：地面那份看得到的時候，每條國道、快速道路的 3D 路面都畫綠線
    var gl = m.getLayer('snm-roads-line-freeway');
    ovGreen = on && !!gl && m.getLayoutProperty('snm-roads-line-freeway', 'visibility') !== 'none';
    if (on) hideFlatFreeway();
    // 畫在路面上的線跟上次一樣就不用重建模型
    var sig = (ovGreen ? 'G' : '') + items.map(function (it) { return it.kind + it.w.id + ':' + it.f0.toFixed(4) + '-' + it.f1.toFixed(4) + it.color; }).join('|');
    ovItems = items;
    if (sig === ovSig) { m.triggerRepaint(); return; }
    ovSig = sig;
    Object.keys(tiles).forEach(function (k) { if (tiles[k].chunk) addOverlay(tiles[k].chunk); });
    m.triggerRepaint();
  }

  // 每塊模型的疊線(換資料時整組重建)
  function addOverlay(chunk) {
    var T = window.THREE;
    if (chunk.ov) { chunk.scene.remove(chunk.ov); chunk.ov.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); chunk.ov = null; }
    var buckets = {}, bk = function (color) { return (buckets[color] = buckets[color] || new Bucket()); };
    var byWay = {};
    ovItems.forEach(function (it) { (byWay[it.w.id] = byWay[it.w.id] || []).push(it); });
    chunk.geo.forEach(function (g) {
      var list = (byWay[g.w.id] || []).slice();
      if (ovGreen) list.unshift({ kind: 'green', f0: 0, f1: 1, opp: false, color: '#16E098', casing: '#009B65' });
      list.forEach(function (it) {
        var st = OV_STYLE[it.kind], s0 = Math.max(0, it.f0) * g.L, s1 = Math.min(1, it.f1) * g.L;
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
        // 導航路線：白色箭頭(每 20 公尺一個 ^，尖端朝行車方向)
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
    var group = new T.Group();
    Object.keys(buckets).forEach(function (color) {
      var g2 = new T.BufferGeometry();
      g2.setAttribute('position', new T.Float32BufferAttribute(buckets[color].p, 3));
      var mesh = new T.Mesh(g2, ovMat(color));
      mesh.renderOrder = 3; mesh.frustumCulled = false;
      group.add(mesh);
    });
    chunk.ov = group;
    chunk.scene.add(group);
  }
  var ovMats = {};
  function ovMat(color) {
    var T = window.THREE;
    return ovMats[color] || (ovMats[color] = new T.MeshBasicMaterial({ color: new T.Color(color), side: T.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
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
    // 那條路在這個位置的高度：從已經建好的模型找
    var h = 0;
    Object.keys(tiles).some(function (k) {
      var ch = tiles[k].chunk; if (!ch) return false;
      var g = ch.geo.find(function (x) { return x.w === pick.w; }); if (!g) return false;
      var s = pick.f * g.L, i = 0; while (i < g.S.length - 2 && g.S[i + 1] < s) i++;
      var t = (s - g.S[i]) / ((g.S[i + 1] - g.S[i]) || 1); h = g.H[i] + (g.H[i + 1] - g.H[i]) * t; return true;
    });
    return { p: p, h: h };
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
  // 高架抬高後，從高架底下經過的路(綠線、地面的導航路線)要被橋面蓋住：3D 路面放在所有平面道路線的上面、3D 建築和文字標籤的下面
  function beforeId(m) {
    var ids = ['building-3d', 'user-pulse', 'user-car'];
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
    if (!m) return;
    var nowActive = m.getZoom() >= MIN_ZOOM;
    if (nowActive !== wasActive) { wasActive = nowActive; ovSoon(); }   // 放大 / 縮小跨過 3D：地面的線換回完整的 / 只留沒對到路面的
    if (!nowActive) return;
    ensureThree(function () {
      addLayer();
      hookSources();
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
    carShift = [0, 0];
    setTimeout(ovSoon, 300);   // 換樣式後圖層、資料來源都是新的：重新接手
    if (window.THREE && window.map && window.map.getZoom() >= MIN_ZOOM) addLayer();
  };
  window._snmRoad3dAt = function (lon, lat, maxD) {
    var g = wayGrid(), x = lon * KX, y = lat * KY, cx = Math.floor(x / 50), cy = Math.floor(y / 50), best = null;
    for (var a = cx - 1; a <= cx + 1; a++) for (var b = cy - 1; b <= cy + 1; b++) (g[a + ',' + b] || []).forEach(function (e) {
      var w = e[0], i = e[1], A = w.coords[i], Bc = w.coords[i + 1], ax = A[0] * KX, ay = A[1] * KY, dx = Bc[0] * KX - ax, dy = Bc[1] * KY - ay, L2 = dx * dx + dy * dy;
      if (!L2) return;
      var t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)), L = Math.sqrt(L2);
      var lat2 = ((x - ax) * dy - (y - ay) * dx) / L, d = Math.hypot(x - ax - dx * t, y - ay - dy * t);   // 右正
      if (d > (maxD || 25) || (best && d >= best.d)) return;
      best = { d: d, w: w, f: (w._len[i] + L * t) / w._L, side: lat2, bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360, lon: A[0] + (Bc[0] - A[0]) * t, lat: A[1] + (Bc[1] - A[1]) * t };
    });
    if (!best) return null;
    var out = null;
    Object.keys(tiles).some(function (k) {
      var ch = tiles[k].chunk, gg = ch && ch.geo.find(function (q) { return q.w === best.w; });
      if (!gg) return false;
      var s = best.f * gg.L, i = 0; while (i < gg.S.length - 2 && gg.S[i + 1] < s) i++;
      var t = (s - gg.S[i]) / ((gg.S[i + 1] - gg.S[i]) || 1), li = function (arr) { return arr[i] + (arr[i + 1] - arr[i]) * t; };
      out = { h: li(gg.H), bearing: best.bearing, side: best.side, half: li(gg.half), nhalf: li(gg.nhalf), lon: best.lon, lat0: best.lat, oneway: best.w.oneway, link: best.w.link, id: best.w.id };
      return true;
    });
    return out;
  };
  window._snmRoad3dState = function () { return { tiles: tiles, ways: ways, threeState: threeState, ovGreen: ovGreen, ovItems: ovItems, ovData: ovData, carShift: carShift }; };   // 除錯用
  var timer = null, liftTimer = null, wasActive = false;
  function init() {
    var m = window.map;
    if (!m) { setTimeout(init, 500); return; }
    var go = function () {
      m.on('moveend', function () { clearTimeout(timer); timer = setTimeout(check, 250); });
      // 導航時鏡頭一直跟著車子動、不會有「移動結束」：移動中也每 0.7 秒檢查一次(開到新的地方才抓得到 3D 路)
      var lastMove = 0;
      m.on('move', function () { var now = Date.now(); if (now - lastMove > 700) { lastMove = now; check(); } });
      check();
    };
    // 主程式會重排路線圖層(放到 3D 建築下面)：重排後把 3D 路面再放回它們上面
    var placing = false;
    m.on('styledata', function () {
      if (placing || !m.getLayer(LAYER)) return;
      var o = m.style && m.style._order, b = beforeId(m);
      if (!o || !b || o.indexOf(LAYER) === o.indexOf(b) - 1) return;
      placing = true; try { m.moveLayer(LAYER, b); } catch (e) {} placing = false;
    });
    if (m.loaded()) go(); else m.once('load', go);
  }
  init();
})();
