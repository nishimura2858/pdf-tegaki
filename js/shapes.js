/* 図形モード: 手書きの線を、きれいな図形に直す
   直線・円（楕円）・三角形・四角形を見分ける。どれでもなければ null（手書きのまま） */
(function () {
  'use strict';

  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  // 点の並びを、角だけ残して簡単にする（Ramer–Douglas–Peucker）
  function simplify(pts, eps) {
    if (pts.length < 3) return pts.slice();
    var a = pts[0], b = pts[pts.length - 1], idx = -1, max = 0;
    for (var i = 1; i < pts.length - 1; i++) {
      var d = lineDist(pts[i], a, b);
      if (d > max) { max = d; idx = i; }
    }
    if (max <= eps) return [a, b];
    var l = simplify(pts.slice(0, idx + 1), eps), r = simplify(pts.slice(idx), eps);
    return l.slice(0, -1).concat(r);
  }
  function lineDist(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
    if (!l) return dist(p, a);
    return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / l;
  }
  // 水平・垂直に近い直線は、ぴったりそろえる
  function snap(a, b) {
    var ang = Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI);
    if (ang < 6 || ang > 174) return [a, [b[0], a[1]]];
    if (Math.abs(ang - 90) < 6) return [a, [a[0], b[1]]];
    return [a, b];
  }

  function recognize(points, W, H) {
    if (!points || points.length < 5) return null;
    var P = points.map(function (p) { return [p[0] * W, p[1] * H]; });
    var len = 0, i;
    for (i = 1; i < P.length; i++) len += dist(P[i - 1], P[i]);
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    P.forEach(function (p) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
    var bw = x1 - x0, bh = y1 - y0, D = Math.hypot(bw, bh);
    if (D < 14) return null;
    var first = P[0], last = P[P.length - 1];
    var out = null;

    if (dist(first, last) / len > 0.93) {
      out = snap(first, last);                       // 直線
    } else if (dist(first, last) < Math.max(bw, bh) * 0.3) {
      // 閉じた形: まず円・楕円かどうか
      var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = bw / 2, ry = bh / 2, err = 0;
      P.forEach(function (p) {
        err += Math.abs(Math.hypot((p[0] - cx) / (rx || 1), (p[1] - cy) / (ry || 1)) - 1);
      });
      err /= P.length;
      var v = simplify(P, D * 0.07);
      if (v.length > 2 && dist(v[0], v[v.length - 1]) < D * 0.15) v.pop();
      if (err < 0.09 || v.length > 5) {
        if (err > 0.18) return null;
        if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.15) rx = ry = (rx + ry) / 2; // ほぼ円なら円に
        out = [];
        for (i = 0; i <= 72; i++) {
          var t = i / 72 * Math.PI * 2;
          out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
        }
      } else if (v.length === 3) {
        out = v.concat([v[0]]);                      // 三角形
      } else if (v.length === 4) {
        // 辺が水平・垂直に近ければ、まっすぐな長方形にする
        var axis = true;
        for (i = 0; i < 4; i++) {
          var a = v[i], b = v[(i + 1) % 4];
          var ang = Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI) % 90;
          if (ang > 12 && ang < 78) axis = false;
        }
        out = axis ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]] : v.concat([v[0]]);
      } else return null;
    } else return null;

    return out.map(function (p) {
      return [Math.round(p[0] / W * 10000) / 10000, Math.round(p[1] / H * 10000) / 10000, 0.5];
    });
  }

  window.Shapes = { recognize: recognize, simplify: simplify };
})();
