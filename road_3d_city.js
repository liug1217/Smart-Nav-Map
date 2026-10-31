// ===== 🏙 一般道路 3D 路面(省道、縣道、市區道路、巷弄) =====
// 放大到 zoom 16 以上，把底圖的一般道路(openmaptiles transportation：primary / secondary / tertiary / minor / service)畫成 3D 路面：
//   - 底圖的道路被切成一塊一塊(圖磚)，先去掉重複的、切邊多出來的小尾巴，再接成完整的一條(路口斷開)
//   - 曲線跟國道一樣用向心 Catmull-Rom 樣條(road_3d_shape.js)：通過每個原始點、沒有折角
//   - 路寬：OSM 有標車道數的路(road3d-city/，tools/build-city-lanes.js 產生)照車道數；沒標的照道路等級：
//     省道級(primary) 雙向 4 線、縣道級(secondary) 雙向 4 線(較窄)、區道(tertiary) 雙向 2 線、巷弄 6 公尺、服務道路 4 公尺；單行道減半
//   - 標線：primary / secondary 中央雙黃線＋白色車道虛線＋路面邊線；tertiary 中央黃虛線＋邊線；巷弄、服務道路不畫；路口裡面不畫標線
//   - 從平面的國道上面跨過去的路：抬到國道上方 5.3 公尺(淨空 4.5)，用 4% 坡度接回地面，兩側紐澤西護欄(只有面向車道那面是斜的)
//   - 不卡：畫面還在建好的範圍裡不重建；底圖、國道 3D 載入新資料只做記號，最多每 5 秒重建一次；
//     建的時候分批(每格畫面最多 6 毫秒)，建好才換掉舊的(建的期間舊的照常顯示)
// 圖層放在路況綠線、導航路線的下面(路況顏色、導航路線照樣畫在上面)，國道 3D 路面的下面
(function () {
  'use strict';
  var MIN_ZOOM = 15, LAYER = 'snm-road-3d-city';
  var CLASS = {   // 寬(公尺)、車道寬、每個方向幾線、高度(大路畫在小路上面，路口不打架)、標線
    primary:   { lanes: 2, lane: 3.5, edge: 1.5, y: 0.030, mark: 'double' },
    secondary: { lanes: 2, lane: 3.25, edge: 1.0, y: 0.026, mark: 'double' },
    tertiary:  { lanes: 1, lane: 3.25, edge: 1.0, y: 0.022, mark: 'dashed' },
    minor:     { lanes: 1, lane: 3.0, edge: 0, y: 0.018, mark: 'none', fixedW: 6 },
    service:   { lanes: 1, lane: 2.0, edge: 0, y: 0.014, mark: 'none', fixedW: 4 }
  };
  var renderer = null, camera = null, chunk = null, timer = null, builtFor = null, mats = null, dirty = false, job = null, BUDGET = 6;
  // 紐澤西護欄(抬高那段的兩側)：背面直立、面向車道那面斜的；x = 0 在路面邊緣、往路裡面
  var JERSEY = [[0, 0], [0, 0.85], [0.22, 0.85], [0.28, 0.33], [0.41, 0.08], [0.46, 0]];

  // ── 車道數(road3d-city/ 圖磚，zoom 13，跟國道 3D 一樣只抓畫面附近的) ──
  var LANE_DIR = 'road3d-city/', laneIndex = null, laneIdxState = 'none', laneTiles = {}, laneGrid = {}, LKX = 111320 * Math.cos(23.7 * Math.PI / 180), LKY = 110540;
  function l2x(lon) { return Math.floor((lon + 180) / 360 * 8192); }
  function l2y(lat) { var r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 8192); }
  function loadLanes(box) {
    if (laneIdxState === 'none') { laneIdxState = 'loading'; fetch(LANE_DIR + 'index.json').then(function (r) { return r.json(); }).then(function (l) { laneIndex = {}; l.forEach(function (k) { laneIndex[k] = 1; }); laneIdxState = 'ready'; loadLanes(box); }).catch(function () { laneIdxState = 'failed'; }); return; }
    if (laneIdxState !== 'ready') return;
    for (var x = l2x(box.w); x <= l2x(box.e); x++) for (var y = l2y(box.n); y <= l2y(box.s); y++) (function (k) {
      if (laneTiles[k] || !laneIndex[k]) return;
      laneTiles[k] = 'loading';
      fetch(LANE_DIR + '13/' + k + '.json').then(function (r) { return r.json(); }).then(function (j) {
        laneTiles[k] = 'ready';
        (j.w || []).forEach(function (rec) {
          var d = rec[2], X = d[0], Y = d[1], c = [[X / 1e6, Y / 1e6]];
          for (var i = 2; i < d.length; i += 2) { X += d[i]; Y += d[i + 1]; c.push([X / 1e6, Y / 1e6]); }
          var w = { lanes: rec[0], oneway: rec[1] === 1, c: c };
          for (i = 0; i < c.length - 1; i++) {
            var gx0 = Math.floor(Math.min(c[i][0], c[i + 1][0]) * LKX / 50), gx1 = Math.floor(Math.max(c[i][0], c[i + 1][0]) * LKX / 50);
            var gy0 = Math.floor(Math.min(c[i][1], c[i + 1][1]) * LKY / 50), gy1 = Math.floor(Math.max(c[i][1], c[i + 1][1]) * LKY / 50);
            for (var gx = gx0; gx <= gx1; gx++) for (var gy = gy0; gy <= gy1; gy++) (laneGrid[gx + ',' + gy] = laneGrid[gx + ',' + gy] || []).push([w, i]);
          }
        });
        if (builtFor && !job) { builtFor = null; soon(); }   // 車道數到了：重建一次(照車道數畫)
      }).catch(function () { laneTiles[k] = null; });
    })(x + '_' + y);
  }
  // 這點(方向 dir：東、北單位向量)附近 8 公尺內、方向差 30 度內最近那條 OSM 路的車道數(雙向道路是兩個方向加起來)
  function laneAt(p, dir) {
    var x = p[0] * LKX, y = p[1] * LKY, cx = Math.floor(x / 50), cy = Math.floor(y / 50), best = null;
    for (var a = cx - 1; a <= cx + 1; a++) for (var b = cy - 1; b <= cy + 1; b++) (laneGrid[a + ',' + b] || []).forEach(function (e) {
      var w = e[0], i = e[1], A = w.c[i], B = w.c[i + 1], ax = A[0] * LKX, ay = A[1] * LKY, dx = B[0] * LKX - ax, dy = B[1] * LKY - ay, L2 = dx * dx + dy * dy;
      if (!L2) return;
      var t = ((x - ax) * dx + (y - ay) * dy) / L2;
      if (t < -0.05 || t > 1.05) return;
      var L = Math.sqrt(L2), d = Math.abs((x - ax) * dy - (y - ay) * dx) / L, cos = (dx * dir[0] + dy * dir[1]) / L;
      if (d > 8 || (w.oneway ? cos < 0.87 : Math.abs(cos) < 0.87)) return;
      if (!best || d < best.d) best = { d: d, w: w };
    });
    return best ? best.w.lanes : null;
  }
  // 這條路用的車道設定：有車道數就照它(每個方向幾線)，沒有就照道路等級
  function laneSpec(r) {
    var k = CLASS[r.cls];
    if (k.fixedW || !r.lanesT) return k;
    var per = r.oneway ? r.lanesT : Math.max(1, Math.round(r.lanesT / 2));
    return { lanes: per, lane: k.lane, edge: k.edge, y: k.y, mark: per >= 2 && !r.oneway ? 'double' : k.mark };
  }
  function roadW(r) { var k = laneSpec(r); return k.fixedW ? (r.oneway ? Math.max(3.5, k.fixedW * 0.7) : k.fixedW) : (r.oneway ? k.lanes : k.lanes * 2) * k.lane + k.edge * 2; }

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
    var eg = {};   // 線段格子(找附近的線段快很多)
    Object.keys(edges).forEach(function (key) { var e = edges[key]; for (var gx = Math.floor(Math.min(e.a[0], e.c[0]) * 2000); gx <= Math.floor(Math.max(e.a[0], e.c[0]) * 2000); gx++) for (var gy = Math.floor(Math.min(e.a[1], e.c[1]) * 2000); gy <= Math.floor(Math.max(e.a[1], e.c[1]) * 2000); gy++) (eg[gx + ',' + gy] = eg[gx + ',' + gy] || []).push(key); });
    var onOther = function (pt, self) {
      var near = eg[Math.floor(pt[0] * 2000) + ',' + Math.floor(pt[1] * 2000)] || [];
      for (var q = 0; q < near.length; q++) {
        var key = near[q], e = edges[key]; if (!e || key === self) continue;
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
      var e = edges[key], line = [e.a, e.c], keys = [e.ka, e.kc], endE = [e, e];
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
        endE[atEnd ? 1 : 0] = cur;
      });
      // 頭尾的延伸點(貝茲曲線、接縫斜接用)：接在這個點、轉角最小(30 度內)的那條路的下一個點；沒有就沒有
      var ghost = function (k, q, own) {
        var c = line[q === 0 ? 0 : line.length - 1], inner = line[q === 0 ? 1 : line.length - 2], best = null, bt = 30;
        var d1 = [(c[0] - inner[0]) * kx, (c[1] - inner[1]) * ky], l1 = Math.hypot(d1[0], d1[1]) || 1;
        live(k).forEach(function (x) {
          var ed = edges[x]; if (!ed || ed === own) return;
          var far = ed.ka === k ? ed.c : ed.a, d2 = [(far[0] - c[0]) * kx, (far[1] - c[1]) * ky], l2 = Math.hypot(d2[0], d2[1]) || 1;
          var tv = Math.acos(Math.max(-1, Math.min(1, (d1[0] * d2[0] + d1[1] * d2[1]) / (l1 * l2)))) * 180 / Math.PI;
          if (tv < bt) { bt = tv; best = far; }
        });
        return best;
      };
      out.push({ cls: e.cls, oneway: e.oneway, coords: line, endsDeg: [live(keys[0]).length, live(keys[keys.length - 1]).length],
        ghostA: ghost(keys[0], 0, endE[0]), ghostB: ghost(keys[keys.length - 1], 1, endE[1]) });
    });
    return out;
  }

  // ── 幾何 ──
  function Bucket() { this.p = []; }
  Bucket.prototype.quad = function (a, b, c, d) { this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]); };

  // 開始建：先收集道路(一次)，路一條一條分批建
  function build() {
    var m = window.map;
    var bb = m.getBounds(), pw = (bb.getEast() - bb.getWest()) * 0.6, ph = (bb.getNorth() - bb.getSouth()) * 0.6;   // 多建一點範圍，開車時不用一直重建
    var box = { w: bb.getWest() - pw, e: bb.getEast() + pw, s: bb.getSouth() - ph, n: bb.getNorth() + ph };
    var roads = collect(box);
    loadLanes(box);
    if (!roads.length) { builtFor = null; clearTimeout(timer); timer = setTimeout(check, 1500); return; }   // 底圖的道路還沒載入：等一下再試(不然會建出空的)
    // 每條路中間那一點找車道數
    roads.forEach(function (r) {
      if (CLASS[r.cls].fixedW) return;
      var c = r.coords, i = Math.floor((c.length - 1) / 2), A = c[i], Bq = c[i + 1] || c[i], dx = (Bq[0] - A[0]) * LKX, dy = (Bq[1] - A[1]) * LKY, l = Math.hypot(dx, dy);
      if (l > 0.1) r.lanesT = laneAt([(A[0] + Bq[0]) / 2, (A[1] + Bq[1]) / 2], [dx / l, dy / l]);
    });
    var c = m.getCenter(), origin = maplibregl.MercatorCoordinate.fromLngLat([c.lng, c.lat], 0), sc = origin.meterInMercatorCoordinateUnits();
    var K = function (q) { return q[0].toFixed(6) + ',' + q[1].toFixed(6); }, junW = {};
    roads.forEach(function (r) { var w = roadW(r); [r.coords[0], r.coords[r.coords.length - 1]].forEach(function (q) { var k = K(q); junW[k] = Math.max(junW[k] || 0, w / 2); }); });
    builtFor = { box: box, zoom: m.getZoom(), at: Date.now() }; dirty = false;
    job = { roads: roads, i: 0, origin: origin, sc: sc, junW: junW, K: K, B: { asphalt: new Bucket(), white: new Bucket(), yellow: new Bucket(), concrete: new Bucket() }, keys: null, meshes: [] };
    requestAnimationFrame(step);
  }
  function step() {
    var jb = job; if (!jb) return;
    var t0 = performance.now();
    while (jb.i < jb.roads.length && performance.now() - t0 < BUDGET) buildRoad(jb, jb.roads[jb.i++]);
    if (jb.i < jb.roads.length) { requestAnimationFrame(step); return; }
    // 路都建完：每格畫面做一種材質的模型
    if (!jb.keys) jb.keys = Object.keys(jb.B).filter(function (k) { return jb.B[k].p.length; });
    var k = jb.keys.shift();
    if (k) {
      var T = window.THREE, g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(jb.B[k].p, 3));
      if (k !== 'white' && k !== 'yellow') g.computeVertexNormals();
      var mesh = new T.Mesh(g, mats[k]); mesh.frustumCulled = false;
      if (k === 'white' || k === 'yellow') mesh.renderOrder = 2;
      jb.meshes.push(mesh); jb.B[k] = null;
      requestAnimationFrame(step); return;
    }
    finish(jb);
  }
  function buildRoad(jb, r) {
    var RS = window.RoadShape, origin = jb.origin, sc = jb.sc, B = jb.B, junW = jb.junW, K = jb.K;
    var local = function (q) { var mc = maplibregl.MercatorCoordinate.fromLngLat(q, 0); return [(mc.x - origin.x) / sc, (mc.y - origin.y) / sc]; };
    (function () {
      var P0 = [], last = null;
      r.coords.forEach(function (q) { var p = local(q); if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.3) { P0.push(p); last = p; } });
      if (P0.length < 2) return;
      // 貝茲曲線：頭尾用接續那條路的點當延伸點(接縫兩邊切線一樣、不會折角)，接縫的斜接方向也照它
      var gA = r.ghostA ? local(r.ghostA) : null, gB = r.ghostB ? local(r.ghostB) : null;
      var unit = function (a, b) { var dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz); return l > 0.05 ? [dx / l, dz / l] : null; };
      var P = RS.curve(P0, [], gA, gB), fr = RS.frame(P, function (tx, tz) { return [-tz, tx]; }, gA ? unit(gA, P0[0]) : null, gB ? unit(P0[P0.length - 1], gB) : null), n = P.length, S = fr.S, R = fr.R, segR = fr.seg, L = S[n - 1];
      var k = laneSpec(r), W = roadW(r), hw = W / 2;
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
      // 沿線的帶狀(路面、實線)：有 from / to 就剛好切在那裡(路口裡面不畫，不會整段伸進路口)
      var at = function (q, t, o, y) { var rr = t <= 0 ? R[q] : t >= 1 ? R[q + 1] : segR[q]; return [P[q][0] + (P[q + 1][0] - P[q][0]) * t + rr[0] * o, H[q] + (H[q + 1] - H[q]) * t + y, P[q][1] + (P[q + 1][1] - P[q][1]) * t + rr[1] * o]; };
      var strip = function (bk, o1, o2, y, from, to) {
        for (var q = 0; q < n - 1; q++) {
          if (from == null) { bk.quad(pt(q, o1, y), pt(q, o2, y), pt(q + 1, o2, y), pt(q + 1, o1, y)); continue; }
          var a0 = Math.max(S[q], from), a1 = Math.min(S[q + 1], to), len = (S[q + 1] - S[q]) || 1;
          if (a1 - a0 < 0.02) continue;
          var t0 = (a0 - S[q]) / len, t1 = (a1 - S[q]) / len;
          bk.quad(at(q, t0, o1, y), at(q, t0, o2, y), at(q, t1, o2, y), at(q, t1, o1, y));
        }
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
        // 停止線(白實線、寬 35 公分)：路口前、駛入路口那半邊(靠右行駛：路尾畫右半邊、路頭畫左半邊；單行道路尾整個路面)
        if (r.endsDeg[1] >= 3) strip(B.white, r.oneway ? -hw + k.edge : 0.25, hw - k.edge, my + 0.002, to - 0.35, to);
        if (r.endsDeg[0] >= 3 && !r.oneway) strip(B.white, -hw + k.edge, -0.25, my + 0.002, from, from + 0.35);
      }
      // 抬高的那段：兩側紐澤西護欄＋橋面版側邊
      if (cross.length) {
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
    })();
  }
  // 建好了：換掉舊的
  function finish(jb) {
    var m = window.map, T = window.THREE, origin = jb.origin, sc = jb.sc;
    job = null;
    var group = new T.Group();
    jb.meshes.forEach(function (mesh) { group.add(mesh); });
    var scene = new T.Scene();
    scene.add(new T.AmbientLight(0xffffff, 0.62));
    var sun = new T.DirectionalLight(0xffffff, 0.6); sun.position.set(0.4, 1, 0.6); scene.add(sun);
    scene.add(group);
    var matrix = new T.Matrix4().makeTranslation(origin.x, origin.y, origin.z).scale(new T.Vector3(sc, -sc, sc)).multiply(new T.Matrix4().makeRotationAxis(new T.Vector3(1, 0, 0), Math.PI / 2));
    if (chunk) chunk.scene.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
    chunk = { scene: scene, matrix: matrix };
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
    if (m && m.style && !m.style._loaded) return; // 換地圖樣式到一半：這時加圖層會丟例外，等樣式載完(style.load)再重加
    if (!m || !window.THREE || !window.RoadShape) return;
    if (m.getZoom() < MIN_ZOOM) { if (chunk) m.triggerRepaint(); return; }
    if (!mats) makeMats();
    if (!m.getLayer(LAYER)) m.addLayer(customLayer, beforeId(m));
    // 畫面還在上次建好的範圍裡(而且縮放差不多)就不用重建
    var b = m.getBounds();
    // 畫面還在上次建好的範圍裡(而且縮放差不多)：不重建；道路資料又載入了新的(dirty)也最多每 5 秒才重建一次(導航中一直在載，每次都建會卡)
    var inside = builtFor && b.getWest() >= builtFor.box.w && b.getEast() <= builtFor.box.e && b.getSouth() >= builtFor.box.s && b.getNorth() <= builtFor.box.n && Math.abs(m.getZoom() - builtFor.zoom) < 1.5;
    if (inside && !(dirty && Date.now() - builtFor.at > 5000)) return;
    if (job) return;   // 正在建
    build();
  }
  // 有新資料(dirty)：5 秒後一定再檢查一次(地圖沒在動也會重建)；已經排了就不重排
  var laterTimer = null;
  function later() { if (laterTimer) return; laterTimer = setTimeout(function () { laterTimer = null; check(); }, 5200); }
  function soon(force) { if (force) builtFor = null; clearTimeout(timer); timer = setTimeout(check, 300); }
  window._snmRoad3dCityState = function () { var mv = []; if (chunk) chunk.scene.traverse(function (o) { if (o.isMesh) mv.push(o.geometry.attributes.position.count); }); return { chunk: !!chunk, meshes: mv, job: job && { i: job.i, n: job.roads.length, keys: job.keys }, builtFor: builtFor, lanes: Object.keys(laneTiles).length, laneIdxState: laneIdxState }; };   // 除錯用
  window._snmReloadRoad3dCity = function () { renderer = null; chunk = null; builtFor = null; job = null; soon(true); };   // 換地圖樣式後重加
  function init() {
    var m = window.map;
    if (!m) { setTimeout(init, 500); return; }
    var go = function () {
      m.on('moveend', function () { soon(); });
      var lastMove = 0;   // 導航時鏡頭一直在動：移動中也每 1 秒檢查(離開上次建好的範圍才重建)
      m.on('move', function () { var now = Date.now(); if (now - lastMove > 1000) { lastMove = now; check(); } });
      m.on('sourcedata', function (e) { if (e.isSourceLoaded && (e.sourceId === 'openmaptiles' || e.sourceId === 'snm-roads') && m.getZoom() >= MIN_ZOOM) { dirty = true; if (!builtFor) soon(); else later(); } });   // 道路資料載完：記下來，之後再建(不要每載一塊就重建)
      soon(true);
    };
    if (m.loaded()) go(); else m.once('load', go);
    window.addEventListener('snm-road3d-data', function () { dirty = true; later(); });   // 國道 3D 載入新的：記下來，之後再重建(跨過國道的路重新抬高；不要每載一塊就重建)
  }
  init();
})();
