// ===== 🛣 國道、快速道路 3D 路面(第 2 版引擎) =====
// 放大到 zoom 16 以上，把國道、快速道路與匝道畫成立體道路。所有幾何都在電腦上事先算好(tools/build-road3d.js、tools/road3d2/)：
// 等弧長取點、朝天法向量、最小轉彎半徑、高架 6 公尺＋淨空 4.5 公尺、共用走廊中心線的中央分隔島、重疊路面裁切。
// 這裡只負責畫：
//   路面：一整片網格，標線(黃線、白實線、車道白虛線 4 公尺畫 6 公尺空、線寬 10 公分)、路況綠線、導航路線、塞車顏色、
//         槽化線全部用 Shader 直接「塗」在路面上(同一片表面不會自己打架，轉彎也不會碎)
//   立體物件：外側鋼板護欄(橋上混凝土)、中央分隔(窄：一道護欄＋防眩板；寬：兩道護欄＋灌木)、橋面版、橋墩
//   導航路線、塞車顏色：對到 3D 路面上(OSRM 路線用 OSM 節點 id 對，高架、平面並排也不會畫錯層；沒有節點的用位置＋方向)，
//         已經畫在 3D 路面上的那一段，平面的線就不畫(不會重複、不會在高架下面錯位)
//   車子：在高架上時，把原本的車子(導航車子1.png)、頭像、車牌往上抬到橋面高度
//   高度查詢 window._snmRoad3dHeightAt：電子看板門架、一般道路(跨過國道的陸橋)用
// 資料：road3d/13/x_y.json(zoom 13 圖磚)，只抓畫面附近那幾塊。
(function () {
  'use strict';
  var MIN_ZOOM = 16, TILE_Z = 13, MAX_CHUNKS = 16;
  var THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  var LAYER = 'snm-road-3d';
  var DATA_DIR = 'road3d/';
  var index = null, indexState = 'none';
  var tiles = {};            // 'x/y' → { state, data, chunk, usedAt }
  var renderer = null, camera = null, threeState = 'none', mats = null, deckMat = null;
  var queue = [], busy = 0;
  var routeIv = {}, trafficIv = {};   // 路 id → 區間 [[s0, s1, (r, g, b)], ...]
  var trafficOnDeck = [];             // 對到 3D 路面的塞車路段 id(平面那條就不畫)

  // ── 圖磚 ──
  function lon2x(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
  function lat2y(lat, z) { var r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z)); }
  function visibleTiles() {
    var m = window.map, c = m.getCenter(), out = [];
    // 以畫面中心附近為主(傾斜看到地平線時，畫面範圍會大到抓不完)
    var b = m.getBounds(), x0 = lon2x(b.getWest(), TILE_Z), x1 = lon2x(b.getEast(), TILE_Z), y0 = lat2y(b.getNorth(), TILE_Z), y1 = lat2y(b.getSouth(), TILE_Z);
    var cx = lon2x(c.lng, TILE_Z), cy = lat2y(c.lat, TILE_Z);
    x0 = Math.max(x0, cx - 1); x1 = Math.min(x1, cx + 1); y0 = Math.max(y0, cy - 1); y1 = Math.min(y1, cy + 1);
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
    if (index && !index[f]) return Promise.resolve(null);
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
            t.data = j && j.f === 3 ? decode(j) : null; t.state = 'ready';
          }).catch(function (e) { console.warn('[road3d]', key, e); t.state = 'failed'; t.retryAt = Date.now() + 60000; }).then(function () {
            busy--;
            if (t.data && threeState === 'ready') { t.chunk = buildChunk(t.data); t.usedAt = Date.now(); }
            if (t.data) { refreshOverlays(); if (window._snmOnRoad3dData) window._snmOnRoad3dData(); }
            if (window.map) window.map.triggerRepaint();
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
  function b64(str, Arr) {
    var bin = atob(str), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Arr(u8.buffer);
  }
  function decode(j) {
    var mc = maplibregl.MercatorCoordinate.fromLngLat(j.o, 0), sc = mc.meterInMercatorCoordinateUnits();
    var gid = j.ch.map(function (c) { return c[0]; }), isLink = j.ch.map(function (c) { return !!c[1]; }), oneway = j.ch.map(function (c) { return !!c[2]; });
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    // 護欄路段(也拿來查每條路的車道外緣 a、b)
    var pieces = j.p.map(function (p) {
      var v = undelta(p.v, 3), n = v.length / 3, P = [], R = [];
      for (var k = 0; k < n; k++) {
        P.push([v[k * 3] / 100, v[k * 3 + 1] / 100, v[k * 3 + 2] / 100]);
        R.push([p.n[k * 2] / 10000, p.n[k * 2 + 1] / 10000]);
        if (P[k][0] < minX) minX = P[k][0]; if (P[k][0] > maxX) maxX = P[k][0]; if (P[k][1] < minY) minY = P[k][1]; if (P[k][1] > maxY) maxY = P[k][1];
      }
      return { gid: gid[p.c], link: isLink[p.c], oneway: oneway[p.c], P: P, R: R, n: n, i0: p.pre, i1: n - 1 - p.post,
        S: undelta(p.s, 1).map(function (x) { return x / 100; }), eL: perV(p.e[0], n), eR: perV(p.e[1], n), a: perV(p.e[2], n), b: perV(p.e[3], n),
        items: p.R.map(function (r) { return { t: r.t, sd: r.sd, o: perV(r.o, n), o2: r.o2 != null ? perV(r.o2, n) : null, v: r.v.map(function (x) { return x / 100; }) }; }) };
    });
    // 每條路沿路距離 → 車道外緣 a、b
    var byGid = {};
    pieces.forEach(function (pc) { (byGid[pc.gid] = byGid[pc.gid] || []).push(pc); });
    var laneAt = function (g, S) {
      var list = byGid[g], best = null, bd = Infinity;
      if (!list) return [0, 0];
      for (var q = 0; q < list.length; q++) {
        var pc = list[q], Ss = pc.S, last = Ss.length - 1;
        if (S >= Ss[0] && S <= Ss[last]) {
          var k = 0; while (k < last - 1 && Ss[k + 1] < S) k++;
          var t = (S - Ss[k]) / ((Ss[k + 1] - Ss[k]) || 1);
          return [pc.a[k] + (pc.a[k + 1] - pc.a[k]) * t, pc.b[k] + (pc.b[k + 1] - pc.b[k]) * t];
        }
        var d0 = Math.abs(S - Ss[0]), d1 = Math.abs(S - Ss[last]);
        if (d0 < bd) { bd = d0; best = [pc.a[0], pc.b[0]]; }
        if (d1 < bd) { bd = d1; best = [pc.a[last], pc.b[last]]; }
      }
      return best || [0, 0];
    };
    // 路面網格(二進位)
    var D = j.d, nv = D.n;
    var X = b64(D.x, Int32Array), Y = b64(D.y, Int32Array), Zs = b64(D.z, Int16Array), U = b64(D.u, Int16Array), SS = b64(D.s, Int32Array), C = b64(D.c, Int16Array);
    var idx = b64(D.i, D.it === 32 ? Uint32Array : Uint16Array);
    var pos = new Float32Array(nv * 3), vChain = new Int32Array(nv), vS = new Float32Array(nv), base = {};
    for (var i = 0; i < nv; i++) {
      var x = X[i] / 100, y = Y[i] / 100;
      pos[i * 3] = x; pos[i * 3 + 1] = Zs[i] / 100; pos[i * 3 + 2] = y;   // three.js：x 東、y 上、z 南
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      vChain[i] = gid[C[i]]; vS[i] = SS[i] / 10;
      if (base[C[i]] === undefined || vS[i] < base[C[i]]) base[C[i]] = vS[i];
    }
    // 虛線用的沿路距離：每條路在這塊圖磚的最小值往下取 10 的倍數當起點(浮點數不會失真，虛線還是接得上)
    var uv = new Float32Array(nv * 2), lane = new Float32Array(nv * 2), flags = new Float32Array(nv), gore = new Float32Array(nv * 3);
    for (i = 0; i < nv; i++) {
      var c = C[i];
      uv[i * 2] = U[i] / 100; uv[i * 2 + 1] = vS[i] - Math.floor(base[c] / 10) * 10;
      var ab = laneAt(gid[c], vS[i]); lane[i * 2] = ab[0]; lane[i * 2 + 1] = ab[1];
      flags[i] = (isLink[c] ? 1 : 0) | (oneway[c] ? 0 : 2);
    }
    (D.g || []).forEach(function (q) { gore[q[0] * 3] = q[1] / 100; gore[q[0] * 3 + 1] = q[2] / 100; gore[q[0] * 3 + 2] = q[3] / 100; });
    var corner = function (x, y) { return new maplibregl.MercatorCoordinate(mc.x + x * sc, mc.y + y * sc, 0).toLngLat(); };
    var nw = corner(minX - 50, minY - 50), se = corner(maxX + 50, maxY + 50);
    return { o: j.o, mc: mc, sc: sc, pos: pos, idx: idx, uv: uv, lane: lane, flags: flags, gore: gore, vChain: vChain, vS: vS, nv: nv,
      pieces: pieces, piers: j.q || [], nodes: (j.nd || []).map(function (q) { return [q[0], gid[q[1]], q[2] / 10]; }),
      box: { w: nw.lng, n: nw.lat, e: se.lng, s: se.lat } };
  }

  // ── 路面 Shader：標線、綠線、導航、塞車、槽化線都塗在同一片 ──
  var DECK_VS = [
    'attribute vec2 aUV; attribute vec2 aLane; attribute float aFlags; attribute vec3 aGore; attribute float aRoute; attribute vec4 aTraffic;',
    'varying vec2 vUV; varying vec2 vLane; varying float vFlags; varying vec3 vGore; varying float vRoute; varying vec4 vTraffic; varying vec3 vN; varying vec3 vW;',
    'void main() {',
    '  vUV = aUV; vLane = aLane; vFlags = aFlags; vGore = aGore; vRoute = aRoute; vTraffic = aTraffic; vN = normal; vW = position;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
    '}'].join('\n');
  var DECK_FS = [
    'uniform float uGreen; uniform vec3 uLight;',
    'varying vec2 vUV; varying vec2 vLane; varying float vFlags; varying vec3 vGore; varying float vRoute; varying vec4 vTraffic; varying vec3 vN; varying vec3 vW;',
    // 寬 2hw 的一條線(以 c 為中心)，邊緣用螢幕像素寬度反鋸齒
    'float band(float x, float c, float hw) { float w = max(fwidth(x), 0.001) * 0.8; return 1.0 - smoothstep(hw - w, hw + w, abs(x - c)); }',
    'void main() {',
    '  vec3 col = vec3(0.290, 0.302, 0.322);',
    '  float u = vUV.x, v = vUV.y, a = vLane.x, b = vLane.y;',
    '  bool twoWay = mod(floor(vFlags / 2.0), 2.0) > 0.5;',
    '  vec3 white = vec3(0.955), yellow = vec3(0.949, 0.745, 0.102);',
    '  float dashOn = 1.0 - smoothstep(4.0 - fwidth(v), 4.0 + fwidth(v), mod(v, 10.0));',   // 4 公尺畫、6 公尺空
    '  if (!twoWay) {',
    '    col = mix(col, yellow, band(u, a + 0.075, 0.075));',                          // 內側黃實線
    '    col = mix(col, white, band(u, b - 0.075, 0.075));',                           // 外側白實線
    '    float k = floor((u - a) / 3.75 + 0.5), lc = a + k * 3.75;',
    '    if (k >= 1.0 && lc < b - 1.0) col = mix(col, white, band(u, lc, 0.05) * dashOn);',   // 車道線
    '  } else {',
    '    col = mix(col, yellow, band(u, 0.12, 0.06)); col = mix(col, yellow, band(u, -0.12, 0.06));',   // 中央雙黃線
    '    col = mix(col, white, band(u, a + 0.075, 0.075)); col = mix(col, white, band(u, b - 0.075, 0.075));',
    '    float k2 = floor(abs(u) / 3.75 + 0.5);',
    '    if (k2 >= 1.0 && k2 * 3.75 < b - 1.0) col = mix(col, white, band(abs(u), k2 * 3.75, 0.05) * dashOn);',
    '  }',
    // 槽化區：主線座標 gu 落在 g0～g1 之間 → 白色斜紋(世界座標，跨主線、匝道兩片路面也接得起來)＋匝道那側外框
    '  float g0 = min(vGore.y, vGore.z), g1 = max(vGore.y, vGore.z);',
    '  if (g1 - g0 > 0.15) {',
    '    float inG = step(g0, vGore.x) * step(vGore.x, g1);',
    '    float sx = (vW.x + vW.z) * 0.7071, sp = mod(sx, 4.0), sw = max(fwidth(sx), 0.001);',
    '    float stripe = 1.0 - smoothstep(0.3 - sw, 0.3 + sw, sp);',
    '    float edge = band(vGore.x, vGore.z, 0.075);',
    '    col = mix(col, white, max(inG * stripe, edge));',
    '  }',
    // 路況綠線(沒塞車)／塞車顏色／導航路線：畫在車道中間
    '  if (!twoWay) {',
    '    float c = (a + b) * 0.5;',
    '    if (vRoute > 0.5) {',   // 導航路線：比較寬；那段塞車就用塞車顏色(跟平面導航路線一樣)
    '      vec3 rc = vTraffic.a > 0.5 ? vTraffic.rgb : vec3(0.086, 0.878, 0.596), rk = vTraffic.a > 0.5 ? vTraffic.rgb * 0.75 : vec3(0.0, 0.608, 0.396);',
    '      col = mix(col, rk, band(u, c, 1.6)); col = mix(col, rc, band(u, c, 1.25));',
    '      float dd = abs(u - c), vv = mod(v, 20.0);',   // 路線箭頭：每 20 公尺一個 ^ 形，尖端朝行車方向
    '      col = mix(col, vec3(1.0), band(vv, 6.0 - dd * 0.9, 0.22) * (1.0 - smoothstep(0.75, 0.85, dd)));',
    '    }',
    '    else if (vTraffic.a > 0.5) { col = mix(col, vTraffic.rgb * 0.75, band(u, c, 0.95)); col = mix(col, vTraffic.rgb, band(u, c, 0.7)); }',
    '    else if (uGreen > 0.5) { col = mix(col, vec3(0.0, 0.608, 0.396), band(u, c, 0.95)); col = mix(col, vec3(0.086, 0.878, 0.596), band(u, c, 0.7)); }',
    '  }',
    '  float l = 0.62 + 0.6 * max(dot(normalize(vN), uLight), 0.0);',
    '  gl_FragColor = vec4(col * min(l, 1.15), 1.0);',
    '}'].join('\n');

  // ── 立體物件(護欄、分隔島、橋面版、橋墩) ──
  function Bucket() { this.p = []; }
  Bucket.prototype.tri = function (a, b, c) { this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); };
  Bucket.prototype.quad = function (a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); };
  var WBEAM = [[0, 0.45], [0.06, 0.53], [0, 0.6], [0.06, 0.68], [0, 0.76]];
  var JERSEY = [[0, 0], [0.05, 0.08], [0.18, 0.33], [0.24, 0.85], [0.42, 0.85], [0.48, 0.33], [0.61, 0.08], [0.66, 0]];
  var PARAPET = [[0, 0], [0.04, 0.95], [0.3, 0.95], [0.3, 0]];

  function buildPiece(pc, B) {
    var P = pc.P, S = pc.S, R = pc.R;
    var lerp = function (a, b, t) { return a + (b - a) * t; };
    // 第 k 段、比例 t、橫向偏移 off(數列)、往上 dy → three.js(x 東、y 上、z 南)；法向量是資料裡存的(前後圖磚接縫完全一樣)
    var at = function (k, t, off, dy) {
      var o = lerp(off[k], off[k + 1], t), rx = lerp(R[k][0], R[k + 1][0], t), ry = lerp(R[k][1], R[k + 1][1], t);
      return [lerp(P[k][0], P[k + 1][0], t) + rx * o, lerp(P[k][2], P[k + 1][2], t) + dy, lerp(P[k][1], P[k + 1][1], t) + ry * o];
    };
    var shiftArr = function (arr, d) { return arr.map(function (x) { return x + d; }); };
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
    pc.items.forEach(function (r) {
      if (r.t === 'slab') {   // 橋面版：兩側 0.8 公尺厚＋底面
        spans(r.v, function (k, t0, t1) {
          [r.o, r.o2].forEach(function (e) { B.concrete.quad(at(k, t0, e, 0.02), at(k, t1, e, 0.02), at(k, t1, e, -0.8), at(k, t0, e, -0.8)); });
          B.under.quad(at(k, t0, r.o, -0.8), at(k, t0, r.o2, -0.8), at(k, t1, r.o2, -0.8), at(k, t1, r.o, -0.8));
        });
        return;
      }
      if (r.t === 'hg') {   // 分隔島灌木：高高低低一叢一叢
        var bush = function (s) { return 0.95 + 0.18 * Math.sin(s * 1.7) + 0.1 * Math.sin(s * 4.3 + 1); };
        spans(r.v, function (k, t0, t1, u0, u1) {
          var len = S[k + 1] - S[k], m = Math.max(1, Math.ceil((u1 - u0) / 2));
          for (var j = 0; j < m; j++) {
            var a = t0 + (t1 - t0) * j / m, b = t0 + (t1 - t0) * (j + 1) / m, ha = bush(S[k] + a * len), hb = bush(S[k] + b * len);
            B.hedge.quad(at(k, a, r.o, ha), at(k, a, r.o2, ha), at(k, b, r.o2, hb), at(k, b, r.o, hb));
            B.hedge.quad(at(k, a, r.o, 0), at(k, b, r.o, 0), at(k, b, r.o, hb), at(k, a, r.o, ha));
            B.hedge.quad(at(k, a, r.o2, 0), at(k, b, r.o2, 0), at(k, b, r.o2, hb), at(k, a, r.o2, ha));
          }
        });
        return;
      }
      if (r.t === 'ag') {   // 防眩板：每 1 公尺一片，斜 60 度
        spans(r.v, function (k, t0, t1, u0, u1) {
          var len = S[k + 1] - S[k], dx = P[k + 1][0] - P[k][0], dz = P[k + 1][1] - P[k][1], dl = Math.hypot(dx, dz) || 1;
          var f = [dx / dl, dz / dl], g = [-dz / dl, dx / dl], c60 = 0.5, s60 = 0.866;
          var w = [f[0] * c60 + g[0] * s60, f[1] * c60 + g[1] * s60], th = [-w[1], w[0]];
          for (var st = Math.ceil(u0); st < u1; st += 1) {
            var c = at(k, (st - S[k]) / len, r.o, 0), y0 = c[1] + 0.85, y1 = c[1] + 1.5;
            var cs = [[-0.11, -0.015], [0.11, -0.015], [0.11, 0.015], [-0.11, 0.015]].map(function (q) { return [c[0] + w[0] * q[0] + th[0] * q[1], c[2] + w[1] * q[0] + th[1] * q[1]]; });
            for (var e = 0; e < 4; e++) { var A2 = cs[e], C2 = cs[(e + 1) % 4]; B.glare.quad([A2[0], y0, A2[1]], [C2[0], y0, C2[1]], [C2[0], y1, C2[1]], [A2[0], y1, A2[1]]); }
            B.glare.quad([cs[0][0], y1, cs[0][1]], [cs[1][0], y1, cs[1][1]], [cs[2][0], y1, cs[2][1]], [cs[3][0], y1, cs[3][1]]);
          }
        });
        return;
      }
      var prof = r.t === 'nj' ? JERSEY : r.t === 'pp' ? PARAPET : WBEAM, bk = r.t === 'wb' ? B.steel : B.concrete;
      var offs = prof.map(function (q) { return shiftArr(r.o, r.sd * q[0]); });
      spans(r.v, function (k, t0, t1, u0, u1) {
        for (var j = 0; j < prof.length - 1; j++) {
          bk.quad(at(k, t0, offs[j], prof[j][1]), at(k, t0, offs[j + 1], prof[j + 1][1]), at(k, t1, offs[j + 1], prof[j + 1][1]), at(k, t1, offs[j], prof[j][1]));
        }
        if (r.t !== 'wb') return;
        var len = S[k + 1] - S[k], po = shiftArr(r.o, r.sd * 0.12);
        for (var st = Math.ceil(u0 / 4) * 4; st < u1; st += 4) {   // 立柱每 4 公尺
          var c = at(k, (st - S[k]) / len, po, 0), dx = P[k + 1][0] - P[k][0], dz = P[k + 1][1] - P[k][1], dl = Math.hypot(dx, dz) || 1;
          var f = [dx / dl * 0.07, dz / dl * 0.07], g = [-dz / dl * 0.07, dx / dl * 0.07], top = c[1] + 0.78;
          var cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function (q) { return [c[0] + f[0] * q[0] + g[0] * q[1], c[2] + f[1] * q[0] + g[1] * q[1]]; });
          for (var e = 0; e < 4; e++) { var A2 = cs[e], C2 = cs[(e + 1) % 4]; B.steel.quad([A2[0], c[1], A2[1]], [C2[0], c[1], C2[1]], [C2[0], top, C2[1]], [A2[0], top, A2[1]]); }
          B.steel.quad([cs[0][0], top, cs[0][1]], [cs[1][0], top, cs[1][1]], [cs[2][0], top, cs[2][1]], [cs[3][0], top, cs[3][1]]);
        }
      });
    });
  }
  // 橋墩：[x, y, 頂高, 寬, 切線 x, 切線 y](公分、× 10000)
  function buildPier(q, B) {
    var x = q[0] / 100, y = q[1] / 100, top = q[2] / 100, w = q[3] / 200, tx = q[4] / 10000, ty = q[5] / 10000, d = 0.7;
    var nx = -ty, ny = tx;   // 橫向
    var cs = [[-w, -d], [w, -d], [w, d], [-w, d]].map(function (c) { return [x + nx * c[0] + tx * c[1], y + ny * c[0] + ty * c[1]]; });
    for (var e = 0; e < 4; e++) { var A = cs[e], C = cs[(e + 1) % 4]; B.concrete.quad([A[0], 0, A[1]], [C[0], 0, C[1]], [C[0], top, C[1]], [A[0], top, A[1]]); }
  }

  function buildChunk(d) {
    var T = window.THREE;
    var scene = new T.Scene();
    scene.add(new T.AmbientLight(0xffffff, 0.62));
    var sun = new T.DirectionalLight(0xffffff, 0.6); sun.position.set(0.4, 1, 0.6); scene.add(sun);
    var fill = new T.DirectionalLight(0xffffff, 0.22); fill.position.set(-0.6, 0.4, -0.5); scene.add(fill);
    // 路面
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(d.pos, 3));
    g.setAttribute('aUV', new T.BufferAttribute(d.uv, 2));
    g.setAttribute('aLane', new T.BufferAttribute(d.lane, 2));
    g.setAttribute('aFlags', new T.BufferAttribute(d.flags, 1));
    g.setAttribute('aGore', new T.BufferAttribute(d.gore, 3));
    var route = new T.BufferAttribute(new Float32Array(d.nv), 1), traffic = new T.BufferAttribute(new Float32Array(d.nv * 4), 4);
    route.setUsage(T.DynamicDrawUsage); traffic.setUsage(T.DynamicDrawUsage);
    g.setAttribute('aRoute', route); g.setAttribute('aTraffic', traffic);
    g.setIndex(new T.BufferAttribute(d.idx, 1));
    g.computeVertexNormals();
    var deck = new T.Mesh(g, deckMat);
    deck.frustumCulled = false;   // 不讓 three.js 自己判斷在不在畫面裡(疊在地圖上會誤判)
    scene.add(deck);
    // 立體物件
    var B = { concrete: new Bucket(), under: new Bucket(), steel: new Bucket(), hedge: new Bucket(), glare: new Bucket() };
    d.pieces.forEach(function (pc) { if (pc.i1 > pc.i0) buildPiece(pc, B); });
    d.piers.forEach(function (q) { buildPier(q, B); });
    Object.keys(B).forEach(function (k) {
      if (!B[k].p.length) return;
      var gg = new T.BufferGeometry();
      gg.setAttribute('position', new T.Float32BufferAttribute(B[k].p, 3));
      gg.computeVertexNormals();
      var mesh = new T.Mesh(gg, mats[k]);
      mesh.frustumCulled = false;
      scene.add(mesh);
    });
    var matrix = new T.Matrix4().makeTranslation(d.mc.x, d.mc.y, d.mc.z).scale(new T.Vector3(d.sc, -d.sc, d.sc))
      .multiply(new T.Matrix4().makeRotationAxis(new T.Vector3(1, 0, 0), Math.PI / 2));
    var chunk = { scene: scene, matrix: matrix, box: d.box, route: route, traffic: traffic };
    applyOverlays(d, chunk);
    return chunk;
  }
  function disposeChunk(c) { if (c) c.scene.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); }
  function makeMats() {
    var T = window.THREE, ds = T.DoubleSide;
    mats = {
      concrete: new T.MeshLambertMaterial({ color: 0xCFCCC4, side: ds }),
      under: new T.MeshLambertMaterial({ color: 0x8F8C86, side: T.BackSide }),   // 橋面版底面(陰影處)：只有從下面看得到，從上面永遠不會露出來
      steel: new T.MeshPhongMaterial({ color: 0xC4CACF, specular: 0x8A8F94, shininess: 60, side: ds }),
      hedge: new T.MeshLambertMaterial({ color: 0x6E9F2E, side: ds }),
      glare: new T.MeshLambertMaterial({ color: 0x3F8A55, side: ds }),
    };
    deckMat = new T.ShaderMaterial({
      vertexShader: DECK_VS, fragmentShader: DECK_FS, side: T.DoubleSide,
      uniforms: { uGreen: { value: 1 }, uLight: { value: new T.Vector3(0.4, 1, 0.6).normalize() } },
      extensions: { derivatives: true },
    });
  }

  // ── 導航路線、塞車顏色對到 3D 路面 ──
  // 某點(地面公尺座標，用某塊圖磚的局部座標)：附近的路面段 [{ gid, S, z, dir, lat, eL, eR }]
  function decksNear(d, x, y, radius) {
    var out = [];
    d.pieces.forEach(function (pc) {
      for (var k = pc.i0; k < pc.i1; k++) {
        var A = pc.P[k], B2 = pc.P[k + 1];
        if (Math.min(Math.abs(A[0] - x), Math.abs(B2[0] - x)) > radius + 60 || Math.min(Math.abs(A[1] - y), Math.abs(B2[1] - y)) > radius + 60) continue;
        var dx = B2[0] - A[0], dy = B2[1] - A[1], L2 = dx * dx + dy * dy;
        if (!L2) continue;
        var t = Math.max(0, Math.min(1, ((x - A[0]) * dx + (y - A[1]) * dy) / L2)), px = A[0] + dx * t, py = A[1] + dy * t;
        var L = Math.sqrt(L2), lat = ((x - px) * -dy + (y - py) * dx) / L;   // 右正(y 往南)
        var eL = pc.eL[k] + (pc.eL[k + 1] - pc.eL[k]) * t, eR = pc.eR[k] + (pc.eR[k + 1] - pc.eR[k]) * t;
        if (lat < eL - radius || lat > eR + radius || Math.hypot(x - px, y - py) > Math.max(-eL, eR) + radius + 1) continue;
        out.push({ gid: pc.gid, S: pc.S[k] + (pc.S[k + 1] - pc.S[k]) * t, z: A[2] + (B2[2] - A[2]) * t, dir: [dx / L, dy / L], lat: lat, eL: eL, eR: eR, oneway: pc.oneway });
      }
    });
    return out;
  }
  function toLocal(d, lng, lat) { var M = maplibregl.MercatorCoordinate.fromLngLat([lng, lat], 0); return [(M.x - d.mc.x) / d.sc, (M.y - d.mc.y) / d.sc]; }
  function loadedData() { return Object.keys(tiles).map(function (k) { return tiles[k].data; }).filter(Boolean); }
  // 一串經緯度沿線每 4 公尺取樣，對到路面(方向差 35 度內、在路面範圍內；接續上一點的那條路優先)
  // 回傳 { iv: { gid: [[s0, s1], ...] }, onDeck: [每段原始線段有沒有對到] }
  function matchLine(coords, prefer) {
    var ds = loadedData(), iv = {}, onDeck = [], prev = null, cur = null;
    if (!ds.length || coords.length < 2) return { iv: iv, onDeck: onDeck };
    for (var i = 0; i < coords.length - 1; i++) {
      var a = coords[i], b = coords[i + 1];
      var segLen = Math.hypot((b[0] - a[0]) * 101000, (b[1] - a[1]) * 110540), m = Math.max(1, Math.ceil(segLen / 4)), hit = 0;
      for (var j = 0; j < m; j++) {
        var t = (j + 0.5) / m, lng = a[0] + (b[0] - a[0]) * t, lt = a[1] + (b[1] - a[1]) * t;
        var best = null;
        ds.forEach(function (d) {
          var L = toLocal(d, lng, lt), La = toLocal(d, a[0], a[1]), Lb = toLocal(d, b[0], b[1]);
          var hx = Lb[0] - La[0], hy = Lb[1] - La[1], hl = Math.hypot(hx, hy) || 1;
          if (Math.abs(L[0]) > 4000 || Math.abs(L[1]) > 4000) return;
          decksNear(d, L[0], L[1], 0.5).forEach(function (c) {
            if (c.dir[0] * hx / hl + c.dir[1] * hy / hl < 0.82) return;   // 方向差 35 度內
            var score = Math.abs(c.lat - (c.eL + c.eR) / 2) - (prev && c.gid === prev.gid ? 6 : 0) - (prefer && prefer(c) ? 20 : 0);
            if (!best || score < best.score) best = { gid: c.gid, S: c.S, score: score };
          });
        });
        if (best) {
          hit++;
          if (cur && cur.gid === best.gid && Math.abs(best.S - cur.s1) < 12) cur.s1 = best.S;
          else { cur = { gid: best.gid, s0: best.S, s1: best.S }; (iv[best.gid] = iv[best.gid] || []).push(cur); }
          prev = best;
        } else cur = null;
      }
      onDeck.push(hit >= m * 0.6);
    }
    Object.keys(iv).forEach(function (g) { iv[g] = iv[g].map(function (c) { return [Math.min(c.s0, c.s1) - 3, Math.max(c.s0, c.s1) + 3]; }); });
    return { iv: iv, onDeck: onDeck };
  }
  // 導航路線：OSRM 的 OSM 節點 id 連續兩個都在同一條路上 → 那段沿路距離整段都是路線
  function routeByNodes(nodes) {
    var where = {};
    loadedData().forEach(function (d) { d.nodes.forEach(function (q) { (where[q[0]] = where[q[0]] || []).push([q[1], q[2]]); }); });
    var iv = {};
    for (var i = 0; i < nodes.length - 1; i++) {
      var A = where[nodes[i]], B2 = where[nodes[i + 1]];
      if (!A || !B2) continue;
      A.forEach(function (a) { B2.forEach(function (b) {
        if (a[0] !== b[0] || Math.abs(a[1] - b[1]) > 3000) return;
        (iv[a[0]] = iv[a[0]] || []).push([Math.min(a[1], b[1]), Math.max(a[1], b[1])]);
      }); });
    }
    return iv;
  }
  var OFF_SRC = 'snm-route-offdeck';
  function refreshOverlays() {
    var m = window.map;
    if (!m) return;
    // 導航路線
    var geom = window._navRouteGeometry, coords = geom && geom.coordinates || [];
    routeIv = {};
    var onDeck = [];
    if (coords.length > 1 && loadedData().length) {
      var byNodes = window._navRouteNodes ? routeByNodes(window._navRouteNodes) : null;
      var res = matchLine(coords, byNodes ? function (c) { var l = byNodes[c.gid]; return l && l.some(function (r) { return c.S >= r[0] - 5 && c.S <= r[1] + 5; }); } : null);
      routeIv = byNodes && Object.keys(byNodes).length ? byNodes : res.iv;
      onDeck = res.onDeck;
    }
    // 平面的導航路線只畫沒對到 3D 路面的部分：照主程式的路線資料(導航中會分段帶塞車顏色)切掉在 3D 路面上的那幾段
    var rs = m.getSource('navRoute'), rd = rs && rs._data, feats = [];
    ((rd && rd.features) || []).forEach(function (f) {
      if (!f.geometry || f.geometry.type !== 'LineString') return;
      var c = f.geometry.coordinates, od = loadedData().length ? matchLine(c).onDeck : [], seg = null;
      for (var i = 0; i < c.length - 1; i++) {
        if (od[i]) { seg = null; continue; }
        if (!seg) { seg = [c[i]]; feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: seg }, properties: f.properties || {} }); }
        seg.push(c[i + 1]);
      }
    });
    if (m.getSource(OFF_SRC)) m.getSource(OFF_SRC).setData({ type: 'FeatureCollection', features: feats });
    // 塞車
    trafficIv = {}; trafficOnDeck = [];
    var ts = m.getSource('snm-traffic-src'), td = ts && ts._data;
    if (td && td.features && loadedData().length) {
      td.features.forEach(function (f) {
        if (!f.geometry || f.geometry.type !== 'LineString' || !f.properties || !f.properties.color) return;
        var r = matchLine(f.geometry.coordinates), any = false;
        var rgb = hexRGB(f.properties.color);
        Object.keys(r.iv).forEach(function (g) { r.iv[g].forEach(function (x) { (trafficIv[g] = trafficIv[g] || []).push([x[0], x[1], rgb]); any = true; }); });
        if (any && r.onDeck.every(Boolean) && f.properties.segmentId) trafficOnDeck.push(f.properties.segmentId);
      });
    }
    Object.keys(tiles).forEach(function (k) { var t = tiles[k]; if (t.chunk && t.data) applyOverlays(t.data, t.chunk); });
    hide2D();
    m.triggerRepaint();
  }
  function hexRGB(h) { var n = parseInt(String(h).replace('#', ''), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
  function applyOverlays(d, chunk) {
    var r = chunk.route.array, t = chunk.traffic.array;
    for (var i = 0; i < d.nv; i++) {
      var g = d.vChain[i], S = d.vS[i], rl = routeIv[g], tl = trafficIv[g];
      var on = 0;
      if (rl) for (var a = 0; a < rl.length; a++) if (S >= rl[a][0] && S <= rl[a][1]) { on = 1; break; }
      r[i] = on;
      t[i * 4 + 3] = 0;
      if (tl) for (var b = 0; b < tl.length; b++) if (S >= tl[b][0] && S <= tl[b][1]) { t[i * 4] = tl[b][2][0]; t[i * 4 + 1] = tl[b][2][1]; t[i * 4 + 2] = tl[b][2][2]; t[i * 4 + 3] = 1; break; }
    }
    chunk.route.needsUpdate = true; chunk.traffic.needsUpdate = true;
  }
  // 平面的導航路線、塞車線：3D 出現時，對到 3D 路面的部分不畫(改用 off-deck 那份)
  function hide2D() {
    var m = window.map;
    if (!m || !m.getLayer('navRoute-line')) return;
    if (!m.getSource(OFF_SRC)) {
      m.addSource(OFF_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      [['navRoute-outline', '-outline'], ['navRoute-line', '-line']].forEach(function (x) {
        m.addLayer({ id: OFF_SRC + x[1], type: 'line', source: OFF_SRC, minzoom: MIN_ZOOM,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': m.getPaintProperty(x[0], 'line-color'), 'line-width': m.getPaintProperty(x[0], 'line-width') } }, x[0]);
      });
      // 路線箭頭：3D 路面上的由 Shader 畫，這份只畫沒在 3D 路面上的
      if (m.getLayer('navRoute-arrows')) {
        var al = m.getStyle().layers.find(function (l) { return l.id === 'navRoute-arrows'; });
        m.addLayer({ id: OFF_SRC + '-arrows', type: 'symbol', source: OFF_SRC, minzoom: MIN_ZOOM, layout: al.layout, paint: al.paint || {} }, 'navRoute-arrows');
      }
      refreshOverlays();
      return;
    }
    // 平面 off-deck 那份的顏色跟著主程式的導航路線(導航中會換成分段塞車顏色)
    [['navRoute-outline', '-outline'], ['navRoute-line', '-line']].forEach(function (x) {
      var c = m.getPaintProperty(x[0], 'line-color');
      if (m.getLayer(OFF_SRC + x[1]) && JSON.stringify(m.getPaintProperty(OFF_SRC + x[1], 'line-color')) !== JSON.stringify(c)) m.setPaintProperty(OFF_SRC + x[1], 'line-color', c);
    });
    ['navRoute-outline', 'navRoute-line', 'navRoute-arrows'].forEach(function (id) {
      if (!m.getLayer(id)) return;
      var prop = id === 'navRoute-arrows' ? 'icon-opacity' : 'line-opacity', cur = m.getPaintProperty(id, prop);
      if (Array.isArray(cur) && cur[cur.length - 2] === MIN_ZOOM && cur[cur.length - 1] === 0) return;   // 已經設過
      // zoom 16 以下照原本，16 以上(3D 出現)不畫；原本就是隨縮放漸變的運算式(不能再包一層)，就在後面加兩個停點
      if (Array.isArray(cur) && cur[0] === 'interpolate' && Array.isArray(cur[2]) && cur[2][0] === 'zoom') m.setPaintProperty(id, prop, cur.concat([MIN_ZOOM - 0.01, cur[cur.length - 1], MIN_ZOOM, 0]));
      else m.setPaintProperty(id, prop, ['step', ['zoom'], cur == null ? 1 : cur, MIN_ZOOM, 0]);
    });
    var ids = trafficOnDeck.slice(0, 2000);
    ['snm-traffic-casing', 'snm-traffic-lines'].forEach(function (id) {
      if (!m.getLayer(id)) return;
      m.setPaintProperty(id, 'line-opacity', ['step', ['zoom'], 1, MIN_ZOOM, ['case', ['in', ['get', 'segmentId'], ['literal', ids]], 0, 1]]);
    });
  }

  // ── 高度查詢 ──
  // 某點(經緯度)、方向(度，可省略)附近的 3D 路面高度；prefZ = 偏好的高度(上一次的)，高架、平面重疊時選比較接近的
  window._snmRoad3dHeightAt = function (lng, lat, bearing, prefZ) {
    var best = null;
    loadedData().forEach(function (d) {
      var L = toLocal(d, lng, lat);
      if (Math.abs(L[0]) > 4000 || Math.abs(L[1]) > 4000) return;
      decksNear(d, L[0], L[1], 0.3).forEach(function (c) {
        if (bearing != null) {
          var b = (Math.atan2(c.dir[0], -c.dir[1]) * 180 / Math.PI + 360) % 360, diff = Math.abs(((b - bearing) % 360 + 540) % 360 - 180);
          if (c.oneway && diff > 45) return;
        }
        var score = prefZ != null ? Math.abs(c.z - prefZ) : -c.z;
        if (!best || score < best.score) best = { z: c.z, gid: c.gid, S: c.S, score: score };
      });
    });
    return best;
  };
  // 某個位置、行車方向上的國道主線：位置、方向、路寬、高度(電子看板門架用)
  window._snmRoad3dFit = function (lon, lat, bearing) {
    var best = null;
    loadedData().forEach(function (d) {
      var L = toLocal(d, lon, lat);
      if (Math.abs(L[0]) > 4000 || Math.abs(L[1]) > 4000) return;
      decksNear(d, L[0], L[1], 45).forEach(function (c) {
        var pcLink = false;
        var brg = (Math.atan2(c.dir[0], -c.dir[1]) * 180 / Math.PI + 360) % 360;
        if (!c.oneway || Math.abs(((brg - bearing) % 360 + 540) % 360 - 180) > 50) return;
        var dist = Math.abs(c.lat);
        if (dist > 45 || (best && dist >= best.d)) return;
        // 投影到中心線的位置
        var cx = L[0] - (-c.dir[1]) * c.lat, cy = L[1] - c.dir[0] * c.lat;
        var ll = new maplibregl.MercatorCoordinate(d.mc.x + cx * d.sc, d.mc.y + cy * d.sc, 0).toLngLat();
        best = { d: dist, lon: ll.lng, lat: ll.lat, bearing: brg, W: c.eR - c.eL, z: c.z, link: pcLink };
      });
    });
    return best;
  };

  // ── 車子：在高架上時往上抬到橋面高度(原本的車子圖示、頭像、車牌一起平移) ──
  var carZ = 0, carShift = [0, 0], carLayers = ['user-car', 'user-car-plate', 'user-car-avatar', 'user-compass'];
  function liftCar(matrix) {
    var m = window.map, pose = window._snmCarPose;
    var want = 0;
    if (pose && m.getZoom() >= MIN_ZOOM) {
      var h = window._snmRoad3dHeightAt(pose.lng, pose.lat, pose.bearing, carZ);
      want = h && h.z > 0.3 ? h.z : 0;
    }
    carZ += (want - carZ) * 0.2;
    if (Math.abs(want - carZ) < 0.01) carZ = want;
    var dx = 0, dy = 0;
    if (pose && carZ > 0.05) {
      var M = maplibregl.MercatorCoordinate.fromLngLat([pose.lng, pose.lat], 0), sc = M.meterInMercatorCoordinateUnits();
      var proj = function (z) {
        var x = M.x, y = M.y, w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
        return [(matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w, (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w];
      };
      var g = proj(0), u = proj(carZ * sc), cv = m.getCanvas(), wpx = cv.clientWidth, hpx = cv.clientHeight;
      dx = (u[0] - g[0]) * wpx / 2; dy = -(u[1] - g[1]) * hpx / 2;
    }
    if (Math.abs(dx - carShift[0]) < 0.5 && Math.abs(dy - carShift[1]) < 0.5) return;
    carShift = [dx, dy];
    carLayers.forEach(function (id) {
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
      if (!renderer) return;
      liftCar(matrix);
      if (m.getZoom() < MIN_ZOOM) return;
      var gv = m.getLayer('snm-roads-line-freeway') ? m.getLayoutProperty('snm-roads-line-freeway', 'visibility') !== 'none' : true;
      if (deckMat) deckMat.uniforms.uGreen.value = gv ? 1 : 0;   // 路況綠線跟著主程式的開關
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
      var b = m.getBounds();
      Object.keys(tiles).forEach(function (k) {
        var t = tiles[k], e = t.data && t.data.box;
        if (t.chunk || !e || e.e < b.getWest() || e.w > b.getEast() || e.n < b.getSouth() || e.s > b.getNorth()) return;
        t.chunk = buildChunk(t.data); t.usedAt = now;
      });
      var built = Object.keys(tiles).filter(function (k) { return tiles[k].chunk; }).sort(function (a, b2) { return tiles[a].usedAt - tiles[b2].usedAt; });
      while (built.length > MAX_CHUNKS) { var k0 = built.shift(); disposeChunk(tiles[k0].chunk); tiles[k0].chunk = null; }
      pump();
    });
  }
  // 換地圖樣式後圖層會被清掉，重加
  window._snmReloadRoad3d = function () {
    if (window.map && !window.map.getLayer(LAYER)) renderer = null;   // 圖層真的被換樣式清掉了才重建
    arranged = null; carShift = [0, 0];
    if (window.THREE && window.map && window.map.getZoom() >= MIN_ZOOM) { addLayer(); refreshOverlays(); }
  };
  window._snmRoad3dState = function () { return { tiles: tiles, threeState: threeState, routeIv: routeIv, trafficIv: trafficIv, carZ: carZ }; };   // 除錯用
  var timer = null, ovTimer = null;
  function refreshSoon() { clearTimeout(ovTimer); ovTimer = setTimeout(refreshOverlays, 300); }
  function init() {
    var m = window.map;
    if (!m) { setTimeout(init, 500); return; }
    m.on('styledata', function () { if (arranged) arrange(); });
    window.addEventListener('snm-route-changed', refreshSoon);   // 導航路線換了
    m.on('sourcedata', function (e) { if ((e.sourceId === 'snm-traffic-src' || e.sourceId === 'navRoute') && e.isSourceLoaded) refreshSoon(); });   // 路況、路線顏色更新
    var go = function () { m.on('moveend', function () { clearTimeout(timer); timer = setTimeout(check, 250); }); check(); };
    if (m.loaded()) go(); else m.once('load', go);
  }
  init();
})();
