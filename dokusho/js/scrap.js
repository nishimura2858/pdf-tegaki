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
  /* 切り抜き（cut: そのページの中の四角。ページに対する割合 { x, y, w, h }）
     スクラップブックには、元のページと同じ大きさの白い紙を作り、切り抜いた絵を、元の大きさのまま、まん中（box）に貼る。
     書き込みは四角の中だけを、付箋は四角の中にあるものを、貼った所へ移して写す。
     貼ったあとは、スクラップブックの中で動かしたり、大きさを変えたりできる（editPiece） */
  var r4 = function (v) { return Math.round(v * 1e4) / 1e4; };
  // 四角 a の中の点を、四角 b の同じ場所へ
  function mapPt(p, a, b) { return [r4((p[0] - a.x) / a.w * b.w + b.x), r4((p[1] - a.y) / a.h * b.h + b.y), p[2]]; }
  // 線を四角 r の中だけに切る（はみ出した所で切れて、いくつかの線に分かれる）
  function clipSeg(a, b, r) {
    var dx = b[0] - a[0], dy = b[1] - a[1], t0 = 0, t1 = 1;
    var p = [-dx, dx, -dy, dy], q = [a[0] - r.x, r.x + r.w - a[0], a[1] - r.y, r.y + r.h - a[1]];
    for (var i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return null; continue; }
      var t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
      else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
    return [t0, t1];
  }
  function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2]]; }
  function clipPts(pts, r) {
    if (pts.length === 1) { var q = pts[0]; return q[0] >= r.x && q[0] <= r.x + r.w && q[1] >= r.y && q[1] <= r.y + r.h ? [[q]] : []; }
    var runs = [], cur = null;
    for (var i = 1; i < pts.length; i++) {
      var c = clipSeg(pts[i - 1], pts[i], r);
      if (!c) { if (cur) { runs.push(cur); cur = null; } continue; }
      var A = lerp(pts[i - 1], pts[i], c[0]), B = lerp(pts[i - 1], pts[i], c[1]);
      if (!cur || c[0] > 0) { if (cur) runs.push(cur); cur = [A]; }
      cur.push(B);
      if (c[1] < 1) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
    return runs;
  }
  // cut の中の書き込みを、box の所へ（大きさは変えない）
  function pieceStrokes(list, cut, box) {
    var out = [];
    list.forEach(function (s) {
      if (!s || s.tool === 'image' || !Array.isArray(s.points) || !s.points.length) return;
      clipPts(s.points, cut).forEach(function (run) {
        var y = clone(s); delete y.link;
        y.points = run.map(function (p) { return mapPt(p, cut, box); });
        out.push(y);
      });
    });
    return out;
  }
  function pieceNotes(list, cut, box) {
    return list.filter(function (t) { return t.x >= cut.x && t.x <= cut.x + cut.w && t.y >= cut.y && t.y <= cut.y + cut.h; }).map(function (t) {
      var y = clone(t), p = mapPt([t.x, t.y], cut, box);
      y.id = App.nid(); y.x = p[0]; y.y = p[1];
      return y;
    });
  }
  function cutCanvas(src, r) {
    var sx = Math.round(r.x * src.width), sy = Math.round(r.y * src.height);
    var sw = Math.max(1, Math.round(r.w * src.width)), sh = Math.max(1, Math.round(r.h * src.height));
    var k = Math.min(1, PX / Math.max(sw, sh)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
    var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  }
  // 開いている本の pages（ページ番号の並び）を、スクラップブック sid に写す。cut があれば、そのページの一部だけ
  async function add(sid, pages, cut) {
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
      App.setStatus(cut ? '切り抜いています…' : 'スクラップブックに入れています…');
      for (var i = 0; i < pages.length; i++) {
        var n = pages[i], cap = await App.capturePage(n, cut ? Math.min(3600, PX / Math.max(cut.w, cut.h)) : PX);
        var pic = cap.canvas, pw = cap.w, ph = cap.h;
        if (cut) { pic = cutCanvas(cap.canvas, cut); cap.canvas.width = cap.canvas.height = 0; } // 紙の大きさ（pw, ph）は元のページのまま
        var buf = await (await Source.canvasBlob(pic, 'image/jpeg', 0.85)).arrayBuffer();
        if (!thumb && !base && !i) thumb = small(pic);
        pic.width = pic.height = 0;
        var pid = Source.rid('p'), now = Date.now();
        await Store.putPage({ id: pid, scrap: sid, data: buf, w: pw, h: ph, at: now });
        var item = { id: pid, w: Math.round(pw * 100) / 100, h: Math.round(ph * 100) / 100,
          from: { book: from.book, name: from.name, page: n }, at: now };
        var box = null;
        if (cut) {
          item.cut = { x: r4(cut.x), y: r4(cut.y), w: r4(cut.w), h: r4(cut.h) };
          box = item.box = { x: r4((1 - cut.w) / 2), y: r4((1 - cut.h) / 2), w: r4(cut.w), h: r4(cut.h) };
        }
        fresh.push(item);
        // 並べ替え・削除をしたあと（layout がある）なら、その並びの最後に足す
        if (Array.isArray(ann.layout) && ann.layout.length) { ann.layout.push({ src: base + fresh.length }); dn = ann.layout.length; }
        else dn = base + fresh.length;
        var st = cut ? pieceStrokes(S.strokes[n] || [], cut, box) :
          (S.strokes[n] || []).filter(function (x) { return x.tool !== 'image'; }).map(function (x) { var y = clone(x); delete y.link; return y; });
        var nt = cut ? pieceNotes(S.notes[n] || [], cut, box) : (S.notes[n] || []).map(function (x) { var y = clone(x); y.id = App.nid(); return y; });
        if (st.length) ann.pages[dn] = st; else delete ann.pages[dn];
        if (nt.length) { ann.notes = ann.notes || {}; ann.notes[dn] = nt; } else if (ann.notes) delete ann.notes[dn];
      }
      await Store.putAnn(sid, ann);
      await Store.patchBook(sid, function (r) {
        return { items: (r.items || []).concat(fresh), pages: dn, dirty: true, editedAt: Date.now(), thumb: r.thumb || thumb || undefined };
      });
      App.setStatus((cut ? n + 'ページの一部を切り抜いて、' : '') + '「' + rec.name + '」に入れました（' + (pages.length > 1 ? pages.length + 'ページ・' : '') + '全部で' + dn + 'ページ）');
      touched(sid);
    } catch (e) {
      console.error(e);
      App.setStatus('スクラップブックに入れられませんでした（端末の空きが足りない可能性があります）');
    } finally { adding = false; }
  }

  /* ---------- どのスクラップブックに入れるかを選ぶ ---------- */
  function label(p) { return p.length > 1 ? p[0] + '・' + p[1] + 'ページ目' : p[0] + 'ページ目'; }
  // 「ページ全体」か「一部を切り抜く」か（前に選んだほうを、この端末に覚えておく）
  var cutMode = false, canCut = false;
  try { cutMode = localStorage.getItem('dk:ui:scrapCut') === '1'; } catch (e) {}
  async function pick(pages, anchor) {
    if (!S.hasFile || S.kind !== 'book') return;
    var seg = '', mode = '';
    canCut = !pages; // 上のボタン・全画面の帯から開いたときだけ（ページ一覧からはページ全体）
    if (canCut) mode = '<div class="mseg" id="scrapMode"><button data-mode="page">ページ全体</button><button data-mode="cut">一部を切り抜く</button></div>';
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
    menu.innerHTML = '<div class="mhead" id="scrapHead"></div>' + mode + seg +
      '<div class="mnote" id="scrapCutHint">入れる先を選んだら、切り抜きたい所を、ペンで角から角へ引っぱって囲みます</div>' +
      all.map(function (b) {
        return '<button class="item" data-sid="' + esc(b.id) + '">' + esc(b.name) + '<small>' + (b.pages != null ? b.pages : b.items ? b.items.length : 0) + 'ページ</small></button>';
      }).join('') +
      (all.length ? '<div class="mline"></div>' : '') +
      '<button class="item" data-new="1">＋ 新しいスクラップブックを作って入れる</button>';
    markSel();
    App.toolbar.showPop(menu, anchor || $('scrapBtn'));
  }
  function cutting() { return canCut && cutMode; }
  function markSel() {
    var h = $('scrapHead'), c = cutting();
    if (h) h.textContent = c ? 'ページの一部を切り抜いて、スクラップブックに入れる' : label(sel) + 'を、スクラップブックに入れる';
    menu.querySelectorAll('[data-pg]').forEach(function (b) { b.classList.toggle('on', b.dataset.pg === sel.join(',')); });
    menu.querySelectorAll('[data-mode]').forEach(function (b) { b.classList.toggle('on', (b.dataset.mode === 'cut') === c); });
    var sg = $('scrapSeg'); if (sg) sg.hidden = c;
    $('scrapCutHint').hidden = !c;
  }
  function into(sid) { if (cutting()) startCut(sid); else add(sid, sel.slice()); }
  menu.addEventListener('click', async function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.mode) {
      cutMode = b.dataset.mode === 'cut';
      try { localStorage.setItem('dk:ui:scrapCut', cutMode ? '1' : '0'); } catch (er) {}
      markSel(); return;
    }
    if (b.dataset.pg) { sel = b.dataset.pg.split(',').map(Number); markSel(); return; }
    if (b.dataset.sid) { App.toolbar.closePops(); into(b.dataset.sid); return; }
    if (b.dataset.new) {
      App.toolbar.closePops();
      var id = await create();
      if (id) into(id);
    }
  });

  /* ---------- 一部を切り抜く ----------
     ペンを紙に当てた所から、離さずに引っぱって、離した所までの四角を切り抜く（指はいつもどおり、めくる・動かす）。
     ペンの動きは app.js から hooks.penGrab で受け取る（見開きのもう片方のページでも、ペンが触れたページで切り抜く） */
  var cutBar = $('cutBar'), cutBox = $('cutBox'), cutSid = null, cg = null;
  async function startCut(sid) {
    var rec = await Store.getBook(sid); if (!rec || !S.hasFile || S.kind !== 'book') return;
    cutSid = sid;
    $('cutText').textContent = '「' + rec.name + '」に入れる所を、ペンで角から角へ引っぱって囲んでください';
    cutBar.hidden = false;
    document.body.classList.add('cutting');
    if (window.Quick) Quick.hideTray(true);
    App.hooks.penGrab = grab;
  }
  function endCut() {
    cutSid = null; cg = null;
    if (App.hooks.penGrab === grab) App.hooks.penGrab = null;
    cutBar.hidden = true; cutBox.hidden = true; cutBox.classList.remove('done');
    document.body.classList.remove('cutting');
  }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  function cutRect(g) {
    var x0 = clamp01(Math.min(g.a[0], g.b[0])), x1 = clamp01(Math.max(g.a[0], g.b[0]));
    var y0 = clamp01(Math.min(g.a[1], g.b[1])), y1 = clamp01(Math.max(g.a[1], g.b[1]));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function showBox(g) {
    var r = cutRect(g), rc = g.rc;
    cutBox.style.left = (rc.left + r.x * rc.width) + 'px'; cutBox.style.top = (rc.top + r.y * rc.height) + 'px';
    cutBox.style.width = (r.w * rc.width) + 'px'; cutBox.style.height = (r.h * rc.height) + 'px';
    cutBox.hidden = false;
  }
  var grab = {
    down: function (pt) {
      if (!cutSid) return;
      cutBox.classList.remove('done');
      cg = { n: S.page, rc: S.rc || App.wrap.getBoundingClientRect(), a: pt, b: pt };
      showBox(cg);
    },
    move: function (pt) { if (cg) { cg.b = pt; showBox(cg); } },
    up: function (e) {
      var g = cg; cg = null;
      if (!g || !cutSid) return;
      var r = cutRect(g);
      if (e.type === 'pointercancel' || r.w * g.rc.width < 24 || r.h * g.rc.height < 24) {
        cutBox.hidden = true;
        if (e.type !== 'pointercancel') App.setStatus('もう少し大きく囲んでください（ペンを離さずに、角から角へ引っぱります）');
        return;
      }
      var sid = cutSid;
      if (App.hooks.penGrab === grab) App.hooks.penGrab = null;
      cutBox.classList.add('done');
      setTimeout(endCut, 450);
      add(sid, [g.n], r);
    }
  };
  $('cutCancel').addEventListener('click', function () { endCut(); App.setStatus('切り抜きをやめました'); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && cutSid) endCut(); });
  App.on('open', endCut); App.on('close', endCut);
  $('scrapBtn').addEventListener('click', function (e) { pick(null, e.currentTarget); });

  /* ---------- ページを白黒にする（スクラップブックの中で、ページごとに） ----------
     ページの絵だけを白黒にする。書き込み・付箋は上に重ねて描くので、色のまま。
     記録は items の bw（Driveの scrap.json にも入るので、ほかの端末でも白黒になる） */
  function itemAt(n) {
    if (!S.hasFile || S.kind !== 'scrap') return null;
    var e = App.pageEntry(n); return e ? curItems[e.src - 1] || null : null;
  }
  function isBw(n) { var it = itemAt(n); return !!(it && it.bw); }
  async function setBw(n, on) {
    var it = itemAt(n); if (!it) return;
    var sid = S.key, id = it.id;
    if (on) it.bw = true; else delete it.bw;
    await Store.patchBook(sid, function (r) {
      return { items: (r.items || []).map(function (x) {
        if (x.id !== id) return x;
        var y = Object.assign({}, x); if (on) y.bw = true; else delete y.bw; return y;
      }), dirty: true, editedAt: Date.now() };
    });
    touched(sid);
    App.repaint(n);
    App.setStatus(n + 'ページ目を' + (on ? '白黒にしました（書き込み・付箋の色はそのまま）' : 'カラーに戻しました'));
    markBw();
  }
  function shownPages() {
    var a = [S.page], m = S.spread ? App.stillPage() : 0;
    if (m) a.push(m);
    return a.sort(function (x, y) { return x - y; });
  }
  // 「その他」と全画面の帯のボタン。見えているページが1枚ならすぐ切りかえ、見開きなら選ぶ
  var bwMenu = document.createElement('div');
  bwMenu.className = 'pop menu'; bwMenu.id = 'bwMenu';
  document.body.appendChild(bwMenu);
  function markBw() {
    var one = shownPages().length === 1, b = $('bwBtn'), t = $('trayBw');
    if (b) {
      b.classList.toggle('check', one);
      b.setAttribute('aria-pressed', one && isBw(S.page) ? 'true' : 'false');
      b.firstChild.nodeValue = one ? 'このページを白黒に' : 'ページを白黒に…';
    }
    if (t) t.classList.toggle('on', one && isBw(S.page));
    bwMenu.querySelectorAll('[data-bw]').forEach(function (x) { x.setAttribute('aria-pressed', isBw(+x.dataset.bw) ? 'true' : 'false'); });
  }
  function bwPick(anchor) {
    if (!S.hasFile || S.kind !== 'scrap') return;
    var ps = shownPages();
    if (ps.length === 1) { setBw(ps[0], !isBw(ps[0])); return; }
    bwMenu.innerHTML = '<div class="mhead">白黒にするページ（書き込みの色はそのまま）</div>' +
      ps.map(function (n) { return '<button class="item check" data-bw="' + n + '">' + n + 'ページ</button>'; }).join('');
    markBw();
    App.toolbar.showPop(bwMenu, anchor);
  }
  bwMenu.addEventListener('click', function (e) {
    var b = e.target.closest('[data-bw]'); if (!b) return;
    var n = +b.dataset.bw; setBw(n, !isBw(n));
  });
  $('bwBtn').addEventListener('click', function (e) {
    if (shownPages().length === 1) { App.toolbar.closePops(); }
    bwPick($('moreBtn'));
  });
  $('moreBtn').addEventListener('click', markBw);
  App.on('page', markBw); App.on('open', markBw);

  /* ---------- 切り抜きを動かす・大きさを変える（スクラップブックの中で） ----------
     切り抜きの上の書き込み・付箋も一緒に動く（始めたときに、切り抜きの中にあったもの）。
     動かしている間は、紙の絵を隠して、切り抜きの絵（pv）を動かして見せる。終えたら item.box を保存して描き直す */
  function isPiece(n) { var it = itemAt(n); return !!(it && it.box); }
  var pe = null, peEl = $('pieceEd'), peBox = peEl.querySelector('.pe-box'), peBar = $('pieceBar');
  function inBox(b, x, y) { return x >= b.x - 0.01 && x <= b.x + b.w + 0.01 && y >= b.y - 0.01 && y <= b.y + b.h + 0.01; }
  async function editPiece(n) {
    if (pe) await donePiece();
    if (!isPiece(n) || App.busy()) return;
    if (!App.focusPage(n)) { // 見えていないページ: そのページへ行ってから
      App.goPage(n);
      await new Promise(function (r) { setTimeout(r, 450); });
      if (S.page !== n || !isPiece(n)) return;
    }
    App.toolbar.closePops();
    if (window.Quick) Quick.hideTray(true);
    var it = itemAt(S.page), img = await Source.pageImage(it.id, !!it.bw);
    var b0 = clone(it.box), st0 = clone(S.strokes[S.page] || []), nt0 = clone(S.notes[S.page] || []);
    pe = { n: S.page, it: it, img: img, b0: b0, b: clone(b0), st0: st0, nt0: nt0,
      selS: st0.map(function (s) {
        if (!s || s.tool === 'image' || !s.points || !s.points.length) return false;
        var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        s.points.forEach(function (p) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); });
        return inBox(b0, (x0 + x1) / 2, (y0 + y1) / 2);
      }),
      selN: nt0.map(function (t) { return inBox(b0, t.x, t.y); }) };
    // 切り抜きの絵を、紙の絵の代わりに見せる
    var pv = document.createElement('canvas'); pv.id = 'piecePv';
    App.wrap.insertBefore(pv, $('ink'));
    pe.pv = pv;
    $('pdfc').style.visibility = 'hidden';
    var hp = $('hipdf'); if (hp) hp.style.visibility = 'hidden';
    peEl.hidden = false; peBar.hidden = false;
    document.body.classList.add('piece-on');
    drawPiece();
  }
  function drawPiece() {
    if (!pe) return;
    var b = pe.b, pv = pe.pv, r = App.wrap.getBoundingClientRect(), d = Math.min(window.devicePixelRatio || 1, 2);
    var W = Math.max(1, Math.round(r.width * d)), H = Math.max(1, Math.round(r.height * d));
    if (pv.width !== W || pv.height !== H) { pv.width = W; pv.height = H; }
    var x = pv.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
    x.drawImage(pe.img, b.x * W, b.y * H, b.w * W, b.h * H);
    peBox.style.left = (b.x * 100) + '%'; peBox.style.top = (b.y * 100) + '%';
    peBox.style.width = (b.w * 100) + '%'; peBox.style.height = (b.h * 100) + '%';
    $('pieceSize').textContent = Math.round(b.w / pe.it.cut.w * 100) + '%';
    // 書き込み・付箋も一緒に
    var b0 = pe.b0, k = b.w / b0.w, n = pe.n;
    S.strokes[n] = pe.st0.map(function (s, i) {
      if (!pe.selS[i]) return s;
      var y = clone(s);
      y.points = s.points.map(function (p) { return mapPt(p, b0, b); });
      y.width = Math.round(Math.max(0.5, Math.min(200, (+s.width || 4) * k)) * 100) / 100;
      return y;
    });
    S.notes[n] = pe.nt0.map(function (t, i) {
      if (!pe.selN[i]) return t;
      var y = clone(t), p = mapPt([t.x, t.y], b0, b), tk = +t.k >= 0.5 && +t.k <= 2 ? +t.k : 1;
      y.x = p[0]; y.y = p[1];
      tk = Math.max(0.5, Math.min(2, Math.round(tk * k * 20) / 20));
      if (tk === 1) delete y.k; else y.k = tk;
      return y;
    });
    if (!S.notes[n].length) delete S.notes[n];
    App.drawInk();
  }
  async function donePiece() {
    var p = pe; if (!p) return;
    pe = null;
    peEl.hidden = true; peBar.hidden = true;
    document.body.classList.remove('piece-on');
    var b = p.b, same = ['x', 'y', 'w', 'h'].every(function (k) { return Math.abs(b[k] - p.b0[k]) < 1e-4; });
    function show() {
      $('pdfc').style.visibility = ''; var hp = $('hipdf'); if (hp) hp.style.visibility = '';
      if (p.pv.parentNode) p.pv.remove();
    }
    if (same) { S.strokes[p.n] = p.st0; S.notes[p.n] = p.nt0; if (!p.nt0.length) delete S.notes[p.n]; App.drawInk(); show(); return; }
    var box = { x: r4(b.x), y: r4(b.y), w: r4(b.w), h: r4(b.h) };
    p.it.box = box;
    S.undo = []; S.redo = []; // 切り抜きの場所は取り消せないので、書き込みの取り消しとずれないように履歴を消す
    App.commit(p.n);
    var sid = S.key, id = p.it.id;
    await Store.patchBook(sid, function (r) {
      return { items: (r.items || []).map(function (x) { return x.id === id ? Object.assign({}, x, { box: box }) : x; }), dirty: true, editedAt: Date.now() };
    });
    touched(sid);
    try { await App.repaint(p.n); } catch (e) {}
    show();
  }
  // 動かす（中を引っぱる）・大きさを変える（角を引っぱる。縦横の比はそのまま）
  var pd = null;
  peEl.addEventListener('pointerdown', function (e) {
    if (!pe || pd) return;
    e.preventDefault();
    var h = e.target.closest('.pe-h'), r = App.wrap.getBoundingClientRect();
    if (!h && !e.target.closest('.pe-box')) return;
    pd = { id: e.pointerId, h: h ? h.dataset.h : '', x: e.clientX, y: e.clientY, r: r, b: clone(pe.b) };
    try { peEl.setPointerCapture(e.pointerId); } catch (er) {}
  });
  peEl.addEventListener('pointermove', function (e) {
    if (!pd || e.pointerId !== pd.id || !pe) return;
    e.preventDefault();
    var r = pd.r, b = pd.b, dx = (e.clientX - pd.x) / r.width, dy = (e.clientY - pd.y) / r.height, nb;
    if (!pd.h) {
      nb = { x: Math.max(0, Math.min(1 - b.w, b.x + dx)), y: Math.max(0, Math.min(1 - b.h, b.y + dy)), w: b.w, h: b.h };
    } else {
      // つかんだ角の反対の角を止めて、縦横の比を変えずに広げる・縮める
      var L = pd.h.indexOf('l') >= 0, T = pd.h.indexOf('t') >= 0;
      var ax = L ? b.x + b.w : b.x, ay = T ? b.y + b.h : b.y, ratio = b.h / b.w;
      var px = (L ? b.x : b.x + b.w) + dx, py = (T ? b.y : b.y + b.h) + dy;
      var w = Math.max(Math.abs(px - ax), Math.abs(py - ay) / ratio);
      var maxW = Math.min(L ? ax : 1 - ax, (T ? ay : 1 - ay) / ratio), minW = Math.min(b.w, 0.08);
      w = Math.max(minW, Math.min(maxW, w));
      nb = { x: L ? ax - w : ax, y: T ? ay - w * ratio : ay, w: w, h: w * ratio };
    }
    pe.b = nb; drawPiece();
  });
  function pdEnd(e) { if (pd && e.pointerId === pd.id) pd = null; }
  peEl.addEventListener('pointerup', pdEnd);
  peEl.addEventListener('pointercancel', pdEnd);
  $('pieceDone').addEventListener('click', function () { donePiece(); });
  $('pieceReset').addEventListener('click', function () { // 切り抜いたときの大きさに戻す（まん中はそのまま）
    if (!pe) return;
    var c = pe.it.cut, b = pe.b, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    pe.b = { x: Math.max(0, Math.min(1 - c.w, cx - c.w / 2)), y: Math.max(0, Math.min(1 - c.h, cy - c.h / 2)), w: c.w, h: c.h };
    drawPiece();
  });
  App.on('page', function () { if (pe && S.page !== pe.n) donePiece(); });
  App.on('close', function () { if (pe) { pe = null; peEl.hidden = true; peBar.hidden = true; document.body.classList.remove('piece-on'); var v = $('piecePv'); if (v) v.remove(); $('pdfc').style.visibility = ''; } });
  App.on('resize', function () { if (pe) drawPiece(); });
  // 見えているページのうち、切り抜きのページ（今のページを先に）
  function shownPiece() {
    var a = [S.page], m = S.spread ? App.stillPage() : 0; if (m) a.push(m);
    for (var i = 0; i < a.length; i++) if (isPiece(a[i])) return a[i];
    return 0;
  }
  function markPiece() {
    var n = shownPiece();
    $('pieceBtn').hidden = !n; $('trayPiece').hidden = !n;
  }
  $('pieceBtn').addEventListener('click', function () { var n = shownPiece(); App.toolbar.closePops(); if (n) editPiece(n); });
  $('moreBtn').addEventListener('click', markPiece);
  App.on('page', markPiece); App.on('open', markPiece); App.on('layout', markPiece);

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
      var jpg = pr.data;
      if (it.bw) { // 白黒にしたページは、白黒の絵にしてから入れる
        var bc = await Source.pageImage(it.id, true);
        jpg = await (await Source.canvasBlob(bc, 'image/jpeg', 0.85)).arrayBuffer();
      }
      var bx = it.box || { x: 0, y: 0, w: 1, h: 1 }; // 切り抜きは、白い紙の box の所に
      page.drawImage(await pdf.embedJpg(jpg), { x: bx.x * w, y: STRIP + h - (bx.y + bx.h) * h, width: bx.w * w, height: bx.h * h });
      var ops = strokeOps(L, page, (v.ann.pages || {})[i + 1], w, h, STRIP);
      // 線は、ページの絵の中だけに見せる（切り抜いたページでは、四角からはみ出した所がある）
      if (ops.length) page.pushOperators.apply(page, [L.pushGraphicsState(), L.rectangle(0, STRIP, w, h), L.clip(), L.endPath()].concat(ops, [L.popGraphicsState()]));
      var notes = (v.ann.notes || {})[i + 1] || [];
      for (var k = 0; k < notes.length; k++) {
        var t = notes[k], nc = noteCanvas(t), img = await pdf.embedPng(await pngBytes(nc));
        var nw = w * Notes.box(t).w, nh = nw * nc.height / nc.width;
        var nx = Math.max(0, Math.min(w - nw, t.x * w - nw / 2)), ny = Math.max(STRIP, Math.min(STRIP + h - nh, STRIP + h - t.y * h - nh / 2));
        page.drawImage(img, { x: nx, y: ny, width: nw, height: nh, opacity: 0.96 });
        nc.width = nc.height = 0;
      }
      if (it.from) {
        var cc = captionCanvas('「' + it.from.name + '」 ' + it.from.page + 'ページ' + (it.cut ? '（一部）' : '')), ci = await pdf.embedPng(await pngBytes(cc));
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
    sourceOf: sourceOf, openSource: openSource, view: view, normalize: normalize, list: list,
    isBw: isBw, setBw: setBw, bwPick: bwPick, cancelCut: endCut,
    isPiece: isPiece, editPiece: editPiece, editShown: function () { var n = shownPiece(); if (n) editPiece(n); }, donePiece: donePiece
  };
})();
