// ===== 3D 道路的形狀(手機 road_3d.js 跟電腦 tools/build-road3d.js 共用，兩邊算出來一模一樣) =====
// 第一版的畫法：照 OSM 的線拉出路面；這裡多了幾個修正：
//   - 曲線：向心 Catmull-Rom 樣條(每段三次貝茲)，通過每個原始點、切線連續、不打結；跨接續的路段也平順
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

  // 曲線：向心 Catmull-Rom 樣條(centripetal，alpha = 0.5)，每一段換成三次貝茲曲線
  //   - 曲線一定通過每個原始點(包括交流道接點)，切線連續，整條路沒有任何折角
  //   - 向心版不會在點距不均勻時繞圈、打結或衝過頭(一般的 Catmull-Rom / 二次貝茲在 OSM 這種點距忽大忽小的資料會)
  //   - ghostA / ghostB：接續的前一條路倒數第二點 / 下一條路第二點，接縫兩邊的切線一樣，跨路段也是平順的
  //   - 取點：照轉彎量決定(每轉 1.5 度一點，最密每 1 公尺一點)；直線也至少每 8 公尺一點(交流道加寬、路寬漸變要有點才放得上去)
  function curve(P0, shared, ghostA, ghostB) {
    var n = P0.length;
    if (n < 2) return P0.slice();
    var refl = function (a, b) { return [2 * a[0] - b[0], 2 * a[1] - b[1]]; };
    var at = function (i) { return i < 0 ? (ghostA || refl(P0[0], P0[1])) : i >= n ? (ghostB || refl(P0[n - 1], P0[n - 2])) : P0[i]; };
    var P = [P0[0]];
    var add = function (p) { var q = P[P.length - 1]; if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.05) P.push(p); };
    for (var i = 0; i < n - 1; i++) {
      var p0 = at(i - 1), p1 = P0[i], p2 = P0[i + 1], p3 = at(i + 2);
      var d1 = Math.pow(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), 0.5) || 1e-6, d2 = Math.pow(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), 0.5) || 1e-6, d3 = Math.pow(Math.hypot(p3[0] - p2[0], p3[1] - p2[1]), 0.5) || 1e-6;
      // 向心 Catmull-Rom → 三次貝茲控制點(Yuksel 等人的公式)
      var b1 = [(d1 * d1 * p2[0] - d2 * d2 * p0[0] + (2 * d1 * d1 + 3 * d1 * d2 + d2 * d2) * p1[0]) / (3 * d1 * (d1 + d2)),
                (d1 * d1 * p2[1] - d2 * d2 * p0[1] + (2 * d1 * d1 + 3 * d1 * d2 + d2 * d2) * p1[1]) / (3 * d1 * (d1 + d2))];
      var b2 = [(d3 * d3 * p1[0] - d2 * d2 * p3[0] + (2 * d3 * d3 + 3 * d3 * d2 + d2 * d2) * p2[0]) / (3 * d3 * (d3 + d2)),
                (d3 * d3 * p1[1] - d2 * d2 * p3[1] + (2 * d3 * d3 + 3 * d3 * d2 + d2 * d2) * p2[1]) / (3 * d3 * (d3 + d2))];
      // 這段總共轉多少：用控制多邊形(p1 → b1 → b2 → p2)兩個轉角加起來(曲線轉的一定不超過它；S 形的也算得到)
      var ang = function (a0, a1, a2) { var u = [a1[0] - a0[0], a1[1] - a0[1]], v = [a2[0] - a1[0], a2[1] - a1[1]], lu = Math.hypot(u[0], u[1]), lv = Math.hypot(v[0], v[1]); return lu && lv ? Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (lu * lv)))) * 180 / Math.PI : 0; };
      var turn = ang(p1, b1, b2) + ang(b1, b2, p2);
      var len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), m = Math.min(Math.max(1, Math.ceil(len / 1)), Math.max(Math.ceil(len / 8), Math.ceil(turn / 1.5), 1));
      for (var j = 1; j <= m; j++) {
        var t = j / m, u = 1 - t;
        if (j === m) { add(p2); break; }
        add([u * u * u * p1[0] + 3 * u * u * t * b1[0] + 3 * u * t * t * b2[0] + t * t * t * p2[0], u * u * u * p1[1] + 3 * u * u * t * b1[1] + 3 * u * t * t * b2[1] + t * t * t * p2[1]]);
      }
    }
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
  // 第 3 階段：真的高架(每層 6 公尺)；導航路線、路況線、車子由 road_3d.js 改畫到橋面上
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
