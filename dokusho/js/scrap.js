/* スクラップブック: いいなと思ったページを、本をまたいで1冊にまとめる
   - コピー型: 入れた時点のページの絵（JPEG）と、そのページの書き込み・付箋を写して、独立したノートにする
     （あとで元の本に書き足しても、スクラップブックには反映されない。元の本を端末から消しても読める）
   - どの本の何ページから写したかも覚えておき、「元の本を開く」でそのページへ戻れる
   - スクラップブックの中でも、ペン・マーカー・付箋が使える。ページ一覧で並べ替え・削除ができる
   - 「PDFにして共有」で、書き込みと出典つきのPDFにできる
   記録（Store の books、kind: 'scrap'）: { id, name, items: [{ id, w, h, from: { book, name, page }, at, file }], … }
   - items は写した順。並べ替え・削除は、開いている間は書き込みデータの layout に持ち、次に開くときに items に反映する
   ページの絵（Store の pages）: { id, scrap, data: JPEG, w, h } */
(function () {
  'use strict';
  var App = window.App, S = App.S;
  var $ = function (id) { return document.getElementById(id); };
  var LIB = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';
  var PX = 2000;          // 写すページの絵の、長い辺の大きさ
  var curItems = [];      // 開いているスクラップブックのページ（写した順）
  var menu = $('scrapMenu'), sel = [], adding = false;

  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function askName(msg, def) {
    var n = window.prompt(msg, def || '');
    n = n && n.trim();
    return n ? n.slice(0, 60) : null;
  }
  async function list() {
    return (await Store.books()).filter(function (b) { return b.kind === 'scrap'; })
      .sort(function (a, b) { return (b.editedAt || b.addedAt || 0) - (a.editedAt || a.addedAt || 0); });
  }
  function isOpen(id) { return S.hasFile && S.key === id; }
  function touched(id) { if (window.Sync) Sync.scrapChanged(id); }

  /* ---------- 作る・名前を変える・削除 ---------- */
  async function create(name) {
    name = name || askName('新しいスクラップブックの名前（例: 音読指導）');
    if (!name) return null;
    var id = Source.rid('s:');
    await Store.putBook({ id: id, kind: 'scrap', name: name, items: [], pages: 0, addedAt: Date.now(), editedAt: Date.now(), dirty: true });
    touched(id);
    return id;
  }
  async function rename(id) {
    var b = await Store.getBook(id); if (!b) return;
    var n = askName('スクラップブックの名前', b.name); if (!n || n === b.name) return;
    await Store.patchBook(id, { name: n, dirty: true, editedAt: Date.now() });
    touched(id);
  }
  async function remove(id) {
    var b = await Store.getBook(id); if (!b) return;
    var n = b.items ? b.items.length : 0;
    if (!window.confirm('スクラップブック「' + b.name + '」を削除しますか？\n' + (n ? n + 'ページぶんの写しと、その書き込みが消えます。' : '') + '（元の本はそのままです）')) return;
    if (isOpen(id)) { App.closeDoc(); Library.forget(id); }
    // Driveにあるぶんは、あとで sync.js がゴミ箱へ入れる
    var gone = (await Store.getKV('scrap:gone')) || [];
    gone.push({ id: id, folder: b.drive && b.drive.folder || '' });
    await Store.putKV('scrap:gone', gone);
    await Store.removeScrap(id);
    (b.items || []).forEach(function (it) { Source.forgetImage(it.id); });
    App.setStatus('スクラップブック「' + b.name + '」を削除しました');
    touched(id);
  }

  /* ---------- 並べ替え・削除を反映した見え方 ----------
     rec.items は写した順のまま。ann.layout があれば、その並びが今の見え方。
     戻り値: { items: 今の並びのページ, ann: layout を外した書き込み, removed: 削除されたページ, changed } */
  function view(rec, ann) {
    var items = rec.items || [];
    ann = ann || {};
    if (!Array.isArray(ann.layout) || !ann.layout.length) return { items: items, ann: ann, removed: [], changed: false };
    var out = [], used = {};
    ann.layout.forEach(function (e) { var it = items[e.src - 1]; if (it && !used[it.id]) { used[it.id] = true; out.push(it); } });
    var a = { version: 1, pdf: ann.pdf, pages: ann.pages || {} };
    if (ann.notes) a.notes = ann.notes;
    return { items: out, ann: a, removed: items.filter(function (it) { return !used[it.id]; }), changed: true };
  }
  // 開いていないスクラップブックの、並べ替え・削除を items に反映して保存し直す
  async function normalize(id) {
    var rec = await Store.getBook(id);
    if (!rec || rec.kind !== 'scrap' || isOpen(id)) return rec;
    var ann = await Store.getAnn(id), v = view(rec, ann);
    if (!v.changed) return rec;
    for (var i = 0; i < v.removed.length; i++) { await Store.delPage(v.removed[i].id); Source.forgetImage(v.removed[i].id); }
    var trash = (rec.trash || []).concat(v.removed.map(function (it) { return it.file; }).filter(Boolean));
    await Store.putAnn(id, v.ann);
    await Store.patchBook(id, { items: v.items, pages: v.items.length, trash: trash.length ? trash : undefined });
    return Store.getBook(id);
  }

  /* ---------- 開く ---------- */
  async function open(id, at) {
    var rec = await normalize(id);
    if (!rec) return false;
    if (!rec.items.length) {
      App.setStatus('このスクラップブックには、まだページがありません。本を開いて、上のスクラップのボタンから入れてください');
      return false;
    }
    // ほかの端末で入れたページの絵が、この端末にまだなければ、Driveから取る
    var have = {}; (await Store.pageKeys(id)).forEach(function (k) { have[k] = true; });
    var miss = rec.items.filter(function (it) { return !have[it.id]; });
    if (miss.length) {
      App.setStatus('スクラップブックのページを、Driveから取っています…');
      if (!window.Sync || !(await Sync.fetchPages(rec, miss))) {
        App.setStatus('スクラップブックのページを取れませんでした。Googleドライブにログインして、もう一度お試しください');
        return false;
      }
    }
    var ann = await Store.getAnn(id);
    curItems = rec.items.slice();
    App.openDoc(Source.imageDoc(curItems), rec.name, id, ann, 'scrap', at || rec.last || 1);
    Library.opened(id, curItems.length, !!rec.thumb);
    return true;
  }
  // 開いているスクラップブックの n ページ目の、元の本とページ
  function sourceOf(n) {
    if (!S.hasFile || S.kind !== 'scrap') return null;
    var e = App.pageEntry(n), it = curItems[e.src - 1];
    return it && it.from ? it.from : null;
  }
  async function openSource(n) {
    var f = sourceOf(n); if (!f) return;
    var b = await Store.getBook(f.book);
    if (!b) { App.setStatus('元の本（「' + f.name + '」' + f.page + 'ページ）は、いまの本棚にありません'); return; }
    Library.open(f.book, f.page);
  }
  // 右下に、いまのページの出典を出す（押すと元の本へ）
  var chip = $('srcChip');
  function showSource() {
    var f = sourceOf(S.page);
    chip.hidden = !f;
    if (f) chip.textContent = '「' + f.name + '」' + f.page + 'ページ ›';
  }
  App.on('page', showSource); App.on('open', showSource); App.on('layout', showSource);
  App.on('close', function () { chip.hidden = true; });
  chip.addEventListener('click', function () { openSource(S.page); });

  /* ---------- ページを入れる ---------- */
  function small(canvas) {
    var w = 240, h = Math.round(w * canvas.height / canvas.width), c = document.createElement('canvas');
    c.width = w; c.height = h; c.getContext('2d').drawImage(canvas, 0, 0, w, h);
    var url = c.toDataURL('image/jpeg', 0.75); c.width = c.height = 0;
    return url;
  }
  // 開いている本の pages（ページ番号の並び）を、スクラップブック sid に写す
  async function add(sid, pages) {
    if (adding || !S.hasFile || S.kind !== 'book' || !pages.length) return;
    adding = true;
    try {
      App.flushSave();
      var rec = await Store.getBook(sid);
      if (!rec) return;
      var ann = (await Store.getAnn(sid)) || { version: 1, pages: {} };
      if (!ann.pages) ann.pages = {};
      var base = (rec.items || []).length, fresh = [], thumb = rec.thumb || '', dn = 0;
      var from = { book: S.key, name: Library.bare(S.name) };
      App.setStatus('スクラップブックに入れています…');
      for (var i = 0; i < pages.length; i++) {
        var n = pages[i], cap = await App.capturePage(n, PX);
        var buf = await (await Source.canvasBlob(cap.canvas, 'image/jpeg', 0.85)).arrayBuffer();
        if (!thumb && !base && !i) thumb = small(cap.canvas);
        cap.canvas.width = cap.canvas.height = 0;
        var pid = Source.rid('p'), now = Date.now();
        await Store.putPage({ id: pid, scrap: sid, data: buf, w: cap.w, h: cap.h, at: now });
        fresh.push({ id: pid, w: Math.round(cap.w * 100) / 100, h: Math.round(cap.h * 100) / 100,
          from: { book: from.book, name: from.name, page: n }, at: now });
        // 並べ替え・削除をしたあと（layout がある）なら、その並びの最後に足す
        if (Array.isArray(ann.layout) && ann.layout.length) { ann.layout.push({ src: base + fresh.length }); dn = ann.layout.length; }
        else dn = base + fresh.length;
        var st = (S.strokes[n] || []).filter(function (x) { return x.tool !== 'image'; }).map(function (x) { var y = clone(x); delete y.link; return y; });
        var nt = (S.notes[n] || []).map(function (x) { var y = clone(x); y.id = App.nid(); return y; });
        if (st.length) ann.pages[dn] = st; else delete ann.pages[dn];
        if (nt.length) { ann.notes = ann.notes || {}; ann.notes[dn] = nt; } else if (ann.notes) delete ann.notes[dn];
      }
      await Store.putAnn(sid, ann);
      await Store.patchBook(sid, function (r) {
        return { items: (r.items || []).concat(fresh), pages: dn, dirty: true, editedAt: Date.now(), thumb: r.thumb || thumb || undefined };
      });
      App.setStatus('「' + rec.name + '」に入れました（' + (pages.length > 1 ? pages.length + 'ページ・' : '') + '全部で' + dn + 'ページ）');
      touched(sid);
    } catch (e) {
      console.error(e);
      App.setStatus('スクラップブックに入れられませんでした（端末の空きが足りない可能性があります）');
    } finally { adding = false; }
  }

  /* ---------- どのスクラップブックに入れるかを選ぶ ---------- */
  function label(p) { return p.length > 1 ? p[0] + '・' + p[1] + 'ページ目' : p[0] + 'ページ目'; }
  async function pick(pages, anchor) {
    if (!S.hasFile || S.kind !== 'book') return;
    var seg = '';
    if (!pages) {
      pages = [S.page];
      var m = S.spread ? App.stillPage() : 0;
      if (m) {
        var lo = Math.min(S.page, m), hi = Math.max(S.page, m);
        seg = '<div class="mseg" id="scrapSeg">' +
          '<button data-pg="' + lo + '">' + lo + 'ページ</button><button data-pg="' + hi + '">' + hi + 'ページ</button>' +
          '<button data-pg="' + lo + ',' + hi + '">両方</button></div>';
      }
    }
    sel = pages;
    var all = await list();
    menu.innerHTML = '<div class="mhead" id="scrapHead"></div>' + seg +
      all.map(function (b) {
        return '<button class="item" data-sid="' + esc(b.id) + '">' + esc(b.name) + '<small>' + (b.pages != null ? b.pages : b.items ? b.items.length : 0) + 'ページ</small></button>';
      }).join('') +
      (all.length ? '<div class="mline"></div>' : '') +
      '<button class="item" data-new="1">＋ 新しいスクラップブックを作って入れる</button>';
    markSel();
    App.toolbar.showPop(menu, anchor || $('scrapBtn'));
  }
  function markSel() {
    var h = $('scrapHead'); if (h) h.textContent = label(sel) + 'を、スクラップブックに入れる';
    menu.querySelectorAll('[data-pg]').forEach(function (b) { b.classList.toggle('on', b.dataset.pg === sel.join(',')); });
  }
  menu.addEventListener('click', async function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.pg) { sel = b.dataset.pg.split(',').map(Number); markSel(); return; }
    var pages = sel.slice();
    if (b.dataset.sid) { App.toolbar.closePops(); add(b.dataset.sid, pages); return; }
    if (b.dataset.new) {
      App.toolbar.closePops();
      var id = await create();
      if (id) add(id, pages);
    }
  });
  $('scrapBtn').addEventListener('click', function (e) { pick(null, e.currentTarget); });

  /* ---------- PDFにして共有 ---------- */
  var libP = null;
  function loadLib() {
    if (window.PDFLib) return Promise.resolve();
    if (!libP) libP = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = LIB; s.onload = resolve;
      s.onerror = function () { libP = null; reject(new Error('lib_load')); };
      document.head.appendChild(s);
    });
    return libP;
  }
  function rgb(c) {
    var n = parseInt(String(c || '').replace('#', '').slice(0, 6), 16);
    if (!isFinite(n)) n = 0x1b2430;
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }
  // 線を描く命令（画面と同じ太さ・色・透明度。手書きノートの pdf-write.js と同じ描き方）
  function strokeOps(L, page, list, w, h, oy) {
    var ops = [], gs = null;
    (list || []).forEach(function (s) {
      if (!s || !Array.isArray(s.points) || !s.points.length) return;
      var p = s.points, col = rgb(s.color), base = (+s.width || 4) * w / 1000;
      var pts = p.map(function (pt) { return [pt[0] * w, oy + h - pt[1] * h]; });
      var pr = function (j) { return isFinite(p[j][2]) ? p[j][2] : 0.5; };
      ops.push(L.pushGraphicsState(), L.setStrokingRgbColor(col[0], col[1], col[2]),
        L.setLineCap(L.LineCapStyle.Round), L.setLineJoin(L.LineJoinStyle.Round));
      if (s.tool === 'highlighter') {
        if (!gs) gs = page.maybeEmbedGraphicsState({ opacity: 0.35, borderOpacity: 0.35 });
        ops.push(L.setGraphicsState(gs), L.setLineWidth(base * 5), L.moveTo(pts[0][0], pts[0][1]));
        for (var i = 1; i < pts.length; i++) ops.push(L.lineTo(pts[i][0], pts[i][1]));
        if (pts.length === 1) ops.push(L.lineTo(pts[0][0] + 0.01, pts[0][1]));
        ops.push(L.stroke());
      } else if (pts.length === 1) {
        ops.push(L.setLineWidth(base * (0.85 + 0.3 * pr(0))), L.moveTo(pts[0][0], pts[0][1]), L.lineTo(pts[0][0] + 0.01, pts[0][1]), L.stroke());
      } else {
        var lastW = null;
        for (var j = 1; j < pts.length; j++) {
          var lw = Math.round(base * (0.85 + 0.3 * (pr(j) + pr(j - 1)) / 2) * 20) / 20;
          if (lw !== lastW) {
            if (lastW !== null) ops.push(L.stroke());
            ops.push(L.setLineWidth(lw), L.moveTo(pts[j - 1][0], pts[j - 1][1]));
            lastW = lw;
          }
          ops.push(L.lineTo(pts[j][0], pts[j][1]));
        }
        ops.push(L.stroke());
      }
      ops.push(L.popGraphicsState());
    });
    return ops;
  }
  // 文字は絵にして貼る（PDFに日本語の文字をそのまま入れるには、フォントを丸ごと埋め込む必要があるため）
  var FONT = '-apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif';
  function pngBytes(canvas) { return Source.canvasBlob(canvas, 'image/png').then(function (b) { return b.arrayBuffer(); }); }
  // 付箋を、画面と同じ見た目で絵にする（ページの横幅を P ピクセルとして描く）
  function noteCanvas(t) {
    var P = 1600, b = Notes.box(t), c = document.createElement('canvas');
    c.width = Math.ceil(b.w * P); c.height = Math.ceil(b.h * P);
    Notes.paint(c.getContext('2d'), t, c.width / 2, c.height / 2, P, true);
    return c;
  }
  function captionCanvas(text) {
    var c = document.createElement('canvas'), x = c.getContext('2d'), fs = 26;
    x.font = fs + 'px ' + FONT;
    c.width = Math.min(2400, Math.ceil(x.measureText(text).width) + 8); c.height = 40;
    x = c.getContext('2d');
    x.font = fs + 'px ' + FONT; x.fillStyle = '#6b655c'; x.textBaseline = 'middle';
    x.fillText(text, 4, 21, c.width - 8);
    return c;
  }
  var STRIP = 16; // ページの下に足す、出典を書く帯の高さ（PDFの単位）
  async function buildPdf(id) {
    await loadLib();
    var rec = await Store.getBook(id);
    var ann = isOpen(id) ? (App.flushSave(), App.exportData()) : await Store.getAnn(id);
    var v = view(rec, ann), L = PDFLib, pdf = await L.PDFDocument.create();
    pdf.setTitle(rec.name);
    for (var i = 0; i < v.items.length; i++) {
      var it = v.items[i], pr = await Store.getPage(it.id);
      if (!pr || !pr.data) continue;
      var w = it.w, h = it.h, page = pdf.addPage([w, h + STRIP]);
      page.drawImage(await pdf.embedJpg(pr.data), { x: 0, y: STRIP, width: w, height: h });
      var ops = strokeOps(L, page, (v.ann.pages || {})[i + 1], w, h, STRIP);
      if (ops.length) page.pushOperators.apply(page, ops);
      var notes = (v.ann.notes || {})[i + 1] || [];
      for (var k = 0; k < notes.length; k++) {
        var t = notes[k], nc = noteCanvas(t), img = await pdf.embedPng(await pngBytes(nc));
        var nw = w * Notes.box(t).w, nh = nw * nc.height / nc.width;
        var nx = Math.max(0, Math.min(w - nw, t.x * w - nw / 2)), ny = Math.max(STRIP, Math.min(STRIP + h - nh, STRIP + h - t.y * h - nh / 2));
        page.drawImage(img, { x: nx, y: ny, width: nw, height: nh, opacity: 0.96 });
        nc.width = nc.height = 0;
      }
      if (it.from) {
        var cc = captionCanvas('「' + it.from.name + '」 ' + it.from.page + 'ページ'), ci = await pdf.embedPng(await pngBytes(cc));
        var ch = STRIP * 0.72, cw = Math.min(w - 12, ch * cc.width / cc.height);
        page.drawImage(ci, { x: 6, y: (STRIP - ch) / 2, width: cw, height: ch });
        cc.width = cc.height = 0;
      }
    }
    var bytes = await pdf.save();
    return new File([bytes], (rec.name || 'スクラップブック') + '.pdf', { type: 'application/pdf' });
  }
  function download(f) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
  }
  async function send(f) {
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      try { await navigator.share({ files: [f], title: f.name }); return true; }
      catch (e) {
        if (e.name === 'AbortError') return true;      // 共有メニューを閉じた
        if (e.name === 'NotAllowedError') return false; // 準備に時間がかかった → もう一度タップしてもらう
        throw e;
      }
    }
    download(f);
    return true;
  }
  var ready = null, busy = false;
  async function share(id) {
    if (busy) return;
    busy = true;
    App.setStatus('PDFを作っています…');
    try {
      var f = await buildPdf(id);
      if (!(await send(f))) { ready = f; $('shareName').textContent = f.name; $('shareDlg').classList.add('open'); }
    } catch (e) {
      console.error(e);
      App.setStatus(e.message === 'lib_load' ? '通信できないため、PDFを作れませんでした' : 'PDFを作れませんでした');
    } finally { busy = false; }
  }
  $('shareGo').addEventListener('click', function () {
    var f = ready; ready = null; $('shareDlg').classList.remove('open');
    if (f) send(f).catch(function (e) { console.error(e); App.setStatus('共有できませんでした'); });
  });
  $('shareClose').addEventListener('click', function () { ready = null; $('shareDlg').classList.remove('open'); });
  $('shareBtn').addEventListener('click', function () { App.toolbar.closePops(); if (S.hasFile && S.kind === 'scrap') share(S.key); });

  window.Scrap = {
    create: create, rename: rename, remove: remove, open: open, add: add, pick: pick, share: share, buildPdf: buildPdf,
    sourceOf: sourceOf, openSource: openSource, view: view, normalize: normalize, list: list
  };
})();
