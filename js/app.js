/* 手書きの中心部分: ページの表示、ペン入力、保存
   - 道具のボタン類は toolbar.js、投げ縄・レーザーは lasso.js、ページ一覧・検索は pages.js
   - 手書きデータ（JSON）: { version, pdf, layout?, images?, pages: { "ページ番号": [線や画像, …] } }
     - 線: { tool: pen|pencil|highlighter, color, width, points: [[x, y, 筆圧], …] }（x, y はページに対する割合）
     - 画像: { tool: 'image', id, x, y, w, h }。画像の中身は images[id]（data URL）
     - layout: ページの並び [{ src: 元のPDFのページ番号（0は白紙）, w, h, added }]。ページを追加したときだけ保存する */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), wrap = $('wrap'), pdfC = $('pdfc'), ink = $('ink'), lc = $('livec');
  var pctx = pdfC.getContext('2d'), ictx = ink.getContext('2d'), lctx = lc.getContext('2d');
  var tmp = document.createElement('canvas'), tctx = tmp.getContext('2d');
  var MAXZOOM = 2.5, PENS = { pen: 1, pencil: 1, highlighter: 1 };
  var A4 = { w: 595, h: 842 };

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  var S = {
    pdf: null, hasFile: false, name: '', key: '',
    page: 1, total: 1, zoom: 1, layout: [], images: {}, pageSize: A4,
    tool: 'pen', color: '#e53935', width: 4, shape: false, eraser: 14,
    strokes: {}, undo: [], redo: [], cache: {}, dirty: {},
    cssW: 0, cssH: 0, live: null, rc: null, anchor: null, xform: null
  };
  var hooks = { saved: null, opened: null }; // Drive同期から使う通知先
  var tools = {};                            // 投げ縄・レーザーなど、別ファイルの道具
  var listeners = {};
  function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }
  function emit(ev, a) { (listeners[ev] || []).forEach(function (fn) { try { fn(a); } catch (e) { console.error(e); } }); }
  var renderToken = 0, renderTask = null, saveTimer = null, lastStageW = 0, lastShown = '';

  /* ---------- 確認用モード（URLに ?debug=1 を付けたときだけ動く） ---------- */
  var DEBUG = /[?&]debug=1(&|$)/.test(location.search);
  var dbgBox = null, dbgLines = [], dbgT0 = performance.now();
  function dbg(msg) {
    if (!DEBUG) return;
    dbgLines.push(((performance.now() - dbgT0) / 1000).toFixed(2) + ' ' + msg);
    if (dbgLines.length > 22) dbgLines.shift();
    if (!dbgBox) {
      dbgBox = document.createElement('pre');
      dbgBox.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:50;margin:0;padding:6px 8px;' +
        'max-width:60vw;background:rgba(0,0,0,.72);color:#9f9;font:11px/1.35 ui-monospace,Menlo,monospace;' +
        'border-radius:6px;pointer-events:none;white-space:pre-wrap;';
      document.body.appendChild(dbgBox);
    }
    dbgBox.textContent = dbgLines.join('\n');
  }
  if (DEBUG) {
    // 画面の更新が止まった時間を記録する
    var lastFrame = performance.now();
    requestAnimationFrame(function tick(now) {
      if (now - lastFrame > 150 && !document.hidden) dbg('!! 画面停止 ' + Math.round(now - lastFrame) + 'ms');
      lastFrame = now;
      requestAnimationFrame(tick);
    });
    // 手書き面以外に入ったペン入力
    document.addEventListener('pointerdown', function (e) {
      if (e.target !== ink) dbg('入力(' + e.pointerType + ') → 手書き面の外: ' + (e.target.id || e.target.tagName) + ' 位置' + Math.round(e.clientX) + ',' + Math.round(e.clientY));
    }, true);
    dbg('確認用モード開始');
  }

  /* DOM更新は値が変わったときだけ（余計な再レイアウトを避ける） */
  var ui = {};
  function setText(el, t) { if (ui[el.id] !== t) { ui[el.id] = t; el.textContent = t; } }
  function setDis(el, v) { var k = 'd' + el.id; if (ui[k] !== v) { ui[k] = v; el.disabled = v; } }
  // お知らせは画面下に数秒だけ出す
  var statusTimer = null;
  function setStatus(t) {
    var el = $('status');
    setText(el, t);
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { el.classList.remove('show'); }, 3500);
  }
  // 右下のページ番号を少しのあいだ出す（text を渡すとその文字を出す: 倍率など）
  var pagerTimer = null;
  function flashPager(text) {
    var el = $('pager');
    if (!S.hasFile) return;
    setText($('pageLabel'), text || pageText());
    el.classList.add('show');
    clearTimeout(pagerTimer);
    pagerTimer = setTimeout(function () {
      pagerTimer = null;
      el.classList.remove('show');
      setText($('pageLabel'), pageText());
    }, 1400);
  }
  function r4(n) { return Math.round(n * 10000) / 10000; }
  function pages() { return S.strokes[S.page] || []; }

  /* ---------- 描画 ---------- */
  // えんぴつの質感（ざらざら）に使う模様
  var noiseTile = null;
  function noise() {
    if (noiseTile) return noiseTile;
    var c = document.createElement('canvas'); c.width = c.height = 64;
    var x = c.getContext('2d'), img = x.createImageData(64, 64), seed = 12345;
    for (var i = 0; i < img.data.length; i += 4) {
      seed = (seed * 16807) % 2147483647;
      img.data[i + 3] = Math.round(255 * (0.3 + 0.7 * (seed / 2147483647)));
    }
    x.putImageData(img, 0, 0);
    return (noiseTile = c);
  }
  // 筆圧に応じた線の太さ（画面上の大きさ W に対して）
  function widthAt(s, W, p) {
    var base = s.width * W / 1000;
    return s.tool === 'pencil' ? base * (0.45 + 0.9 * p) : base * (0.6 + 0.8 * p);
  }
  function segs(ctx, s, W, H, from) {
    var p = s.points;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
    if (p.length === 1) {
      ctx.beginPath();
      ctx.arc(p[0][0] * W, p[0][1] * H, widthAt(s, W, p[0][2]) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    for (var j = Math.max(1, from || 1); j < p.length; j++) {
      ctx.lineWidth = widthAt(s, W, (p[j][2] + p[j - 1][2]) / 2);
      ctx.beginPath();
      ctx.moveTo(p[j - 1][0] * W, p[j - 1][1] * H);
      ctx.lineTo(p[j][0] * W, p[j][1] * H);
      ctx.stroke();
    }
  }
  function hlWidth(s, W) { return s.width * W / 1000 * 5; }
  function hlPath(ctx, s, W, H) {
    var p = s.points;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.lineWidth = hlWidth(s, W); ctx.strokeStyle = s.color;
    ctx.beginPath(); ctx.moveTo(p[0][0] * W, p[0][1] * H);
    for (var i = 1; i < p.length; i++) ctx.lineTo(p[i][0] * W, p[i][1] * H);
    if (p.length === 1) ctx.lineTo(p[0][0] * W + 0.01, p[0][1] * H);
    ctx.stroke();
  }
  /* 線全体をいったん別の紙に描いてから、透明度（蛍光ペン）や質感（えんぴつ）をつけて重ねる */
  function composite(ctx, s, W, H, alpha, textured) {
    var p = s.points, i;
    var pad = (s.tool === 'highlighter' ? hlWidth(s, W) : widthAt(s, W, 1)) / 2 + 2;
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (i = 0; i < p.length; i++) {
      var x = p[i][0] * W, y = p[i][1] * H;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (tmp.width < W || tmp.height < H) { tmp.width = Math.max(tmp.width, Math.ceil(W)); tmp.height = Math.max(tmp.height, Math.ceil(H)); }
    var bx = Math.max(0, Math.floor(x0 - pad)), by = Math.max(0, Math.floor(y0 - pad));
    var bw = Math.min(W, Math.ceil(x1 + pad)) - bx, bh = Math.min(H, Math.ceil(y1 + pad)) - by;
    if (bw <= 0 || bh <= 0) return;
    tctx.save();
    tctx.clearRect(bx, by, bw, bh);
    tctx.beginPath(); tctx.rect(bx, by, bw, bh); tctx.clip();
    if (s.tool === 'highlighter') hlPath(tctx, s, W, H); else segs(tctx, s, W, H);
    if (textured) {
      tctx.globalCompositeOperation = 'destination-in';
      tctx.fillStyle = tctx.createPattern(noise(), 'repeat');
      tctx.fillRect(bx, by, bw, bh);
    }
    tctx.restore();
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.drawImage(tmp, bx, by, bw, bh, bx, by, bw, bh);
    ctx.restore();
  }
  // 画像
  var imgEls = {};
  function imgEl(id) {
    var el = imgEls[id];
    if (!el && S.images[id]) {
      el = imgEls[id] = new Image();
      el.onload = function () { drawInk(); emit('data'); };
      el.src = S.images[id];
    }
    return el;
  }
  function drawItem(ctx, s, W, H) {
    if (s.tool === 'image') {
      var el = imgEl(s.id);
      if (el && el.complete && el.naturalWidth) ctx.drawImage(el, s.x * W, s.y * H, s.w * W, s.h * H);
      return;
    }
    if (!s.points || !s.points.length) return;
    if (s.tool === 'highlighter') composite(ctx, s, W, H, 0.35, false);
    else if (s.tool === 'pencil') composite(ctx, s, W, H, 0.92, true);
    else segs(ctx, s, W, H);
  }
  // 画像を先に、線をあとに描く（画像の上に書けるように）。xf: 投げ縄で動かしている最中の見た目
  function drawList(ctx, list, W, H, xf) {
    var i, s;
    // xf が null を返したものは描かない（投げ縄で動かしている最中は、別の紙に描いている）
    for (i = 0; i < list.length; i++) { s = xf ? xf(list[i]) : list[i]; if (s && s.tool === 'image') drawItem(ctx, s, W, H); }
    for (i = 0; i < list.length; i++) { s = xf ? xf(list[i]) : list[i]; if (s && s.tool !== 'image') drawItem(ctx, s, W, H); }
  }
  function drawInk() {
    ictx.clearRect(0, 0, ink.width, ink.height);
    drawList(ictx, pages(), ink.width, ink.height, S.xform);
    if (S.live && S.live.tool === 'pen') segs(ictx, S.live, ink.width, ink.height, 1);
  }

  /* ---------- 方眼・罫線の紙 ----------
     追加した白紙のページに引く線。ページの単位（PDFの点、左上が原点）で [x1, y1, x2, y2] の並びを返す。
     画面（app.js）とPDFへの書き出し（pdf-write.js）で同じ線を使う */
  var MM = 72 / 25.4;
  function paperLines(w, h, bg) {
    var out = [], x, y;
    if (bg === 'grid') {
      var g = 5 * MM;
      for (x = g; x < w - 0.5; x += g) out.push([x, 0, x, h]);
      for (y = g; y < h - 0.5; y += g) out.push([0, y, w, y]);
    } else if (bg === 'lined') {
      var gap = 8 * MM, top = 25 * MM, side = 12 * MM;
      for (y = top; y < h - 15 * MM; y += gap) out.push([side, y, w - side, y]);
    }
    return out;
  }
  var PAPER_COLOR = '#c7d1de';
  function drawPaper(ctx, W, H, e) {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    if (!e || !e.bg) return;
    var pw = e.w || A4.w, ph = e.h || A4.h, kx = W / pw, ky = H / ph;
    ctx.save();
    ctx.strokeStyle = PAPER_COLOR; ctx.lineWidth = Math.max(1, 0.6 * kx);
    ctx.beginPath();
    paperLines(pw, ph, e.bg).forEach(function (l) { ctx.moveTo(l[0] * kx, l[1] * ky); ctx.lineTo(l[2] * kx, l[3] * ky); });
    ctx.stroke();
    ctx.restore();
  }

  /* ---------- ページの並び ---------- */
  function defaultLayout() {
    if (!S.pdf) return [{ src: 0, w: A4.w, h: A4.h }];
    var a = [];
    for (var i = 1; i <= S.pdf.numPages; i++) a.push({ src: i });
    return a;
  }
  function entry(n) { return S.layout[(n || S.page) - 1] || { src: S.pdf ? 1 : 0 }; }
  // ページの大きさ（PDFの単位）と、pdf.js のページ（白紙なら null）
  async function pageInfo(n) {
    var e = entry(n);
    if (e.src > 0 && S.pdf) {
      var page = await S.pdf.getPage(e.src);
      var b = page.getViewport({ scale: 1 });
      return { page: page, w: b.width, h: b.height };
    }
    return { page: null, w: e.w || A4.w, h: e.h || A4.h };
  }

  /* ---------- 見開き（横画面）と、ページの絵の控え ----------
     横画面では2ページを並べる（1-2, 3-4, …）。書ける紙（wrap）は1枚だけなので、
     もう片方は絵（still）で出しておき、ペンが触れたら見た目を変えずに一瞬で入れかえる */
  var flow = $('flow'), still = $('still'), spine = $('spine'), turnEl = $('turn');
  S.spread = false;
  function isSpread() { return S.hasFile && stage.clientWidth > stage.clientHeight * 1.1; }
  // 見開きの組み合わせ。ずらす設定（S.shift）がオンなら、1ページ目は右に1枚だけ、そのあと 2-3, 4-5, …
  S.shift = false;
  function isLeft(n) { return (n + (S.shift ? 1 : 0)) % 2 === 1; }
  function leftOf(n) { return isLeft(n) ? n : n - 1; }   // 0 のときは左がない（ずらしたときの1ページ目）
  function partner(n) { var m = isLeft(n) ? n + 1 : n - 1; return m >= 1 && m <= S.total ? m : 0; }
  function shiftKey() { return 'spreadShift:' + S.key; }
  function loadShift() { try { S.shift = localStorage.getItem(shiftKey()) === '1'; } catch (e) { S.shift = false; } }
  // 「その他」から: このPDFの見開きの組み合わせを1ページずらす（PDFごとに覚えておく）
  function setShift(v) {
    S.shift = !!v;
    try { if (S.shift) localStorage.setItem(shiftKey(), '1'); else localStorage.removeItem(shiftKey()); } catch (e) {}
    if (st) st.n = -1;
    renderPage(); updateUI();
  }
  // 前・次へ移る先（見開きなら2ページずつ。移った先は左のページ）
  function stepPage(d) {
    if (!S.spread) return S.page + d;
    var n = leftOf(S.page) + 2 * d;
    return n === 0 ? 1 : n; // ずらしたときの1ページ目（右に1枚だけ）
  }
  function canStep(d) { var n = stepPage(d); return S.hasFile && n >= 1 && n <= S.total; }
  function pageText() {
    var m = S.spread ? partner(S.page) : 0;
    return (m ? Math.min(S.page, m) + '-' + Math.max(S.page, m) : S.page) + ' / ' + S.total;
  }

  // ページの大きさ（PDFの単位）。元のPDFのページ番号ごとに控える
  var sizes = {};
  function sizeKey(n) { var e = entry(n); return e.src > 0 ? 's' + e.src : 'b' + (e.w || A4.w) + 'x' + (e.h || A4.h); }
  async function sizeOf(n) {
    var k = sizeKey(n);
    if (!sizes[k]) { var i = await pageInfo(n); sizes[k] = { w: i.w, h: i.h }; }
    return sizes[k];
  }
  // 今の並べ方での、ページの表示の大きさ（見開きは高さをそろえる）
  function cssOf(sz) {
    return S.spread ? { w: S.cssH * sz.w / sz.h, h: S.cssH } : { w: S.cssW, h: S.cssW * sz.h / sz.w };
  }
  function capDpr(w, h) { return Math.max(0.5, Math.min(Math.min(window.devicePixelRatio || 1, 2), Math.sqrt(1.6e6 / (w * h)))); }

  // ページの紙とPDFだけの絵（手書きは重ねるときに描く）。めくるとき・見開きの片方に使う
  var baseCache = {}, baseList = [], BASE_KEEP = 8;
  function baseKey(n, css) { var e = entry(n); return [S.key, sizeKey(n), e.bg || '', Math.round(css.w)].join('|'); }
  function getBase(n) {
    return sizeOf(n).then(function (sz) {
      var css = cssOf(sz), key = baseKey(n, css), hit = baseCache[key];
      if (hit) return hit.p;
      var slot = { p: null, c: null };
      slot.p = (async function () {
        var info = await pageInfo(n), d = capDpr(css.w, css.h);
        var W = Math.max(1, Math.floor(css.w * d)), H = Math.max(1, Math.floor(css.h * d));
        var c = document.createElement('canvas'); c.width = W; c.height = H;
        var x = c.getContext('2d');
        drawPaper(x, W, H, info.page ? null : entry(n));
        if (info.page) await info.page.render({ canvasContext: x, viewport: info.page.getViewport({ scale: W / info.w }) }).promise;
        slot.c = c;
        return c;
      })();
      baseCache[key] = slot; baseList.push(key);
      while (baseList.length > BASE_KEEP) delete baseCache[baseList.shift()];
      slot.p.catch(function () { if (baseCache[key] === slot) delete baseCache[key]; });
      return slot.p;
    });
  }
  function baseNow(n) { // もう描けていれば返す
    var sz = sizes[sizeKey(n)]; if (!sz) return null;
    var hit = baseCache[baseKey(n, cssOf(sz))]; return hit ? hit.c : null;
  }
  function blankCanvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function copyOf(src) { var c = blankCanvas(src.width, src.height); c.getContext('2d').drawImage(src, 0, 0); return c; }
  function inkOf(n, w, h) { var c = blankCanvas(w, h); drawList(c.getContext('2d'), S.strokes[n] || [], w, h); return c; }
  // 紙＋手書きを1枚に
  function compose(n, base) { var c = copyOf(base); drawList(c.getContext('2d'), S.strokes[n] || [], c.width, c.height); return c; }
  // 今の書ける紙を写しとる
  function snapshotCurrent() {
    var d = capDpr(S.cssW, S.cssH), W = Math.floor(S.cssW * d), H = Math.floor(S.cssH * d);
    var b = blankCanvas(W, H); b.getContext('2d').drawImage(pdfC, 0, 0, W, H);
    var i = blankCanvas(W, H); i.getContext('2d').drawImage(ink, 0, 0, W, H);
    return { n: S.page, base: b, ink: i, w: S.cssW, h: S.cssH, key: baseKey(S.page, { w: S.cssW }) };
  }
  // めくる紙の面に貼る絵（なければ null）
  function faceOf(n) {
    if (!n) return null;
    if (n === S.page) { var s = snapshotCurrent(); s.base.getContext('2d').drawImage(s.ink, 0, 0); return s.base; }
    if (st && st.n === n && st.base) { var c = copyOf(st.base); if (st.ink) c.getContext('2d').drawImage(st.ink, 0, 0); return c; }
    var b = baseNow(n); return b ? compose(n, b) : null;
  }

  // 見開きのもう片方（絵）
  var st = null, stTok = 0;
  function setStill(o) {
    st = o; still.textContent = '';
    if (!o) { still.hidden = true; return; }
    still.hidden = false; still.dataset.n = o.n;
    still.style.width = o.w + 'px'; still.style.height = o.h + 'px';
    if (o.base) still.appendChild(o.base);
    if (o.ink) still.appendChild(o.ink);
  }
  function stillFrom(n, base) {
    var css = cssOf(sizes[sizeKey(n)]), b = copyOf(base);
    return { n: n, base: b, ink: inkOf(n, b.width, b.height), w: css.w, h: css.h, key: baseKey(n, css) };
  }
  function layoutSpread() {
    flow.classList.toggle('spread', S.spread);
    flow.classList.toggle('act-r', S.spread && !isLeft(S.page));
    var w = S.cssW, lw = S.cssW;
    if (S.spread) {
      if (st) { w += st.w; if (!isLeft(S.page)) lw = st.w; }
      else w *= 2; // 最後の1ページだけのときも、左側に置く
    }
    flow.style.width = w + 'px';
    spine.style.left = lw + 'px'; spine.style.height = S.cssH + 'px';
    layoutEdges(w);
  }
  /* 小口: 紙の左右の外側。厚さは、その向きに残っているページ数で変わる */
  var edgeL = $('edgeL'), edgeR = $('edgeR');
  function layoutEdges(w) {
    var room = Math.floor((stage.clientWidth - w) / 2) - 1, h = S.cssH;
    var lo = S.spread ? leftOf(S.page) : S.page, hi = S.spread ? lo + 1 : S.page;
    [[edgeL, lo - 1], [edgeR, S.total - hi]].forEach(function (a) {
      var el = a[0], n = Math.max(0, a[1]);
      var on = S.hasFile && n > 0 && room >= 8;
      el.classList.toggle('on', on);
      if (!on) return;
      var th = Math.min(room - 2, 34), k = Math.min(1, n / Math.max(20, S.total));
      el.style.width = room + 'px'; el.style.height = h + 'px';
      el.style.left = (el === edgeL ? -room : w) + 'px';
      el.style.setProperty('--th', Math.round(Math.max(6, Math.min(th, 6 + (th - 6) * Math.sqrt(k)))) + 'px');
    });
  }
  function updateStill() {
    var m = S.spread ? partner(S.page) : 0;
    if (!m) { stTok++; setStill(null); layoutSpread(); return; }
    var sz = sizes[sizeKey(m)], css = sz ? cssOf(sz) : { w: S.cssW, h: S.cssH };
    if (!(st && st.n === m && sz && st.key === baseKey(m, css))) {
      var b = sz && baseNow(m), tok = ++stTok;
      if (b) setStill(stillFrom(m, b));
      else {
        setStill({ n: m, w: css.w, h: css.h, key: '' }); // 描けるまでは白い紙
        getBase(m).then(function (c) {
          if (tok !== stTok) return;
          setStill(stillFrom(m, c)); layoutSpread();
        }, function () {});
      }
    }
    layoutSpread();
  }
  on('layout', function () { if (st) st.n = -1; }); // ページの並びが変わったら、絵は描き直す

  // 書ける紙の大きさ・置き場所を決めて、手書きを描く（ここまでは待たずに一度に）
  function layoutPage(bw, bh, msz) {
    S.pageSize = { w: bw, h: bh };
    lastStageW = stage.clientWidth;
    var cssW, cssH;
    if (S.spread) {
      var a = bw / bh + (msz ? msz.w / msz.h : bw / bh);
      cssH = Math.max(160, Math.min(stage.clientHeight - 18, (stage.clientWidth - 24) / a) * S.zoom);
      cssW = cssH * bw / bh;
    } else {
      cssW = Math.max(240, (stage.clientWidth - 24) * S.zoom);
      cssH = cssW * bh / bw;
    }
    var area = cssW * cssH, dw = Math.min(window.devicePixelRatio || 1, 2);
    var dprPdf = Math.max(0.7, Math.min(dw, Math.sqrt(9e6 / area)));
    var dprInk = Math.max(0.7, Math.min(dw, Math.sqrt(6e6 / area)));
    S.cssW = cssW; S.cssH = cssH;
    wrap.style.width = cssW + 'px'; wrap.style.height = cssH + 'px';
    if (S.swap) { var sw = S.swap; S.swap = null; sw(); } // めくり終わったあとの置きかえ（同じ瞬間に）
    updateStill();
    // 画面より小さいとき（縮小・見開き）は、上下のまん中に
    flow.style.marginTop = Math.max(0, Math.floor((stage.clientHeight - cssH - 18) / 2)) + 'px';
    // 同じページの描き直し（拡大・画面の回転）では、描き終わるまで今の絵を引き伸ばして出しておく（白く点滅しないように）
    var shown = S.key + ':' + S.page + ':' + entry().src, changed = shown !== lastShown, old = null;
    var pw = Math.floor(cssW * dprPdf), ph = Math.floor(cssH * dprPdf);
    if (pdfC.width !== pw || pdfC.height !== ph) {
      if (!changed && pdfC.width > 0) { old = copyOf(pdfC); }
      pdfC.width = pw; pdfC.height = ph;
      if (old) { pctx.drawImage(old, 0, 0, pw, ph); old.width = old.height = 0; }
    }
    if (changed) {
      pctx.clearRect(0, 0, pw, ph);
      if (S.placeholder) pctx.drawImage(S.placeholder, 0, 0, pw, ph); // めくってきた絵を、描き終わるまでの代わりに
      lctx.clearRect(0, 0, lc.width, lc.height);
    }
    S.placeholder = null; lastShown = shown;
    var iw = Math.floor(cssW * dprInk), ih = Math.floor(cssH * dprInk);
    [ink, lc, tmp].forEach(function (c) { if (c.width !== iw || c.height !== ih) { c.width = iw; c.height = ih; } });
    [pdfC, ink, lc].forEach(function (c) { c.style.width = cssW + 'px'; c.style.height = cssH + 'px'; });
    if (S.anchor) {
      var an = S.anchor; S.anchor = null;
      var rc = flow.getBoundingClientRect();
      stage.scrollLeft += rc.left + an.fx * rc.width - an.cx;
      stage.scrollTop += rc.top + an.fy * rc.height - an.cy;
    }
    drawInk();
    emit('resize');
    return { cssW: cssW, dprPdf: dprPdf };
  }

  async function renderPage() {
    if (!S.hasFile) return;
    var t0 = performance.now();
    var token = ++renderToken;
    if (renderTask) { try { renderTask.cancel(); } catch (e) {} renderTask = null; }
    S.spread = isSpread();
    var info = await pageInfo(S.page);
    var m = S.spread ? partner(S.page) : 0, msz = m ? await sizeOf(m) : null;
    if (token !== renderToken) return;
    var page = info.page, bw = info.w, bh = info.h;
    sizes[sizeKey(S.page)] = { w: bw, h: bh };
    var L = layoutPage(bw, bh, msz);
    if (page) {
      // 別の紙に描いてから、できあがったら一度に写す
      var off = blankCanvas(pdfC.width, pdfC.height);
      var task = page.render({ canvasContext: off.getContext('2d'), viewport: page.getViewport({ scale: L.cssW / bw * L.dprPdf }) });
      renderTask = task;
      try {
        await task.promise;
        if (token === renderToken) { pctx.clearRect(0, 0, pdfC.width, pdfC.height); pctx.drawImage(off, 0, 0); }
      } catch (e) {
        if (!(e && e.name === 'RenderingCancelledException')) { setStatus('PDFの表示に失敗しました'); console.error(e); }
      }
      off.width = off.height = 0;
      if (token !== renderToken) return;
    } else {
      drawPaper(pctx, pdfC.width, pdfC.height, entry());
    }
    dbg('ページ描き直し ' + Math.round(performance.now() - t0) + 'ms（倍率' + Math.round(S.zoom * 100) + '%）');
    updateUI();
    prefetch();
  }
  // めくる先のページを、先に描いておく
  var preTimer = 0;
  function prefetch() {
    clearTimeout(preTimer);
    preTimer = setTimeout(function () {
      var L = leftOf(S.page);
      var list = S.spread ? [L + 2, L + 3, L - 1, L - 2] : [S.page + 1, S.page - 1];
      list.filter(function (n) { return n >= 1 && n <= S.total; })
        .reduce(function (p, n) { return p.then(function () { return getBase(n); }).catch(function () {}); }, Promise.resolve());
    }, 150);
  }
  /* 見開きのもう片方を、書ける紙にする（見た目は変えずに、すぐに） */
  function activate(n) {
    if (!S.spread || !st || st.n !== n || !st.base || turning) return false;
    var sz = sizes[sizeKey(n)]; if (!sz) return false;
    var old = snapshotCurrent(), ph = st.base;
    stTok++;
    S.page = n; S.live = null;
    S.placeholder = ph;
    setStill(old);
    layoutPage(sz.w, sz.h, sizes[sizeKey(old.n)]);
    renderPage(); // きれいな絵に描き直す（大きさは変わらないので、手書きは消えない）
    flashPager(); emit('page'); updateUI();
    return true;
  }

  /* ページ一覧用の小さな絵（PDF＋手書き）を canvas に描く */
  async function renderThumb(canvas, n, cssWidth) {
    var info = await pageInfo(n);
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = Math.round(cssWidth * dpr), H = Math.round(cssWidth * info.h / info.w * dpr);
    canvas.width = W; canvas.height = H;
    canvas.style.width = cssWidth + 'px'; canvas.style.height = (cssWidth * info.h / info.w) + 'px';
    var ctx = canvas.getContext('2d');
    drawPaper(ctx, W, H, info.page ? null : entry(n));
    if (info.page) await info.page.render({ canvasContext: ctx, viewport: info.page.getViewport({ scale: W / info.w }) }).promise;
    drawList(ctx, S.strokes[n] || [], W, H);
  }

  function updateUI() {
    if (!pagerTimer) setText($('pageLabel'), S.hasFile ? pageText() : '- / -');
    setDis($('prev'), !canStep(-1));
    setDis($('next'), !canStep(1));
    setDis($('undo'), !S.undo.length);
    setDis($('redo'), !S.redo.length);
    emit('ui');
  }

  /* ---------- 保存・復元 ---------- */
  function layoutCustom() { return S.layout.some(function (e) { return e.added; }); }
  // 使っている画像だけを保存する（取り消し履歴にある画像も残す）
  function usedImages() {
    var ids = {};
    function scan(list) { (list || []).forEach(function (s) { if (s.tool === 'image') ids[s.id] = 1; }); }
    Object.keys(S.strokes).forEach(function (k) { scan(S.strokes[k]); });
    S.undo.concat(S.redo).forEach(function (u) { scan(u.strokes); });
    var out = {};
    Object.keys(ids).sort().forEach(function (id) { if (S.images[id]) out[id] = S.images[id]; });
    return out;
  }
  function exportData() {
    var out = {};
    for (var k in S.strokes) if (S.strokes[k].length) out[k] = S.strokes[k];
    var d = { version: 1, pdf: S.name };
    if (layoutCustom()) d.layout = S.layout;
    var im = usedImages(); if (Object.keys(im).length) d.images = im;
    d.pages = out;
    return d;
  }
  function num(v, lo, hi, def) { v = +v; return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; }
  /* 読み込んだデータを確かめて、使える形に直す。だめなら null */
  function parseData(d) {
    if (!d || typeof d !== 'object' || !d.pages || typeof d.pages !== 'object') return null;
    var res = {};
    Object.keys(d.pages).forEach(function (k) {
      var arr = d.pages[k]; if (!Array.isArray(arr)) return;
      var list = [];
      arr.forEach(function (s) {
        if (!s) return;
        if (s.tool === 'image') {
          if (typeof s.id === 'string' && isFinite(s.x) && isFinite(s.y) && s.w > 0 && s.h > 0)
            list.push({ tool: 'image', id: s.id, x: +s.x, y: +s.y, w: +s.w, h: +s.h });
          return;
        }
        if (!Array.isArray(s.points) || !s.points.length) return;
        var pts = [];
        s.points.forEach(function (q) {
          if (Array.isArray(q) && isFinite(q[0]) && isFinite(q[1]))
            pts.push([+q[0], +q[1], isFinite(q[2]) ? +q[2] : 0.5]);
        });
        if (!pts.length) return;
        list.push({
          tool: PENS[s.tool] ? s.tool : 'pen',
          color: /^#[0-9a-f]{3,8}$/i.test(s.color) ? s.color : '#1b2430',
          width: num(s.width, 0.5, 40, 4),
          points: pts
        });
      });
      if (list.length) res[k] = list;
    });
    var layout = null;
    if (Array.isArray(d.layout) && d.layout.length) {
      var max = S.pdf ? S.pdf.numPages : 0, ok = true;
      layout = d.layout.map(function (e) {
        var src = Math.floor(+(e && e.src));
        if (!(src >= 0 && src <= max)) ok = false;
        var o = { src: src };
        if (src === 0) {
          o.w = num(e.w, 50, 5000, A4.w); o.h = num(e.h, 50, 5000, A4.h);
          if (e.bg === 'grid' || e.bg === 'lined') o.bg = e.bg;
        }
        if (e && e.added) o.added = true;
        return o;
      });
      if (!ok) layout = null;
    }
    var images = {};
    if (d.images && typeof d.images === 'object') Object.keys(d.images).forEach(function (id) {
      var v = d.images[id];
      if (typeof v === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(v)) images[id] = v;
    });
    return { pages: res, layout: layout, images: images };
  }
  function applyData(r) {
    S.strokes = r.pages;
    S.images = r.images || {};
    imgEls = {};
    S.layout = r.layout || defaultLayout();
    S.total = S.layout.length;
    if (S.page > S.total) S.page = S.total;
    S.undo = []; S.redo = []; S.cache = {}; S.dirty = {};
  }
  var imgJson = { key: '', text: '' };
  // quiet === true のときは「変更あり」を外部（Drive同期）に知らせない（Driveから読み込んだ直後の保存など）
  function doSave(quiet) {
    saveTimer = null;
    var t0 = performance.now();
    try {
      var parts = [];
      Object.keys(S.strokes).forEach(function (k) {
        var arr = S.strokes[k];
        if (!arr.length) { delete S.cache[k]; return; }
        if (S.dirty[k] || S.cache[k] === undefined) S.cache[k] = JSON.stringify(arr);
        parts.push(JSON.stringify(k) + ':' + S.cache[k]);
      });
      S.dirty = {};
      var extra = '';
      if (layoutCustom()) extra += ',"layout":' + JSON.stringify(S.layout);
      var im = usedImages(), ik = Object.keys(im).join(',');
      if (ik) {
        if (imgJson.key !== ik) imgJson = { key: ik, text: JSON.stringify(im) };
        extra += ',"images":' + imgJson.text;
      }
      var data = '{"version":1,"pdf":' + JSON.stringify(S.name) + extra + ',"pages":{' + parts.join(',') + '}}';
      localStorage.setItem(S.key, data);
      dbg('自動保存 ' + Math.round(performance.now() - t0) + 'ms（' + Math.round(data.length / 1024) + 'KB）');
      setStatus('自動保存しました');
    } catch (e) { setStatus('この端末への保存に失敗しました（容量がいっぱいの可能性があります）'); }
    if (quiet !== true && hooks.saved) hooks.saved(S.key);
  }
  function scheduleSave(page) {
    S.dirty[page || S.page] = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function wait() {
      if (drawing) { saveTimer = setTimeout(wait, 1500); return; }
      if (window.requestIdleCallback) requestIdleCallback(doSave, { timeout: 3000 }); else doSave();
    }, 3000);
  }
  function flushSave() { if (saveTimer) { clearTimeout(saveTimer); doSave(); } }
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', function () { if (document.hidden) flushSave(); });
  function loadSaved() {
    applyData({ pages: {}, layout: null, images: {} });
    try {
      var raw = localStorage.getItem(S.key);
      if (raw) {
        var res = parseData(JSON.parse(raw));
        if (res) { applyData(res); setStatus('保存済みの手書きを復元しました'); return; }
      }
    } catch (e) {}
    setStatus('手書きは自動保存されます');
  }

  /* ---------- ファイルを開く ---------- */
  function openDoc(doc, name, key) {
    flushSave(); // 前のファイルの未保存分を、切り替える前に保存する
    S.pdf = doc; S.hasFile = true; S.name = name; S.key = key;
    S.page = 1; S.zoom = 1; S.live = null;
    sizes = {}; baseCache = {}; baseList = []; stTok++; setStill(null); // 前のファイルの絵は使わない
    loadShift();
    loadSaved();
    $('hint').style.display = 'none'; wrap.style.display = 'block';
    $('pager').hidden = false;
    document.body.classList.add('has-file');
    stage.scrollTo(0, 0);
    renderPage();
    emit('open');
    emit('page');
    if (hooks.opened) hooks.opened(key, name);
  }

  /* ---------- 操作 ---------- */
  function goPage(n, keepScroll) {
    n = Math.min(S.total, Math.max(1, n));
    if (n === S.page && S.hasFile) { drawInk(); updateUI(); return Promise.resolve(); }
    if (turning) return Promise.resolve();
    if (S.spread && st && st.n === n && activate(n)) return Promise.resolve(); // 同じ見開きのもう片方
    S.page = n; S.live = null;
    if (!keepScroll) stage.scrollTo(0, 0);
    var done = renderPage();
    flashPager();
    emit('page');
    return done;
  }
  $('prev').onclick = function () { autoTurn(-1); };
  $('next').onclick = function () { autoTurn(1); };
  function setZoom(z) {
    S.zoom = Math.min(MAXZOOM, Math.max(minZoom(), Math.round(z * 100) / 100));
    flashPager(Math.round(S.zoom * 100) + '%');
    renderPage();
  }

  function pushUndo(page) {
    page = page || S.page;
    S.undo.push({ page: page, strokes: (S.strokes[page] || []).slice() });
    if (S.undo.length > 200) S.undo.shift();
    S.redo = [];
  }
  // 手書きを変えたあとの共通処理（描き直し・ボタンの状態・保存）
  function commit(page) { drawInk(); updateUI(); scheduleSave(page); emit('data'); }
  function applySnapshot(from, to) {
    var a = from.pop(); if (!a) return;
    emit('beforeUndo');
    to.push({ page: a.page, strokes: (S.strokes[a.page] || []).slice() });
    S.strokes[a.page] = a.strokes;
    scheduleSave(a.page);
    emit('data');
    if (a.page !== S.page) { goPage(a.page); } else { drawInk(); updateUI(); }
  }
  $('undo').onclick = function () { applySnapshot(S.undo, S.redo); };
  $('redo').onclick = function () { applySnapshot(S.redo, S.undo); };
  $('clearPage').onclick = function () {
    if (!S.hasFile || !pages().length) return;
    pushUndo(); S.strokes[S.page] = []; commit();
    setStatus('このページを消去しました（元に戻すボタンで戻せます）');
  };

  /* ページを今のページの次に追加する。kind: 'same'（同じページ）/ 'blank'（白紙） */
  function insertPage(kind) {
    if (!S.hasFile) return Promise.resolve();
    flushSave();
    var cur = entry();
    // 'same': 今のページと同じもの（白紙・方眼・罫線のページなら同じ紙）。'blank' / 'grid' / 'lined': その紙
    var e = kind !== 'same' || !(cur.src > 0)
      ? { src: 0, w: Math.round(S.pageSize.w), h: Math.round(S.pageSize.h), added: true }
      : { src: cur.src, added: true };
    var bg = kind === 'same' ? cur.bg : kind;
    if (e.src === 0 && (bg === 'grid' || bg === 'lined')) e.bg = bg;
    var at = S.page; // この番号の次に入る
    S.layout.splice(at, 0, e);
    var ns = {};
    Object.keys(S.strokes).forEach(function (k) { var n = +k; ns[n > at ? n + 1 : n] = S.strokes[k]; });
    S.strokes = ns; S.total = S.layout.length;
    S.undo = []; S.redo = []; S.cache = {}; // ページ番号がずれるので、取り消し履歴は消す
    scheduleSave(at + 1);
    emit('layout');
    var done = goPage(at + 1);
    var PAPER = { blank: '白紙のページ', grid: '方眼のページ', lined: '罫線のページ' };
    setStatus(PAPER[kind] ? PAPER[kind] + 'を追加しました' : '同じページを追加しました');
    return done;
  }
  /* 今のページを削除する（追加したページだけ） */
  function deletePage() {
    if (!S.hasFile) return;
    if (!entry().added) { setStatus('元のPDFのページは削除できません（追加したページだけ削除できます）'); return; }
    if (!window.confirm('このページ（' + S.page + 'ページ目）を削除しますか？\n書き込みも一緒に消えます。')) return;
    flushSave();
    var at = S.page;
    S.layout.splice(at - 1, 1);
    var ns = {};
    Object.keys(S.strokes).forEach(function (k) { var n = +k; if (n !== at) ns[n > at ? n - 1 : n] = S.strokes[k]; });
    S.strokes = ns; S.total = S.layout.length;
    S.undo = []; S.redo = []; S.cache = {};
    scheduleSave(1);
    emit('layout');
    S.page = 0; goPage(Math.min(at, S.total));
    setStatus('ページを削除しました');
  }

  /* 画像を今のページの、見えている場所の真ん中に貼る。貼った画像を返す */
  function addImage(dataUrl, natW, natH) {
    if (!S.hasFile) return null;
    var id = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    S.images[id] = dataUrl;
    var rc = wrap.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    var vx0 = Math.max(rc.left, sr.left), vx1 = Math.min(rc.right, sr.right);
    var vy0 = Math.max(rc.top, sr.top), vy1 = Math.min(rc.bottom, sr.bottom);
    var cx = ((vx0 + vx1) / 2 - rc.left) / rc.width, cy = ((vy0 + vy1) / 2 - rc.top) / rc.height;
    var wpx = Math.min(S.cssW * 0.5, (vx1 - vx0) * 0.7), hpx = wpx * natH / natW;
    var maxH = Math.min(S.cssH * 0.6, (vy1 - vy0) * 0.7);
    if (hpx > maxH) { wpx *= maxH / hpx; hpx = maxH; }
    var it = { tool: 'image', id: id, x: r4(cx - wpx / 2 / S.cssW), y: r4(cy - hpx / 2 / S.cssH), w: r4(wpx / S.cssW), h: r4(hpx / S.cssH) };
    pushUndo();
    (S.strokes[S.page] = S.strokes[S.page] || []).push(it);
    commit();
    return it;
  }

  function setTool(t) { S.tool = t; if (S.live) S.live = null; emit('tool', t); }

  /* ---------- 手書き ---------- */
  var drawing = null, pan = null, erased = false;
  var touches = {}, pinch = null, lastPenUp = 0, rafId = 0, drawnIdx = 0;

  /* 縮小できる限界: ページ（見開きなら2ページぶん）が画面に収まって、まわりに約2.5cm残るところまで。
     iPadの画面では 1cm ≒ 52px（CSSの単位） */
  var CM = 52;
  function minZoom() {
    if (!S.cssW || !S.zoom) return 0.5;
    var w1 = flow.offsetWidth / S.zoom, h1 = S.cssH / S.zoom, m = 2.5 * CM * 2;
    var z = Math.min((stage.clientWidth - m) / w1, (stage.clientHeight - m) / h1);
    return Math.max(0.3, Math.min(1, Math.round(z * 100) / 100));
  }
  function tMetrics() {
    var ids = Object.keys(touches), a = touches[ids[0]], b = touches[ids[1]];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }
  function startPinch() {
    var m = tMetrics(), rc = flow.getBoundingClientRect();
    pinch = { d0: m.d, cx0: m.cx, cy0: m.cy, cx: m.cx, cy: m.cy, z0: S.zoom, s: 1,
      fx: (m.cx - rc.left) / rc.width, fy: (m.cy - rc.top) / rc.height };
    flow.style.transformOrigin = (pinch.fx * 100) + '% ' + (pinch.fy * 100) + '%';
  }
  function movePinch() {
    var m = tMetrics();
    var z = Math.min(MAXZOOM, Math.max(minZoom(), pinch.z0 * m.d / pinch.d0));
    pinch.s = z / pinch.z0; pinch.cx = m.cx; pinch.cy = m.cy;
    flashPager(Math.round(z * 100) + '%');
    flow.style.transform = 'translate(' + (m.cx - pinch.cx0) + 'px,' + (m.cy - pinch.cy0) + 'px) scale(' + pinch.s + ')';
  }
  function clearPinchStyle() { flow.style.transform = ''; flow.style.transformOrigin = ''; }
  function cancelPinch() { pinch = null; clearPinchStyle(); }
  function endPinch() {
    var p = pinch; cancelPinch();
    var nz = Math.round(p.z0 * p.s * 100) / 100;
    dbg('ピンチ終了 ' + Math.round(S.zoom * 100) + '% → ' + Math.round(nz * 100) + '%');
    if (Math.abs(nz - S.zoom) < 0.01) return;
    S.anchor = { fx: p.fx, fy: p.fy, cx: p.cx, cy: p.cy };
    S.zoom = nz; renderPage();
  }

  function pos(e) {
    var rc = S.rc;
    var pr = e.pressure > 0 ? e.pressure : 0.5;
    return [r4((e.clientX - rc.left) / rc.width), r4((e.clientY - rc.top) / rc.height), Math.round(pr * 100) / 100];
  }
  function segDist(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    var t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function hit(s, px, py, r) {
    if (s.tool === 'image') return false; // 画像は消しゴムでは消えない（投げ縄で削除）
    var p = s.points, W = S.cssW, H = S.cssH;
    if (s.tool === 'highlighter') r += hlWidth(s, W) / 2;
    if (p.length === 1) return Math.hypot(px - p[0][0] * W, py - p[0][1] * H) < r;
    for (var i = 1; i < p.length; i++)
      if (segDist(px, py, p[i - 1][0] * W, p[i - 1][1] * H, p[i][0] * W, p[i][1] * H) < r) return true;
    return false;
  }
  function eraseAt(pt) {
    var arr = pages(), px = pt[0] * S.cssW, py = pt[1] * S.cssH;
    var keep = arr.filter(function (s) { return !hit(s, px, py, S.eraser); });
    if (keep.length !== arr.length) {
      if (!erased) { pushUndo(); erased = true; }
      S.strokes[S.page] = keep; drawInk(); updateUI(); scheduleSave();
    }
  }
  // 蛍光ペンはまっすぐな線にする。ほぼ水平なら水平にそろえる
  function straight(a, b) {
    var dx = (b[0] - a[0]) * S.cssW, dy = (b[1] - a[1]) * S.cssH;
    if (Math.abs(dy) < Math.abs(dx) * 0.12) b = [b[0], a[1], b[2]];
    return [[a[0], a[1], 0.5], [b[0], b[1], 0.5]];
  }
  /* えんぴつの書いている最中: 新しく書いた所のまわりだけを描き直して、質感の模様で切り抜く。
     （以前は書き込み面全体にCSSの模様マスクをかけていて、iPadで線が遅れて出ていた） */
  var livePat = null;
  function pencilLive(from) {
    var s = S.live, p = s.points, W = lc.width, H = lc.height, i;
    var pad = widthAt(s, W, 1) / 2 + 2;
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (i = Math.max(0, (from || 1) - 1); i < p.length; i++) {
      var x = p[i][0] * W, y = p[i][1] * H;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    var bx = Math.max(0, Math.floor(x0 - pad)), by = Math.max(0, Math.floor(y0 - pad));
    var bw = Math.min(W, Math.ceil(x1 + pad)) - bx, bh = Math.min(H, Math.ceil(y1 + pad)) - by;
    if (bw <= 0 || bh <= 0) return;
    lctx.save();
    lctx.beginPath(); lctx.rect(bx, by, bw, bh); lctx.clip();
    lctx.clearRect(bx, by, bw, bh);
    lctx.lineCap = 'round'; lctx.lineJoin = 'round'; lctx.strokeStyle = s.color; lctx.fillStyle = s.color;
    if (p.length === 1) {
      lctx.beginPath(); lctx.arc(p[0][0] * W, p[0][1] * H, widthAt(s, W, p[0][2]) / 2, 0, Math.PI * 2); lctx.fill();
    }
    for (var j = 1; j < p.length; j++) {
      var ax = p[j - 1][0] * W, ay = p[j - 1][1] * H, cx = p[j][0] * W, cy = p[j][1] * H;
      if (Math.max(ax, cx) + pad < bx || Math.min(ax, cx) - pad > bx + bw ||
          Math.max(ay, cy) + pad < by || Math.min(ay, cy) - pad > by + bh) continue; // この範囲にかからない線
      lctx.lineWidth = widthAt(s, W, (p[j][2] + p[j - 1][2]) / 2);
      lctx.beginPath(); lctx.moveTo(ax, ay); lctx.lineTo(cx, cy); lctx.stroke();
    }
    lctx.globalCompositeOperation = 'destination-in';
    lctx.fillStyle = livePat || (livePat = lctx.createPattern(noise(), 'repeat'));
    lctx.fillRect(bx, by, bw, bh);
    lctx.restore();
  }
  function drawLive(from) {
    var s = S.live;
    if (s.tool === 'pen') segs(ictx, s, ink.width, ink.height, from);
    else if (s.tool === 'pencil') pencilLive(from);
    else { lctx.clearRect(0, 0, lc.width, lc.height); hlPath(lctx, s, lc.width, lc.height); }
  }
  function flushDraw() {
    rafId = 0;
    var s = S.live; if (!s || (s.points.length <= drawnIdx && s.tool !== 'highlighter')) return;
    drawLive(drawnIdx);
    drawnIdx = s.points.length;
  }
  function liveLayer(tool) {
    lctx.clearRect(0, 0, lc.width, lc.height);
    lc.style.opacity = tool === 'highlighter' ? '0.35' : tool === 'pencil' ? '0.92' : '1';
    lc.style.webkitMaskImage = ''; lc.style.maskImage = '';
  }

  /* ---------- ページをめくる ----------
     指で左右になぞると、紙がめくれて、下からめくる先のページが見えてくる。
     - 縦画面: 左の端でとじたノートのように、今のページが左へめくれる（戻るときは前のページが左から戻ってくる）
     - 横画面（見開き）: 真ん中の背を軸に、右のページが左へ（戻るときは左のページが右へ）めくれる
     半分以上めくるか、さっと払うと、そのページへ移る。途中で離すと元に戻る */
  var T = null, turning = false;
  function div(cls, parent) { var d = document.createElement('div'); d.className = cls; parent.appendChild(d); return d; }
  function boxOf(node) { return { x: node.offsetLeft, y: node.offsetTop, w: node.offsetWidth, h: node.offsetHeight }; }
  function place(node, b) { node.style.left = b.x + 'px'; node.style.top = b.y + 'px'; node.style.width = b.w + 'px'; node.style.height = b.h + 'px'; }
  function fillFace(box, n) {
    var c = faceOf(n);
    if (c) { box.appendChild(c); return; }
    getBase(n).then(function (b) { if (box.isConnected && !box.querySelector('canvas')) box.appendChild(compose(n, b)); }, function () {});
  }
  function startTurn(dir) {
    if (T || turning || !canStep(dir)) return null;
    var t = { dir: dir, dest: stepPage(dir), t: 0 };
    var wb = boxOf(wrap), sb = st && !still.hidden ? boxOf(still) : null, box, front, back = 0, under = null, origin;
    if (!S.spread) {
      box = wb; origin = 'left';
      if (dir > 0) { front = S.page; under = { b: wb, n: t.dest }; t.a0 = 0; t.a1 = -180; }
      else { front = t.dest; t.a0 = -180; t.a1 = 0; }
    } else {
      var actR = !isLeft(S.page), Lb = actR ? sb : wb, Rb = actR ? wb : sb, L = leftOf(S.page);
      if (dir > 0 ? !Rb : !Lb) return null;
      // 進む: 右のページ(L+1)がめくれ、裏に次の左(L+2)、下に次の右(L+3)。戻る: 左のページ(L)がめくれ、裏に前の右(L-1)、下に前の左(L-2)
      if (dir > 0) { box = Rb; origin = 'left'; front = L + 1; back = L + 2; under = { b: Rb, n: L + 3 <= S.total ? L + 3 : 0 }; t.a0 = 0; t.a1 = -180; }
      else { box = Lb; origin = 'right'; front = L; back = L - 1; under = { b: Lb, n: L - 2 >= 1 ? L - 2 : 0 }; t.a0 = 0; t.a1 = 180; }
    }
    turnEl.textContent = '';
    if (under) {
      t.u = div('tu' + (under.n ? '' : ' none'), turnEl); place(t.u, under.b);
      t.u.style.setProperty('--gd', origin === 'left' ? '90deg' : '270deg');
      if (under.n) fillFace(t.u, under.n);
    }
    t.lf = div('lf', turnEl); place(t.lf, box);
    t.lf.style.transformOrigin = origin === 'left' ? '0 50%' : '100% 50%';
    t.fF = div('fc', t.lf); t.fB = div('fc bk' + (back ? '' : ' blank'), t.lf);
    fillFace(t.fF, front); if (back) fillFace(t.fB, back);
    var sx = origin === 'left' ? box.x : box.x + box.w;
    turnEl.style.perspectiveOrigin = sx + 'px ' + (stage.scrollTop + stage.clientHeight / 2 - flow.offsetTop) + 'px';
    turnEl.classList.add('on');
    // めくれ具合の決め方: 縦画面は、見えている半分（右側）だけを使う。紙の端が指についてくる
    t.W = Math.min(box.w, stage.clientWidth);
    t.mode = S.spread ? 'spread' : dir > 0 ? 'fwd' : 'back';
    t.rest = t.mode === 'back' ? 0.5 : 0;                       // 戻すときの位置（縦画面で戻るときは、背に立った状態＝見えない）
    t.go = t.mode === 'fwd' ? 0.24 : t.mode === 'back' ? 0.6 : 0.3; // ここを越えて離したら、めくる
    t.t = t.rest;
    T = t; turning = true;
    drawTurn();
    return t;
  }
  function drawTurn() {
    var t = T, a = t.a0 + (t.a1 - t.a0) * t.t, back = Math.abs(a) > 90;
    t.lf.style.transform = 'rotateY(' + a.toFixed(2) + 'deg)';
    t.fF.style.visibility = back ? 'hidden' : '';
    t.fB.style.visibility = back ? '' : 'hidden';
    t.lf.style.setProperty('--sh', (0.1 * Math.sin(Math.abs(a) * Math.PI / 180)).toFixed(3)); // 立っているほど少し暗く
    if (t.u) t.u.style.setProperty('--sh', (0.32 * (1 - t.t)).toFixed(3));              // めくっている紙の影
  }
  // 指の動きから、めくれ具合を決める（紙の端が指についてくるように）
  function turnFollow(dx) {
    var p = Math.max(0, -dx * T.dir), W = T.W, c;
    if (T.mode === 'fwd') { c = Math.max(0, 1 - 1.3 * p / W); T.t = Math.acos(c) / Math.PI; }
    else if (T.mode === 'back') { c = Math.min(1, 1.3 * p / W); T.t = 1 - Math.acos(c) / Math.PI; }
    else { c = Math.max(-1, 1 - 1.8 * p / W); T.t = Math.acos(c) / Math.PI; }
    drawTurn();
  }
  /* 指を離したあとの続き。vt: 離したときのめくれる速さ（1ミリ秒あたりの t）
     - 指で勢いよく払った: その速さのまま続けて、だんだんゆっくり止まる（速く払えば速くめくれる）
     - ボタン・引っぱり・ゆっくり離した: 紙がめくれていく様子が見える速さで */
  function settleTurn(go, vt) {
    var t = T; if (!t || t.anim) return;
    t.anim = true;
    var from = t.t, to = go ? 1 : t.rest, d = Math.abs(to - from), t0 = performance.now(), dur, ease;
    var auto = vt === undefined;
    if (go && t.fast) {
      dur = Math.max(70, 180 - 20 * t.fast);                 // 小口を押さえたままの連続めくり: だんだん速く
      ease = function (k) { return k; };
    } else if (go && vt > 0.0005) {
      dur = Math.max(60, Math.min(180, 1.0 * d / vt));          // 指の速さの倍で始まり、減速して止まる
      ease = function (k) { return 1 - (1 - k) * (1 - k); };
    } else if (go && auto) {
      dur = 80 + 150 * d;                                    // 全部めくって 0.23秒くらい
      ease = function (k) { return k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k); }; // ゆっくり始まって、ゆっくり止まる
    } else {
      dur = 70 + 140 * d;
      ease = function (k) { return 1 - (1 - k) * (1 - k); };
    }
    var y0 = stage.scrollTop, y1 = go && !S.spread ? 0 : y0; // 縦画面では、次のページの上の端から
    t.step = function step(now) {
      if (t.done) return;
      var k = t.rush ? 1 : Math.min(1, (now - t0) / dur), e = ease(k);
      t.t = from + (to - from) * e; drawTurn();
      if (y1 !== y0) stage.scrollTop = y0 + (y1 - y0) * e;
      if (k < 1) { requestAnimationFrame(step); return; }
      t.done = true;
      if (!go) { closeTurn(); return; }
      // めくった先へ。めくってきた絵を出したまま入れかえるので、見た目はつながる
      S.placeholder = baseNow(t.dest);
      S.swap = closeTurn;
      turning = false; // goPage を通すため（置きかえが済むまでは T が残っている）
      Promise.resolve(goPage(t.dest, true)).catch(function () {}).then(function () { if (T === t) closeTurn(); });
    };
    requestAnimationFrame(t.step);
  }
  // めくっている最中に次の操作が来たら、今のめくりをその場で終わらせる
  function rushTurn() { if (T && T.anim && !T.done) { T.rush = true; T.step(performance.now()); } }
  function closeTurn() {
    T = null; turning = false; turnEl.classList.remove('on'); turnEl.textContent = '';
    if (rapid) requestAnimationFrame(rapidNext); // 小口を押さえたまま: 次々めくる
    else if (pan && pan.want) requestAnimationFrame(chainTurn); // 次のめくりを待っている指がある
    else if (queued) { var d = queued > 0 ? 1 : -1; queued -= d; requestAnimationFrame(function () { if (startTurn(d)) settleTurn(true); else queued = 0; }); }
  }
  /* 続けてめくる: めくっている最中に、また指で払ったとき。
     今のめくりを終わらせて、ページが入れかわりしだい、次のめくりを指につける */
  var queued = 0; // 入れかわる前に払った回数（進む: +、戻る: -）
  /* 小口を長押し: 押さえている間、次々にページがめくれる（だんだん速く）。軽くたたくと1ページ */
  var rapid = null, EDGE_HOLD = 250;
  function rapidNext() {
    if (!rapid || T || turning) return;
    var t = startTurn(rapid.dir);
    if (!t) { rapid = null; return; } // 端まで来た
    t.fast = ++rapid.n;
    settleTurn(true);
  }
  [edgeL, edgeR].forEach(function (el) {
    var hold = null;
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      if (hold || !S.hasFile) return;
      try { el.setPointerCapture(e.pointerId); } catch (er) {}
      var dir = +el.dataset.dir;
      el.classList.add('press');
      hold = { id: e.pointerId, dir: dir, timer: setTimeout(function () {
        hold.long = true;
        rapid = { dir: dir, n: 0 };
        if (T) rushTurn(); else rapidNext();
      }, EDGE_HOLD) };
    });
    function up(e) {
      if (!hold || e.pointerId !== hold.id) return;
      clearTimeout(hold.timer); el.classList.remove('press');
      if (!hold.long && e.type === 'pointerup') { if (T || turning) queued += hold.dir; else autoTurn(hold.dir); }
      hold = null; rapid = null;
    }
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  });
  function chainTurn() {
    if (!pan || !pan.want || pan.turn || T || turning) return;
    var dir = pan.want;
    if (startTurn(dir)) { pan.want = 0; pan.turn = { x0: pan.x0, hist: [] }; if (pan.last) turnMove(pan.last); }
    else pan.want = 0;
  }
  // ボタンや引っぱりから: 自動でめくる
  function autoTurn(dir) { if (startTurn(dir)) settleTurn(true); }

  /* ---------- 上下に引っぱってページを移る ----------
     ページの下の端で、さらに指を上へ引っぱる → 次のページ（最後のページなら、同じページを追加）
     ページの上の端で、さらに指を下へ引っぱる → 前のページ（どちらも、めくって移る） */
  var pullEl = $('pull'), PULL_MAX = 150, PULL_READY = 64;
  function pullKind(dir) { return dir > 0 ? (canStep(1) ? 'next' : 'add') : (canStep(-1) ? 'prev' : null); }
  var PULL_TEXT = {
    next: ['引っぱると次のページ', '離すと次のページへ'],
    add: ['引っぱるとページを追加', '離すとページを追加'],
    prev: ['引っぱると前のページ', '離すと前のページへ']
  };
  function setFlow(y) { flow.style.transform = y ? 'translateY(' + y + 'px)' : ''; }
  // pull: 引っぱった量（正: 上へ、負: 下へ）。紙をゴムのように少し動かし、案内を出す
  function showPull(p) {
    var off = (p > 0 ? 1 : -1) * Math.min(PULL_MAX, Math.abs(p) * 0.5);
    setFlow(p ? -off : 0);
    var kind = p ? pullKind(p) : null;
    if (!kind) { pullEl.className = ''; return null; }
    var ready = Math.abs(off) >= PULL_READY;
    pullEl.className = 'show ' + kind + (p < 0 ? ' top' : '') + (ready ? ' ready' : '');
    pullEl.style.setProperty('--k', Math.min(1, Math.abs(off) / PULL_READY).toFixed(2));
    setText($('pullText'), PULL_TEXT[kind][ready ? 1 : 0]);
    return ready ? kind : null;
  }
  function panMove(e) {
    if (pan.turn) { turnMove(e); return; }
    if (pan.want) { pan.last = e; chainTurn(); return; } // 入れかわりを待っている
    if (!pan.axis) {
      // 動き始めの向きで決める: 横 → (端なら) めくる / 縦 → スクロール
      var ax = e.clientX - pan.x0, ay = e.clientY - pan.y0;
      if (Math.hypot(ax, ay) < 10) return;
      pan.axis = Math.abs(ax) > Math.abs(ay) ? 'x' : 'y';
      var busy = !!T;
      if (busy) rushTurn(); // 前のめくりが終わっていなければ、すぐ終わらせる
      if (pan.axis === 'x') {
        var dir = ax < 0 ? 1 : -1;
        if (busy && (dir > 0 ? pan.atR : pan.atL) && (T || turning)) { pan.want = dir; pan.last = e; return; }
        if ((dir > 0 ? pan.atR : pan.atL) && startTurn(dir)) {
          pan.turn = { x0: pan.x0, hist: [] };
          turnMove(e); return;
        }
      }
    }
    var dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    pan.x = e.clientX; pan.y = e.clientY;
    stage.scrollLeft -= dx;
    var want = -dy; // 正: 下へスクロールしたい
    if (pan.pull) { // 引っぱっている最中は、まず引っぱりを戻す
      var np = pan.pull + want;
      if ((pan.pull > 0) !== (np > 0) || np === 0) { want = np; pan.pull = 0; } else { pan.pull = np; want = 0; }
    }
    if (want) {
      var before = stage.scrollTop;
      stage.scrollTop += want;
      var rest = want - (stage.scrollTop - before); // 端まで来て、スクロールしきれなかった分
      if ((rest > 0.5 && pan.atB) || (rest < -0.5 && pan.atT)) pan.pull += rest;
    }
    if (pan.pull || pan.ready !== undefined) pan.ready = showPull(pan.pull);
  }
  function turnMove(e) {
    var g = pan.turn, now = performance.now();
    if (T && !T.anim) turnFollow(e.clientX - g.x0);
    g.hist.push([now, e.clientX, T ? T.t : 0]); while (g.hist.length > 8) g.hist.shift();
  }
  // 指を離したとき: 半分以上めくったか、めくる向きにさっと払っていれば移る
  function turnUp(g, cancel) {
    if (!T || T.anim) return;
    if (cancel) { settleTurn(false); return; }
    // 離す直前（0.1秒）の動きから、指の速さ（px/ms）と、めくれる速さ（t/ms）を出す
    var h = g.hist, now = performance.now(), v = 0, vt = 0;
    var r = h.filter(function (x) { return now - x[0] < 100; });
    if (r.length > 1) {
      var a = r[0], b = r[r.length - 1], dt = Math.max(8, b[0] - a[0]);
      v = (b[1] - a[1]) / dt * -T.dir; vt = (b[2] - a[2]) / dt;
    }
    var go = v > 0.25 ? T.t > T.rest + 0.01 : v < -0.3 ? false : T.t > T.go;
    // 払った速さが紙の動きより速いとき（指が紙より先に行った）は、指の速さで続ける
    if (go && v > 0.25) vt = Math.max(vt, v / (T.W * (T.mode === 'spread' ? 1.1 : 1.6)));
    settleTurn(go, vt);
  }
  function settle() { setTimeout(function () { flow.style.transition = ''; }, 460); }
  function endPull(p, cancel) {
    var kind = cancel ? null : p.ready;
    pullEl.classList.remove('show', 'ready');
    flow.style.transition = 'transform .32s cubic-bezier(.2,1.3,.4,1)';
    if (kind === 'add') { addTurn(); return; }
    setFlow(0); settle();
    if (kind) autoTurn(kind === 'prev' ? -1 : 1);
  }
  // 最後のページで引っぱったとき: ページを足して、にゅっと出す
  function addTurn() {
    var h = stage.clientHeight;
    turning = true;
    flow.style.transition = 'transform .18s ease-in, opacity .18s ease-in';
    setFlow(-h * 0.5); flow.style.opacity = '0';
    setTimeout(function () {
      flow.style.transition = 'none';
      turning = false;
      var done = insertPage('same');
      turning = true;
      flow.style.transform = 'translateY(' + (h * 0.45) + 'px) scale(.9)';
      Promise.resolve(done).catch(function () {}).then(function () {
        void flow.offsetWidth; // 置いた位置を確定させてから動かす
        flow.style.transition = 'transform .46s cubic-bezier(.2,1.25,.35,1), opacity .2s ease-out';
        setFlow(0); flow.style.opacity = '';
        turning = false; settle();
      });
    }, 180);
  }

  /* 指1本を離したとき: 2回タップ → 拡大・元に戻す */
  var lastTap = null;
  function fingerUp(p, e) {
    var dx = e.clientX - p.x0, dy = e.clientY - p.y0, dt = performance.now() - p.t0;
    if (dt < 300 && Math.hypot(dx, dy) < 12) {
      var now = performance.now();
      if (lastTap && now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
        lastTap = null;
        var rc = flow.getBoundingClientRect();
        S.anchor = { fx: (e.clientX - rc.left) / rc.width, fy: (e.clientY - rc.top) / rc.height, cx: e.clientX, cy: e.clientY };
        setZoom(Math.abs(S.zoom - 1) < 0.01 ? 2 : 1);
        return;
      }
      lastTap = { t: now, x: e.clientX, y: e.clientY };
    } else lastTap = null;
  }

  function onInkDown(e) {
    if (!S.hasFile) return;
    e.preventDefault();
    // 指はスクロール・ページめくり・拡大縮小に使う（書くのはペンだけ）
    if (e.pointerType === 'touch') {
      if (drawing || performance.now() - lastPenUp < 500) { // 手のひらの接触は無視
        dbg('指#' + e.pointerId + ' 無視（' + (drawing ? 'ペンで書いている最中' : 'ペンを離した直後') + '）');
        return;
      }
      if (turning && !(T && T.anim)) return; // めくっている最中の指は、続けてめくれるように受け付ける
      // 投げ縄で選んだもの・貼った画像は、指でもつかんで動かせる
      var gh = tools[S.tool];
      if (gh && gh.grab && !Object.keys(touches).length) {
        S.rc = ink.getBoundingClientRect();
        if (gh.grab(pos(e), e)) {
          drawing = { id: e.pointerId, h: gh, touch: true };
          ink.setPointerCapture(e.pointerId);
          return;
        }
      }
      touches[e.pointerId] = { x: e.clientX, y: e.clientY };
      ink.setPointerCapture(e.pointerId);
      var n = Object.keys(touches).length;
      dbg('指#' + e.pointerId + ' 接触 → ' + (n === 1 ? 'スクロール扱い' : n === 2 ? 'ピンチ扱い' : n + '本目'));
      if (n === 1) {
        pan = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(),
          // 払う前に、横スクロールが端まで来ていたか（端なら、払うとページをめくる）
          atL: stage.scrollLeft <= 1, atR: stage.scrollLeft >= stage.scrollWidth - stage.clientWidth - 1,
          // 縦も同じ: 端まで来てから引っぱると、ページを移る
          atT: stage.scrollTop <= 1, atB: stage.scrollTop >= stage.scrollHeight - stage.clientHeight - 1, pull: 0 };
      }
      else if (n === 2) {
        rushTurn();
        if (pan && pan.turn) turnUp(pan.turn, true);
        else if (pan && pan.pull) endPull(pan, true);
        pan = null; startPinch();
      }
      return;
    }
    if (turning) return; // ページを移っている最中は書かない
    if (drawing) { dbg('!! ペン#' + e.pointerId + ' 無視（前の線#' + drawing.id + 'が終わっていない）'); return; }
    dbg('ペン#' + e.pointerId + '(' + e.pointerType + ') 書き始め' + (Object.keys(touches).length ? '（指' + Object.keys(touches).length + '本を解除）' : ''));
    if (pan && pan.pull) endPull(pan, true);
    pan = null; touches = {}; if (pinch) cancelPinch();
    ink.setPointerCapture(e.pointerId);
    S.rc = ink.getBoundingClientRect(); // 書き始めに1回だけ取得
    var pt = pos(e);
    var h = tools[S.tool];
    if (h) { drawing = { id: e.pointerId, h: h }; h.down(pt, e); return; }
    if (S.tool === 'eraser') { drawing = { id: e.pointerId, erase: true }; erased = false; eraseAt(pt); return; }
    if (!PENS[S.tool]) return;
    S.live = { tool: S.tool, color: S.color, width: S.width, points: [pt] };
    drawing = { id: e.pointerId, start: pt };
    drawnIdx = 1;
    if (S.tool !== 'pen') liveLayer(S.tool);
    drawLive(0);
  }
  ink.addEventListener('pointerdown', onInkDown);
  // 見開きのもう片方（絵）: ペンが触れたら、そのページを書ける紙にしてそのまま書き始める。指はふつうに扱う
  still.addEventListener('pointerdown', function (e) {
    if (!S.hasFile || !st) return;
    e.preventDefault();
    if (e.pointerType !== 'touch') {
      if (drawing || turning) return;
      if (!activate(st.n)) return;
    }
    onInkDown(e);
  });
  still.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  ink.addEventListener('pointermove', function (e) {
    if (touches[e.pointerId]) {
      touches[e.pointerId].x = e.clientX; touches[e.pointerId].y = e.clientY;
      if (pinch && Object.keys(touches).length === 2) { movePinch(); return; }
    }
    if (pan && e.pointerId === pan.id) { panMove(e); return; }
    if (!drawing || e.pointerId !== drawing.id) return;
    e.preventDefault();
    var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (!evs.length) evs = [e];
    if (drawing.h) { evs.forEach(function (ev) { drawing.h.move(pos(ev), ev); }); return; }
    if (drawing.erase) { evs.forEach(function (ev) { eraseAt(pos(ev)); }); return; }
    var s = S.live;
    if (s.tool === 'highlighter') {
      s.points = straight(drawing.start, pos(evs[evs.length - 1]));
      if (!rafId) rafId = requestAnimationFrame(flushDraw);
      return;
    }
    evs.forEach(function (ev) {
      var pt = pos(ev), last = s.points[s.points.length - 1];
      if (Math.hypot((pt[0] - last[0]) * S.cssW, (pt[1] - last[1]) * S.cssH) > 0.6) s.points.push(pt);
    });
    if (s.points.length > drawnIdx && !rafId) rafId = requestAnimationFrame(flushDraw);
  });
  function endPointer(e) {
    if (touches[e.pointerId]) {
      dbg('指#' + e.pointerId + ' ' + (e.type === 'pointercancel' ? '取り消し' : '離す'));
      delete touches[e.pointerId];
      if (pinch) endPinch();
      if (pan && pan.id === e.pointerId) {
        if (pan.turn) turnUp(pan.turn, e.type !== 'pointerup');
        else if (pan.want) { if (e.type === 'pointerup') { if (T || turning) queued += pan.want; else autoTurn(pan.want); } } // 入れかわる前に離した: そのままめくる
        else if (pan.pull || pan.ready) endPull(pan, e.type !== 'pointerup');
        else if (e.type === 'pointerup') fingerUp(pan, e);
        pan = null;
      }
      return;
    }
    if (!drawing || e.pointerId !== drawing.id) return;
    dbg('ペン#' + e.pointerId + ' ' + (e.type === 'pointercancel' ? '!! 取り消し（OSに中断された）' : '離す') +
      (S.live ? '（' + S.live.points.length + '点）' : ''));
    if (drawing.h) {
      var h = drawing.h, byFinger = drawing.touch; drawing = null;
      if (!byFinger) lastPenUp = performance.now();
      h.up(e);
      return;
    }
    if (!drawing.erase && S.live) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      flushDraw();
      var s = S.live;
      // 図形モード: 手書きの丸・四角・三角・直線を、きれいな図形に直す
      if (S.shape && s.tool !== 'highlighter' && window.Shapes) {
        var fixed = Shapes.recognize(s.points, S.cssW, S.cssH);
        if (fixed) s.points = fixed;
      }
      pushUndo();
      (S.strokes[S.page] = S.strokes[S.page] || []).push(s);
      S.live = null;
      if (s.tool !== 'pen') { lctx.clearRect(0, 0, lc.width, lc.height); liveLayer('pen'); }
      if (s.tool === 'pen' && !fixed) drawItem(ictx, s, ink.width, ink.height);
      else drawInk();
      updateUI(); scheduleSave(); emit('data');
    }
    drawing = null;
    lastPenUp = performance.now();
  }
  ink.addEventListener('pointerup', endPointer);
  ink.addEventListener('pointercancel', endPointer);
  ink.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  // iPadのスクリブル等がペン入力を横取りしないように、手書き面での標準タッチ動作を止める。
  // touchmove だけで止める。touchstart/touchend でも止めると、スクリブルとぶつかって
  // 数秒〜長時間ペンが効かなくなった（2026-11-03 iPadで確認。ユーザー了承のうえ外した）。
  // スクロール・拡大・文字選択・長押しメニューは CSS（touch-action / user-select / touch-callout）で防いでいる
  ink.addEventListener('touchmove', function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false });
  // 紙のまわりの余白でも同じ（ボタンが並ぶ上部 header には付けない）
  stage.addEventListener('touchmove', function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false });
  if (DEBUG) {
    // OSから届いたタッチの種類（stylus=ペン, direct=指）。preventDefault の処理とは別に記録だけする
    ink.addEventListener('touchstart', function (e) {
      var types = Array.prototype.map.call(e.changedTouches, function (t) { return t.touchType || '?'; });
      dbg('touchstart ' + types.join(',') + '（画面上の接触 計' + e.touches.length + '）' + (e.cancelable ? '' : ' !! 止められない'));
    }, { passive: true });
  }

  /* ---------- JSONダイアログ ---------- */
  function openJson() {
    if (!S.hasFile) { setStatus('先にPDFを開いてください'); return; }
    // 文字入力欄はページに常に置かず、開いたときだけ作る（スクリブルが反応しにくくなるように）
    var ta = document.createElement('textarea');
    ta.id = 'json'; ta.spellcheck = false;
    ta.value = JSON.stringify(exportData());
    $('jsonSlot').appendChild(ta);
    $('dlgMsg').textContent = '';
    $('dlg').classList.add('open');
  }
  $('closeDlg').onclick = function () {
    $('dlg').classList.remove('open');
    $('jsonSlot').textContent = '';
  };
  $('copyJson').onclick = function () {
    var ta = $('json'); ta.focus(); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    if (!ok && navigator.clipboard) {
      navigator.clipboard.writeText(ta.value).then(
        function () { $('dlgMsg').textContent = 'コピーしました'; },
        function () { $('dlgMsg').textContent = '自動コピーできませんでした。選択された文字列を長押ししてコピーしてください'; });
      return;
    }
    $('dlgMsg').textContent = ok ? 'コピーしました' : '自動コピーできませんでした。選択された文字列を長押ししてコピーしてください';
  };
  $('importJson').onclick = function () {
    try {
      var res = parseData(JSON.parse($('json').value));
      if (!res) throw new Error('bad');
      applyData(res);
      renderPage(); updateUI(); scheduleSave(); emit('layout'); emit('data');
      $('dlgMsg').textContent = '読み込みました';
    } catch (e) { $('dlgMsg').textContent = '読み込めませんでした。JSONの形式を確認してください'; }
  };

  /* ---------- 画面サイズ変更 ---------- */
  var rt = null;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { if (S.hasFile && stage.clientWidth !== lastStageW) renderPage(); }, 200);
  });
  updateUI();

  /* Drive連携・道具・ページ一覧など、ほかのファイルから使う入口 */
  window.App = {
    S: S, on: on, emit: emit, tools: tools,
    openDoc: openDoc, setStatus: setStatus, dbg: dbg, hooks: hooks,
    drawInk: drawInk, drawList: drawList, renderPage: renderPage, renderThumb: renderThumb,
    goPage: goPage, updateUI: updateUI, pushUndo: pushUndo, commit: commit,
    scheduleSave: scheduleSave, flushSave: flushSave, exportData: exportData,
    setTool: setTool, insertPage: insertPage, deletePage: deletePage, addImage: addImage,
    setShift: setShift,
    pageEntry: entry, paperLines: paperLines, openJson: openJson, liveCtx: lctx, liveCanvas: lc, wrap: wrap, stage: stage,
    blank: function () { openDoc(null, '白紙', 'strokes:__blank__'); },
    currentKey: function () { return S.hasFile ? S.key : ''; },
    hasStrokes: function () { for (var k in S.strokes) if (S.strokes[k].length) return true; return false; },
    exportJson: function () { return JSON.stringify(exportData()); },
    // 外から受け取った手書きデータで置き換える（取り消し履歴は消える）
    replaceData: function (obj) {
      var res = parseData(obj); if (!res) return false;
      if (drawing) return false;
      applyData(res);
      if (st) st.n = -1; // 見開きのもう片方も描き直す
      clearTimeout(saveTimer); saveTimer = null;
      renderPage(); updateUI(); doSave(true); emit('layout'); emit('data');
      return true;
    }
  };
})();
