/* ページ一覧（左のサイドバー）と、PDFの中の文字の検索 */
(function () {
  'use strict';
  var App = window.App, S = App.S;
  var $ = function (id) { return document.getElementById(id); };
  var thumbs = $('thumbs'), side = $('sidebar');
  var THUMB_W = 132;

  /* ---------- ページ一覧 ---------- */
  var sideOpen = false, dirty = {}, queue = [], running = false, observer = null, built = false, startAt = 0;

  function runQueue() {
    if (running) return;
    // 一覧が滑り出している間は描かない（動きがカクカクしないように）
    var wait = startAt - performance.now();
    if (wait > 0) { setTimeout(runQueue, wait + 10); return; }
    var job = queue.shift(); if (!job) return;
    running = true;
    App.renderThumb(job.canvas, job.n, THUMB_W).catch(function (e) { console.error(e); })
      .then(function () { job.el.classList.add('ready'); running = false; runQueue(); });
  }
  function request(el) {
    var n = +el.dataset.n;
    if (queue.some(function (j) { return j.el === el; })) return;
    queue.push({ el: el, n: n, canvas: el.querySelector('canvas') });
    runQueue();
  }
  function build() {
    if (observer) observer.disconnect();
    queue = []; thumbs.textContent = '';
    if (!S.hasFile) return;
    built = true;
    observer = new IntersectionObserver(function (ents) {
      ents.forEach(function (en) {
        if (en.isIntersecting && !en.target.dataset.done) { en.target.dataset.done = '1'; request(en.target); }
      });
    }, { root: side, rootMargin: '300px 0px' });
    for (var n = 1; n <= S.total; n++) {
      var el = document.createElement('button');
      el.className = 'thumb'; el.dataset.n = n;
      el.innerHTML = '<span class="paper"><canvas></canvas></span><span class="num">' + n + '</span>';
      var e = App.pageEntry(n);
      el.querySelector('.paper').style.aspectRatio = e.src > 0 ? '' : (e.w + ' / ' + e.h);
      thumbs.appendChild(el);
      observer.observe(el);
    }
    mark();
  }
  function mark() {
    thumbs.querySelectorAll('.thumb').forEach(function (t) { t.classList.toggle('on', +t.dataset.n === S.page); });
    var cur = thumbs.querySelector('.thumb.on');
    if (cur && sideOpen) {
      var r = cur.getBoundingClientRect(), sr = side.getBoundingClientRect();
      if (r.top < sr.top || r.bottom > sr.bottom) cur.scrollIntoView({ block: 'center' });
    }
  }
  function refreshDirty() {
    Object.keys(dirty).forEach(function (n) {
      var el = thumbs.querySelector('.thumb[data-n="' + n + '"]');
      if (el && el.dataset.done) request(el);
    });
    dirty = {};
  }
  // 一覧は紙の上に重ねて出す（紙の大きさは変えない）。一度作った小さな絵は使い回す
  function setSide(v) {
    sideOpen = v;
    if (v) {
      startAt = performance.now() + 320;
      if (!built) build(); else { mark(); refreshDirty(); }
    }
    document.body.classList.toggle('side-open', v);
    $('sideBtn').classList.toggle('on', v);
  }
  $('sideBtn').addEventListener('click', function () {
    if (bk.suppress) { bk.suppress = false; return; }
    if (!S.hasFile) { App.setStatus('先にPDFを開いてください'); return; }
    setSide(!sideOpen);
  });
  thumbs.addEventListener('click', function (e) {
    if (bk.suppress) { bk.suppress = false; return; }
    var t = e.target.closest('.thumb'); if (t) App.goPage(+t.dataset.n);
  });
  var dt = null;
  App.on('data', function () {
    dirty[S.page] = 1;
    if (!sideOpen) return;
    clearTimeout(dt); dt = setTimeout(refreshDirty, 900);
  });
  App.on('page', function () { if (sideOpen) mark(); showMarks(); });
  App.on('layout', function () { built = false; if (sideOpen) build(); });
  App.on('open', function () { textCache = {}; query = ''; clearMarks(); built = false; if (sideOpen) build(); });

  /* ---------- 長押しで出る「本の小口」でパラパラめくる ----------
     ページ一覧のボタンや小さな絵を長押しすると、本を横から見たような画面になる。
     開いている見開き（2ページ）は半分ずつ、ほかのページは端（小口）だけが少し見える。
     指でなぞるとパラパラめくれて、指を離したらそのページへ移る */
  var book = $('book'), stage = $('bookStage'), edge = $('bookEdge');
  var bk = {
    on: false, f: 1, show: 1, intro: 1, introAt: 0, raf: 0, leaves: {}, g: null,
    W: 300, H: 420, top: 0, cx: 0, sw: 0, cache: {}, order: [], busy: false, closing: 0, suppress: false
  };
  var BK_KEEP = 40;

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function pageAspect() {
    var w = $('wrap');
    return (w && w.offsetWidth && w.offsetHeight) ? w.offsetWidth / w.offsetHeight : 0.707;
  }
  /* 本のしくみ: どのページも真ん中の「背」でとじてある。
     開いている見開きは手前に起き上がっていて（真正面からは半分くらいの幅に見える）、
     その下のページは少しずつ寝ていくので、外側の端（小口）だけが重なって見える。
     ページ i の位置 s = i - f - 0.5（マイナスは左側）から、背からの角度 θ を決める。
     θ: 0° = 右に寝ている、90° = まっすぐ立っている、180° = 左に寝ている */
  function edgeFrac(a) { return 1 - 0.5 * Math.exp(-0.1 * (a - 0.5)); } // 正面から見える幅（ページの幅に対する割合）
  function leafAngle(s) {
    var as = Math.abs(s);
    if (as < 0.5) return 90 - 60 * s;                 // めくっている途中のページ（背を軸に回る）
    var th = Math.acos(edgeFrac(as)) * 180 / Math.PI;  // 開いた見開きは60°、下のページほど寝ていく
    return s > 0 ? th : 180 - th;
  }
  function measure() {
    var r = stage.getBoundingClientRect();
    bk.sw = r.width; bk.cx = r.width / 2;
    var a = pageAspect();
    var H = Math.max(120, r.height * 0.68), W = H * a;
    if (W > r.width * 0.4) { W = r.width * 0.4; H = W / a; }
    bk.W = W; bk.H = H; bk.top = Math.max(6, (r.height - H) / 2);
  }

  /* 小さな絵: 開いているあたりから順に描く。作ったものは取っておく */
  function bkCanvas(n) { return bk.cache[n] || null; }
  function bkDrop(n) {
    if (!bk.cache[n]) return;
    delete bk.cache[n]; bk.order = bk.order.filter(function (k) { return k !== n; });
  }
  function bkPump() {
    if (bk.busy || !bk.on) return;
    var c0 = Math.round(bk.show), want = 0;
    for (var d = 0; d <= 8 && !want; d++) {
      var list = d ? [c0 + d, c0 - d, c0 + d + 1] : [c0, c0 + 1];
      for (var j = 0; j < list.length; j++) {
        var n = list[j];
        if (n >= 1 && n <= S.total && !bk.cache[n]) { want = n; break; }
      }
    }
    if (!want) return;
    bk.busy = true;
    var c = document.createElement('canvas');
    App.renderThumb(c, want, Math.round(Math.min(bk.W, 230))).then(function () {
      bk.cache[want] = c; bk.order.push(want);
      while (bk.order.length > BK_KEEP) {
        var old = bk.order.shift();
        if (Math.abs(old - bk.show) < 6) { bk.order.push(old); break; } // 見えているものは捨てない
        delete bk.cache[old];
      }
      var el = bk.leaves[want];
      if (el) putCanvas(el, want);
    }).catch(function (e) { console.error(e); }).then(function () {
      bk.busy = false;
      if (bk.on) setTimeout(bkPump, 0);
    });
  }
  function putCanvas(el, n) {
    var c = bkCanvas(n);
    if (!c || c.parentNode === el) return;
    c.style.width = ''; c.style.height = '';
    el.insertBefore(c, el.firstChild);
    var ph = el.querySelector('.ph'); if (ph) ph.remove();
  }
  function makeLeaf(n) {
    var el = document.createElement('div');
    el.className = 'leaf'; el.dataset.n = n;
    if (bkCanvas(n)) putCanvas(el, n);
    else {
      var ph = document.createElement('span'); ph.className = 'ph'; ph.textContent = n;
      el.appendChild(ph);
    }
    stage.appendChild(el);
    return el;
  }

  /* 並べて描く（毎フレーム） */
  function layout() {
    var f = bk.show, u = bk.intro, W = bk.W, H = bk.H, cx = bk.cx;
    var used = {}, sel = clamp(Math.round(bk.f), 1, S.total);
    var lo = Math.max(1, Math.floor(f) - 34), hi = Math.min(S.total, Math.ceil(f) + 35);
    function place(i) {
      var sp = i - f - 0.5;
      var th = 90 + (leafAngle(sp) - 90) * u;          // 開くときは、立った本から広がる
      used[i] = 1;
      var el = bk.leaves[i] || (bk.leaves[i] = makeLeaf(i));
      var right = th <= 90;
      var lift = right ? th : 180 - th;                 // 寝た状態から何度起きているか
      el.style.width = W + 'px'; el.style.height = H + 'px';
      el.style.transformOrigin = right ? '0 50%' : '100% 50%';
      el.style.transform = 'translate3d(' + (right ? cx : cx - W) + 'px,' + bk.top + 'px,0) rotateY(' + (right ? -lift : lift) + 'deg)';
      el.style.zIndex = String(2000 - Math.round(Math.abs(sp) * 20));
      el.style.setProperty('--dir', right ? '270deg' : '90deg');
      el.style.setProperty('--ex', right ? '-1px' : '1px');
      var l = lift / 90;
      el.style.setProperty('--sh', (0.06 + 0.34 * l * l).toFixed(3));
      el.classList.toggle('mid', Math.abs(sp) < 1.5);
      el.classList.toggle('sel', i === sel && Math.abs(sp) < 1.5);
      var ph = el.firstChild && el.firstChild.className === 'ph' ? el.firstChild : null;
      if (ph) ph.style.opacity = Math.abs(sp) < 3 ? 1 : 0;
    }
    for (var i = lo; i <= hi; i++) place(i);
    // いちばん下（表紙・裏表紙側）のページは、遠くても敷いておく
    if (lo > 1) place(1);
    if (hi < S.total) place(S.total);
    Object.keys(bk.leaves).forEach(function (k) {
      if (!used[k]) { bk.leaves[k].remove(); delete bk.leaves[k]; }
    });
    $('bookNo').textContent = sel;
    $('bookOf').textContent = '/ ' + S.total + ' ページ';
    edge.querySelector('.mark').style.left = (S.total > 1 ? (bk.f - 1) / (S.total - 1) * 100 : 50) + '%';
    // 1枚めくれるごとに、紙の音
    var whole = Math.floor(f + 0.5);
    if (bk.lastWhole !== undefined && whole !== bk.lastWhole && bk.g) flick(Math.abs(whole - bk.lastWhole));
    bk.lastWhole = whole;
  }
  function tick() {
    bk.raf = 0;
    if (!bk.on) return;
    var now = performance.now();
    if (bk.intro < 1) { var t = clamp((now - bk.introAt) / 280, 0, 1); bk.intro = 1 - Math.pow(1 - t, 3); }
    var diff = bk.f - bk.show;
    bk.show += Math.abs(diff) < 0.003 ? diff : diff * 0.38;
    layout();
    bkPump();
    if (bk.intro < 1 || bk.show !== bk.f || bk.g) bk.raf = requestAnimationFrame(tick);
  }
  function kick() { if (!bk.raf) bk.raf = requestAnimationFrame(tick); }

  function bookOpen(n) {
    if (!S.hasFile || bk.on) return;
    clearTimeout(bk.closing);
    bk.on = true; bk.f = bk.show = clamp(n || S.page, 1, S.total);
    bk.intro = 0; bk.introAt = performance.now();
    book.classList.add('on'); document.body.classList.add('book-open');
    App.toolbar && App.toolbar.closePops && App.toolbar.closePops();
    measure();
    void book.offsetWidth; book.classList.add('show');
    kick();
  }
  function bookClose(go) {
    if (!bk.on) return;
    var n = clamp(Math.round(bk.f), 1, S.total);
    bk.on = false; bk.g = null;
    book.classList.remove('show'); document.body.classList.remove('book-open');
    if (go && n !== S.page) App.goPage(n);
    bk.closing = setTimeout(function () {
      book.classList.remove('on');
      stage.textContent = ''; bk.leaves = {}; bk.lastWhole = undefined;
    }, 200);
  }

  /* 紙をめくる音（とても小さく）。音のもとは、さわったときに作る（iPadの決まり） */
  var audio = null, noise = null, lastFlick = 0;
  function audioInit() {
    if (audio) { if (audio.state === 'suspended') audio.resume(); return; }
    try {
      var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      audio = new AC();
      var len = Math.round(audio.sampleRate * 0.05);
      noise = audio.createBuffer(1, len, audio.sampleRate);
      var d = noise.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    } catch (e) { audio = null; }
  }
  function flick(n) {
    if (!audio || audio.state !== 'running') return;
    var now = performance.now();
    if (now - lastFlick < 28) return; // 速くめくっているときは間引く
    lastFlick = now;
    try {
      var src = audio.createBufferSource(); src.buffer = noise;
      src.playbackRate.value = 0.8 + Math.random() * 0.5;
      var bp = audio.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2400 + Math.random() * 1600; bp.Q.value = 0.8;
      var g = audio.createGain(); g.gain.value = 0.22;
      src.connect(bp); bp.connect(g); g.connect(audio.destination);
      src.start();
    } catch (e) {}
  }

  /* なぞる */
  function pagePx() { return Math.max(12, bk.W * 0.06); }
  function gStart(e, mode) {
    audioInit();
    bk.g = { id: e.pointerId, mode: mode, x0: e.clientX, y0: e.clientY, f0: bk.f, moved: mode === 'abs', axis: null };
    if (mode === 'abs') absMove(e.clientX);
    kick();
  }
  function absMove(x) {
    var r = edge.getBoundingClientRect();
    bk.f = 1 + clamp((x - r.left) / r.width, 0, 1) * (S.total - 1);
    kick();
  }
  function gMove(e) {
    var g = bk.g; if (!g || e.pointerId !== g.id) return;
    e.preventDefault();
    if (g.mode === 'abs') { absMove(e.clientX); return; }
    var dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.axis) {
      if (Math.hypot(dx, dy) < 8) return;
      g.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'; g.moved = true;
      g.x0 = e.clientX; g.y0 = e.clientY; dx = dy = 0;
    }
    // 横: 指についてページが流れる（右へなぞると前のページ）。縦: 下へなぞると後ろのページ
    var df = g.axis === 'x' ? -dx / pagePx() : dy / pagePx();
    bk.f = clamp(g.f0 + df, 1, S.total);
    kick();
  }
  function gEnd(e, cancel) {
    var g = bk.g; if (!g || e.pointerId !== g.id) return;
    bk.g = null;
    if (cancel) { kick(); return; }
    if (g.moved) {
      bk.f = clamp(Math.round(bk.f), 1, S.total); kick();
      setTimeout(function () { bookClose(true); }, 120);
      return;
    }
    if (g.mode === 'press') return; // 長押ししただけ: 開いたままにして、なぞるのを待つ
    // タップ: 押したページへ。ページの外なら閉じる
    var hit = document.elementFromPoint(e.clientX, e.clientY);
    var leaf = hit && hit.closest && hit.closest('#bookStage .leaf');
    if (leaf) { bk.f = +leaf.dataset.n; kick(); setTimeout(function () { bookClose(true); }, 140); }
    else if (hit === stage) bookClose(false);
  }
  stage.addEventListener('pointerdown', function (e) { if (bk.on && !bk.g) { e.preventDefault(); gStart(e, 'rel'); } });
  edge.addEventListener('pointerdown', function (e) { if (bk.on && !bk.g) { e.preventDefault(); gStart(e, 'abs'); } });
  window.addEventListener('pointermove', gMove, { passive: false });
  window.addEventListener('pointerup', function (e) { gEnd(e, false); });
  window.addEventListener('pointercancel', function (e) { gEnd(e, true); });
  // なぞっている間は、画面がスクロールしないように
  document.addEventListener('touchmove', function (e) { if (bk.g || bk.on) e.preventDefault(); }, { passive: false });
  $('bookClose').addEventListener('click', function () { bookClose(false); });
  book.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  window.addEventListener('resize', function () { if (bk.on) { measure(); kick(); } });

  /* 長押し: ページ一覧のボタン・ページ一覧の小さな絵 */
  function longPress(el, pageOf) {
    var t = null, sx = 0, sy = 0;
    el.addEventListener('pointerdown', function (e) {
      bk.suppress = false;
      if (!S.hasFile || bk.on || (e.pointerType === 'mouse' && e.button !== 0)) return;
      sx = e.clientX; sy = e.clientY;
      var target = e.target, ev = e;
      audioInit();
      clearTimeout(t);
      t = setTimeout(function () {
        t = null; bk.suppress = true;
        bookOpen(pageOf(target));
        gStart(ev, 'press');
      }, 420);
    });
    el.addEventListener('pointermove', function (e) {
      if (t && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) { clearTimeout(t); t = null; }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (k) {
      el.addEventListener(k, function () { if (t) { clearTimeout(t); t = null; } });
    });
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }
  longPress($('sideBtn'), function () { return S.page; });
  longPress(side, function (target) {
    var th = target && target.closest && target.closest('.thumb');
    return th ? +th.dataset.n : S.page;
  });
  App.on('data', function () { bkDrop(S.page); });
  App.on('layout', function () { bk.cache = {}; bk.order = []; if (bk.on) bookClose(false); });
  App.on('open', function () { bk.cache = {}; bk.order = []; if (bk.on) bookClose(false); });
  App.bookOpen = bookOpen;

  /* ---------- 検索 ---------- */
  var textCache = {}, query = '', input = null, timer = null;
  // 全角の英数字を半角に、大文字を小文字にそろえる（文字数は変えない）
  function norm(s) {
    return String(s).replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/　/g, ' ').toLowerCase();
  }
  async function pageText(src) {
    if (textCache[src]) return textCache[src];
    var page = await S.pdf.getPage(src);
    var vp = page.getViewport({ scale: 1 });
    var tc = await page.getTextContent();
    var text = '', parts = [];
    tc.items.forEach(function (it) {
      if (typeof it.str !== 'string') return;
      var start = text.length;
      text += it.str;
      var tx = pdfjsLib.Util.transform(vp.transform, it.transform);
      var fh = Math.hypot(tx[2], tx[3]);
      parts.push({ s: start, e: text.length, x: tx[4], y: tx[5] - fh, w: it.width * vp.scale, h: fh, W: vp.width, H: vp.height });
      if (it.hasEOL) text += ' ';
    });
    return (textCache[src] = { text: norm(text), raw: text, parts: parts });
  }
  // 見つかった場所を、ページ上の四角（ページに対する割合）にする
  function rects(t, ms, me) {
    var out = [];
    t.parts.forEach(function (p) {
      if (p.e <= ms || p.s >= me || p.e === p.s) return;
      var len = p.e - p.s, a = Math.max(ms, p.s) - p.s, b = Math.min(me, p.e) - p.s;
      out.push({ x: (p.x + p.w * a / len) / p.W, y: p.y / p.H, w: p.w * (b - a) / len / p.W, h: p.h / p.H });
    });
    return out;
  }
  async function run() {
    var q = norm(input ? input.value : '').trim();
    query = q;
    var res = $('searchResults'), info = $('searchInfo');
    res.textContent = '';
    clearMarks();
    if (!q) { info.textContent = 'PDFの中の文字を探します（手書きの文字は探せません）'; return; }
    if (!S.pdf) { info.textContent = '白紙のノートには、探せる文字がありません'; return; }
    info.textContent = '探しています…';
    var count = 0, html = [];
    for (var n = 1; n <= S.total; n++) {
      var e = App.pageEntry(n);
      if (!(e.src > 0)) continue;
      var t;
      try { t = await pageText(e.src); } catch (err) { console.error(err); continue; }
      if (q !== query) return; // 入力が変わった
      var i = t.text.indexOf(q);
      while (i >= 0 && count < 200) {
        count++;
        var a = Math.max(0, i - 14), b = Math.min(t.raw.length, i + q.length + 24);
        html.push('<button class="hit" data-n="' + n + '"><span class="pn">' + n + 'ページ</span><span class="snip">' +
          esc(t.raw.slice(a, i)) + '<mark>' + esc(t.raw.slice(i, i + q.length)) + '</mark>' + esc(t.raw.slice(i + q.length, b)) + '</span></button>');
        i = t.text.indexOf(q, i + q.length);
      }
    }
    info.textContent = count ? count + '件見つかりました' + (count >= 200 ? '（最初の200件）' : '') : '見つかりませんでした（文字が画像になっているPDFは探せません）';
    res.innerHTML = html.join('');
    showMarks();
  }
  function esc(s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // 今のページで見つかった場所に、黄色い印をつける
  function clearMarks() { $('marks').textContent = ''; }
  async function showMarks() {
    clearMarks();
    if (!query || !S.pdf || !S.hasFile) return;
    var e = App.pageEntry(S.page); if (!(e.src > 0)) return;
    var q = query, t = await pageText(e.src);
    if (q !== query) return;
    var html = [], i = t.text.indexOf(q);
    while (i >= 0) {
      rects(t, i, i + q.length).forEach(function (r) {
        html.push('<i style="left:' + (r.x * 100) + '%;top:' + (r.y * 100) + '%;width:' + (r.w * 100) + '%;height:' + (r.h * 100) + '%"></i>');
      });
      i = t.text.indexOf(q, i + q.length);
    }
    $('marks').innerHTML = html.join('');
  }

  $('searchBtn').addEventListener('click', function (e) {
    if (!S.hasFile) { App.setStatus('先にPDFを開いてください'); return; }
    var pop = $('searchPop');
    App.toolbar.showPop(pop, e.currentTarget);
    if (!pop.classList.contains('open')) return;
    // 文字入力欄はページに常に置かず、開いたときだけ作る（スクリブル対策）
    if (!input) {
      input = document.createElement('input');
      input.type = 'search'; input.id = 'searchInput'; input.placeholder = 'PDFの中を検索';
      input.autocomplete = 'off'; input.spellcheck = false;
      input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 300); });
      input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { clearTimeout(timer); run(); input.blur(); } });
      $('searchSlot').appendChild(input);
      input.value = query;
    }
    if (!query) run();
    setTimeout(function () { input && input.focus(); }, 50);
  });
  $('searchResults').addEventListener('click', function (e) {
    var h = e.target.closest('.hit'); if (!h) return;
    App.goPage(+h.dataset.n);
    App.toolbar.closePops();
  });
  App.on('popClosed', function () {
    if (input && !$('searchPop').classList.contains('open')) {
      input.blur(); input.remove(); input = null;
    }
  });
})();
