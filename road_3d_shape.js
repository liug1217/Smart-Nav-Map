// ===== 3D 道路的形狀(手機 road_3d.js 跟電腦 tools/build-road3d.js 共用，兩邊算出來一模一樣) =====
// 第一版的畫法：照 OSM 的線拉出路面；這裡多了幾個修正：
//   - 轉角改成二次貝茲曲線(兩邊各取一段，不超過那段的一半、最多 40 公尺)，跟別條路共用的點不動
//   - 接續的兩條路(前一條的尾 = 下一條的頭)：
//       接縫的斜接方向用兩條路的平均(不會有三角形缺口 / 重疊)
//       寬度不一樣(車道數不同)：接縫用兩邊的平均寬度，往各自裡面每差一個車道 60 公尺慢慢變回自己的寬度
//   - 高度：橋每層 6 公尺(真的高架)，頭尾接別條路照那條的高度，150 公尺內慢慢接過去；上下交叉保證 4.5 公尺淨空
// 座標：平面公尺 [x, y]，y 往哪邊都可以(手機 y 往南、電腦 y 往北)，right 參數決定右手方向
(function (root) {
  'use strict';
  var LANE = 3.75;

  // 寬度：車道 3.75、單行道內側路肩 1、外側 3(匝道 2)；雙向兩邊各 1.5
  function widthOf(w) { return w.oneway ? w.lanes * LANE + 1 + (w.link ? 2 : 3) : w.lanes * LANE + 3; }

  // 轉角貝茲曲線；shared[i] = 第 i 點是接點(不動)
  function curve(P0, shared) {
    var P = [P0[0]];
    var add = function (p) { var q = P[P.length - 1]; if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.05) P.push(p); };
    for (var i = 1; i < P0.length - 1; i++) {
      var a = P0[i - 1], b = P0[i], c = P0[i + 1];
      var la = Math.hypot(b[0] - a[0], b[1] - a[1]), lc = Math.hypot(c[0] - b[0], c[1] - b[1]);
      var cosT = ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) / (la * lc || 1);
      var deg = Math.acos(Math.max(-1, Math.min(1, cosT))) * 180 / Math.PI;
      if (shared[i] || deg < 1) { add(b); continue; }
      var d = Math.min(40, la / 2, lc / 2), q0 = [b[0] + (a[0] - b[0]) * d / la, b[1] + (a[1] - b[1]) * d / la], q2 = [b[0] + (c[0] - b[0]) * d / lc, b[1] + (c[1] - b[1]) * d / lc];
      var m = Math.max(2, Math.ceil(deg / 3));
      for (var j = 0; j <= m; j++) {
        var t = j / m, u0 = (1 - t) * (1 - t), u1 = 2 * (1 - t) * t, u2 = t * t;
        add([u0 * q0[0] + u1 * b[0] + u2 * q2[0], u0 * q0[1] + u1 * b[1] + u2 * q2[1]]);
      }
    }
    add(P0[P0.length - 1]);
    return P;
  }

  // 沿路距離、每段右手方向、每點斜接方向(最多放大 2 倍)
  //   right(dx, dy) → 右手單位向量；before / after = 接續的前一條路最後一段 / 下一條路第一段的方向(單位向量，可以沒有)
  function frame(P, right, before, after) {
    var n = P.length, S = [0], seg = [], i;
    for (i = 1; i < n; i++) S[i] = S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    for (i = 0; i < n - 1; i++) { var dx = P[i + 1][0] - P[i][0], dy = P[i + 1][1] - P[i][1], l = Math.hypot(dx, dy) || 1; seg.push(right(dx / l, dy / l)); }
    var segB = before ? right(before[0], before[1]) : null, segA = after ? right(after[0], after[1]) : null;
    var R = P.map(function (_, k) {
      var a = k === 0 ? (segB || seg[0]) : seg[k - 1], b = k === n - 1 ? (segA || seg[n - 2]) : seg[k];
      var x = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(x, y) || 1; x /= l; y /= l;
      var ref = k === n - 1 ? seg[n - 2] : seg[k];
      var f = Math.min(2, 1 / Math.max(0.5, x * ref[0] + y * ref[1]));
      return [x * f, y * f];
    });
    return { S: S, seg: seg, R: R };
  }

  // 每點的路寬：接縫用兩邊平均，往裡面每差一個車道 60 公尺漸變；wStart / wEnd = 接續那條路的路寬(沒有就不用)
  function widths(w, S, wStart, wEnd) {
    var W = widthOf(w), L = S[S.length - 1];
    return S.map(function (s) {
      var v = W;
      [[wStart, s], [wEnd, L - s]].forEach(function (x) {
        if (x[0] == null || Math.abs(x[0] - W) < 0.05) return;
        var j = (x[0] + W) / 2, len = Math.min(L / 2, Math.max(20, Math.abs(x[0] - W) / LANE * 60));
        if (x[1] < len) v += (j - W) * (1 - x[1] / len);
      });
      return v;
    });
  }

  // 高度：hb 這條的高度(橋每層 6 公尺)、hs / he 頭尾要接的高度(接別條路照那條)，150 公尺內慢慢接過去；
  //   坡度最多 5%(短的橋不會變成一個尖包)；bumps = [[比例, 高度], ...] 上下交叉時要抬到的高度(電腦算好，前後 15 公尺平的、4% 坡度接回去)
  var LAYER_H = 6, MAX_SLOPE = 0.05, BUMP_SLOPE = 0.04;
  function heights(S, hb, hs, he, bumps) {
    var L = S[S.length - 1], ramp = Math.min(150, L / 2);
    return S.map(function (s) {
      var h = hb + (hs - hb) * Math.max(0, 1 - s / ramp) + (he - hb) * Math.max(0, 1 - (L - s) / ramp);
      h = Math.min(h, hs + MAX_SLOPE * s, he + MAX_SLOPE * (L - s));
      (bumps || []).forEach(function (b) { h = Math.max(h, b[1] - BUMP_SLOPE * Math.max(0, Math.abs(s - b[0] * L) - 15)); });
      return Math.max(0, h);
    });
  }
  function baseH(w) { return w.bridge ? LAYER_H * Math.max(1, w.layer) : 0; }

  // 護欄有哪些(第一版的規則)：[{ side: 1 右 / -1 左 / 0 中央, off(k) 橫向位置, rule: 'end' 頭尾 60 公尺不畫 / 'junc' 匝道接點 120 公尺內不畫 / '' }]
  function rails(w, Wv) {
    if (w.oneway && !w.link) return [{ side: 1, off: function (k) { return Wv[k] / 2 - 0.3; }, rule: 'junc' }, { side: 0, off: function (k) { return -Wv[k] / 2 - 0.1; }, rule: '' }];
    return [{ side: 1, off: function (k) { return Wv[k] / 2 - 0.3; }, rule: 'end' }, { side: -1, off: function (k) { return -Wv[k] / 2 + 0.3; }, rule: 'end' }];
  }
  // 主線路面往左多鋪 0.4 公尺：跟對向之間的空隙(推開後 0.8 公尺)鋪滿，中央護欄底下不會露出地面
  var MEDIAN_FILL = 0.4;

  var api = { LANE: LANE, LAYER_H: LAYER_H, MEDIAN_FILL: MEDIAN_FILL, widthOf: widthOf, curve: curve, frame: frame, widths: widths, heights: heights, baseH: baseH, rails: rails };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RoadShape = api;
})(this);
