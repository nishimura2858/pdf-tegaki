/* 書き込みを、Driveにある元のPDFそのものに反映する
   - Macのファインダーなど、ほかのアプリで開いても書き込みが見えるようにするため
   - 反映するのは、書いてから30分後・アプリを離れたとき・「Drive」ボタンを押したとき（通信量を抑えるため）
   - 書き込み入りPDFには、元のPDFの識別子（TegakiBase）を入れておく。次に開いたときは
     「元のPDF＋手書きデータ」として開くので、前の書き込みも消しゴムで消せる
   - 元のPDFの控えは「PDF手書きデータ」フォルダに置く（ほかの端末でも続きを書けるように）
   - ほかのアプリや端末でPDFが変更されていたら、上書きせずに止める
   この端末での記録: localStorage「pdfw:<元のPDFの識別子>」= { fileId, md5, dirty, dirtyAt, at, conflict } */
(function () {
  'use strict';
  var App = window.App;
  var INTERVAL = 30 * 60 * 1000, RETRY = 5 * 60 * 1000;
  var LIB = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';
  var cur = null, timer = null, busy = false, again = null, libP = null;

  function readMeta(base) { try { return JSON.parse(localStorage.getItem('pdfw:' + base)) || {}; } catch (e) { return {}; } }
  function writeMeta(base, m) { try { localStorage.setItem('pdfw:' + base, JSON.stringify(m)); } catch (e) {} }
  function note(t) { App.setStatus(t); App.dbg('PDF反映: ' + t); }
  function hhmm() { var d = new Date(); return d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2); }
  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(function () { timer = null; flush(cur); }, ms);
  }

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
    var h = String(c || '').replace('#', '');
    if (h.length === 3 || h.length === 4) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h.slice(0, 6), 16);
    if (!isFinite(n)) n = 0x1b2430;
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }

  function dataBytes(url) {
    var b = atob(url.slice(url.indexOf(',') + 1)), a = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    return a;
  }
  // 白紙のページ用: 画面上の位置（割合）→ PDF内の座標
  function flatView(w, h) {
    return { width: w, height: h, convertToPdfPoint: function (x, y) { return [x, h - y]; } };
  }

  /* 元のPDFに手書きを描き込んだPDFを作る（画面と同じ太さ・色・透明度で）
     c.origBytes がなければ（白紙のノート）、新しいPDFを作る。
     data.layout があれば、追加したページ（同じページ・白紙）も入れる */
  async function bake(c, data) {
    await loadLib();
    var L = PDFLib;
    data = data || { pages: {} };
    var hasOrig = !!(c && c.origBytes);
    var pdf = hasOrig ? await L.PDFDocument.load(c.origBytes.slice(0), { updateMetadata: false }) : await L.PDFDocument.create();
    var count = pdf.getPageCount();
    var layout = Array.isArray(data.layout) && data.layout.length ? data.layout : null;
    if (layout && layout.filter(function (e) { return !e.added; }).length !== count) layout = null; // 並びが合わなければ使わない
    if (!layout) {
      layout = [];
      for (var q = 1; q <= count; q++) layout.push({ src: q });
      if (!count) layout.push({ src: 0, w: 595, h: 842 });
    }
    // ページを並びどおりに用意する（元のページはそのまま、追加したページだけ差し込む）
    var srcPdf = null, plan = [], idx = 0;
    for (var li = 0; li < layout.length; li++) {
      var e = layout[li], pg, vp;
      if (!e.added && e.src > 0) {
        pg = pdf.getPage(idx);
      } else if (e.src > 0 && hasOrig) {
        if (!srcPdf) srcPdf = await L.PDFDocument.load(c.origBytes.slice(0), { updateMetadata: false });
        pg = (await pdf.copyPages(srcPdf, [e.src - 1]))[0];
        pdf.insertPage(idx, pg);
      } else {
        pg = pdf.insertPage(idx, [e.w || 595, e.h || 842]);
      }
      vp = e.src > 0 && c.doc ? (await c.doc.getPage(e.src)).getViewport({ scale: 1 }) : flatView(e.w || 595, e.h || 842);
      plan.push({ page: pg, vp: vp });
      idx++;
    }

    var all = data.pages || {}, images = data.images || {}, embedded = {};
    for (var n = 1; n <= plan.length; n++) {
      var list = all[n];
      if (!Array.isArray(list) || !list.length) continue;
      var page = plan[n - 1].page, v = plan[n - 1].vp, ops = [], gsHl = null, gsPc = null;
      var conv = function (x, y) { return v.convertToPdfPoint(x * v.width, y * v.height); };
      page.node.normalize(); // 元の描画内容の座標設定が、追加分に影響しないようにする
      // 画像（線より下）
      for (var ii = 0; ii < list.length; ii++) {
        var im = list[ii];
        if (!im || im.tool !== 'image' || !images[im.id]) continue;
        if (!embedded[im.id]) {
          var url = images[im.id];
          embedded[im.id] = /^data:image\/png/.test(url) ? await pdf.embedPng(dataBytes(url)) : await pdf.embedJpg(dataBytes(url));
        }
        var name = page.node.newXObject('Image', embedded[im.id].ref);
        var bl = conv(im.x, im.y + im.h), br = conv(im.x + im.w, im.y + im.h), tl = conv(im.x, im.y);
        ops.push(L.pushGraphicsState(),
          L.concatTransformationMatrix(br[0] - bl[0], br[1] - bl[1], tl[0] - bl[0], tl[1] - bl[1], bl[0], bl[1]),
          L.drawObject(name), L.popGraphicsState());
      }
      // 線
      list.forEach(function (s) {
        if (!s || s.tool === 'image' || !Array.isArray(s.points) || !s.points.length) return;
        var p = s.points, col = rgb(s.color), base = (+s.width || 4) * v.width / 1000;
        var pts = p.map(function (pt) { return conv(pt[0], pt[1]); });
        var pr = function (j) { return isFinite(p[j][2]) ? p[j][2] : 0.5; };
        var wAt = s.tool === 'pencil' ? function (x) { return base * (0.45 + 0.9 * x); } : function (x) { return base * (0.6 + 0.8 * x); };
        ops.push(L.pushGraphicsState(), L.setStrokingRgbColor(col[0], col[1], col[2]),
          L.setLineCap(L.LineCapStyle.Round), L.setLineJoin(L.LineJoinStyle.Round));
        if (s.tool === 'highlighter') {
          if (!gsHl) gsHl = page.maybeEmbedGraphicsState({ opacity: 0.35, borderOpacity: 0.35 });
          ops.push(L.setGraphicsState(gsHl), L.setLineWidth(base * 5), L.moveTo(pts[0][0], pts[0][1]));
          for (var i = 1; i < pts.length; i++) ops.push(L.lineTo(pts[i][0], pts[i][1]));
          if (pts.length === 1) ops.push(L.lineTo(pts[0][0] + 0.01, pts[0][1]));
          ops.push(L.stroke());
        } else {
          if (s.tool === 'pencil') {
            if (!gsPc) gsPc = page.maybeEmbedGraphicsState({ opacity: 0.85, borderOpacity: 0.85 });
            ops.push(L.setGraphicsState(gsPc));
          }
          if (pts.length === 1) {
            ops.push(L.setLineWidth(wAt(pr(0))), L.moveTo(pts[0][0], pts[0][1]),
              L.lineTo(pts[0][0] + 0.01, pts[0][1]), L.stroke());
          } else {
            // 筆圧で太さが変わる。同じ太さが続く部分はまとめて1本で描く
            var lastW = null;
            for (var j = 1; j < pts.length; j++) {
              var w = Math.round(wAt((pr(j) + pr(j - 1)) / 2) * 20) / 20;
              if (w !== lastW) {
                if (lastW !== null) ops.push(L.stroke());
                ops.push(L.setLineWidth(w), L.moveTo(pts[j - 1][0], pts[j - 1][1]));
                lastW = w;
              }
              ops.push(L.lineTo(pts[j][0], pts[j][1]));
            }
            ops.push(L.stroke());
          }
        }
        ops.push(L.popGraphicsState());
      });
      if (ops.length) page.pushOperators.apply(page, ops);
    }
    if (c && c.base) pdf.getInfoDict().set(L.PDFName.of('TegakiBase'), L.PDFString.of(c.base));
    return pdf.save();
  }

  function readStrokes(base) {
    try { return JSON.parse(localStorage.getItem('strokes:pdf:' + base)) || { pages: {} }; }
    catch (e) { return { pages: {} }; }
  }
  function jsonBase(name) { return String(name || 'PDF').replace(/\.pdf$/i, ''); }

  /* Driveの元のPDFに反映する。force: ボタンから（ほかで変更されていても、確認のうえ上書きできる） */
  async function flush(c, force) {
    if (!c) return;
    if (busy) { again = c; return; }
    var m = readMeta(c.base);
    if (!m.dirty && !(force && m.conflict)) return;
    busy = true;
    var token = await GAuth.ensure(); // 切れていれば、画面を出さずに自動更新
    if (!token) {
      busy = false;
      if (force) note('PDFへの反映は、Driveにログインしてから行います');
      if (again) { var a0 = again; again = null; flush(a0); }
      return;
    }
    if (c === cur) { clearTimeout(timer); timer = null; }
    var dirtyAt = m.dirtyAt;
    try {
      // 1. 書き換えるPDFを探す
      var orig = await Drive.findOriginal(c.base, token);
      var expect = [m.md5, orig && orig.appProperties && orig.appProperties.lastMd5, c.fileMd5, c.origMd5]
        .filter(function (x) { return !!x; });
      var target = null;
      if (m.fileId) {
        try { var fm = await Drive.getMeta(m.fileId, token); if (!fm.trashed) target = fm; }
        catch (e) { if (e.status !== 404) throw e; }
      }
      if (!target) target = await Drive.findPdf(c.name, expect, token);
      if (!target) {
        m = readMeta(c.base); m.dirty = false; writeMeta(c.base, m);
        note('このPDFはDriveに見つからないため、PDFへの反映はしていません（手書きデータはDriveに保存されます）');
        return;
      }
      if (target.capabilities && target.capabilities.canEdit === false) {
        m = readMeta(c.base); m.dirty = false; writeMeta(c.base, m);
        note('このPDFは書き換える権限がないため、PDFへの反映はしていません');
        return;
      }
      // 2. ほかのアプリや端末で変更されていたら、勝手に上書きしない
      if (expect.indexOf(target.md5Checksum) < 0) {
        var ok = force && window.confirm(
          '「' + c.name + '」が、ほかのアプリや端末で変更されています。\n\n' +
          'OK：このアプリの書き込みで上書きする（ほかで加えた変更は消えます。Driveの「版を管理」から戻せます）\n' +
          'キャンセル：上書きしない');
        if (!ok) {
          m = readMeta(c.base); m.conflict = true; writeMeta(c.base, m);
          note('PDFがほかで変更されていたため、反映を止めました。「Drive」ボタンを押すと上書きするか選べます');
          return;
        }
      }
      note('PDFに書き込みを反映中…');
      // 3. 元のPDFの控えをDriveに置く（初回だけ）
      if (!orig) {
        var folderId = await Drive.ensureFolder(token);
        orig = await Drive.createOriginal(folderId, jsonBase(c.name) + '（書き込み前）.pdf', c.base, c.origBytes, target.md5Checksum, token);
      }
      // 4. 書き込み入りPDFを作って上書き
      var bytes = await bake(c, readStrokes(c.base));
      var res = await Drive.uploadPdf(target.id, bytes, token);
      var m2 = readMeta(c.base);
      m2.fileId = target.id; m2.md5 = res.md5Checksum; m2.at = Date.now(); m2.conflict = false;
      m2.dirty = m2.dirtyAt !== dirtyAt; // 送っている間にまた書いたら、まだ反映が必要
      writeMeta(c.base, m2);
      try { await Drive.setAppProps(orig.id, { lastMd5: res.md5Checksum }, token); } catch (e) { console.error(e); }
      note('PDFに書き込みを反映しました（' + hhmm() + '）');
      if (m2.dirty && c === cur && !timer) schedule(INTERVAL);
    } catch (e) {
      console.error(e);
      if (e.status === 401) { GAuth.invalidate(); note('PDFへの反映は、Driveにログインし直してから行います'); }
      else if (e.status === 403) note('Driveの権限が足りないため、PDFに反映できませんでした（ログインし直してください）');
      else if (e.message === 'lib_load') note('通信できないため、PDFへの反映はあとで行います');
      else if (/encrypt/i.test(e.message || '')) {
        m = readMeta(c.base); m.dirty = false; writeMeta(c.base, m);
        note('このPDFは保護されているため、書き込みを反映できません（手書きデータはDriveに保存されます）');
      }
      else note('PDFへの反映に失敗しました。あとでもう一度試します');
      if (e.status !== 401 && e.status !== 403 && c === cur && readMeta(c.base).dirty) schedule(RETRY);
    } finally {
      busy = false;
      if (again) { var a = again; again = null; flush(a); }
    }
  }

  // 手書きがこの端末に保存されたとき → 30分後に反映
  var prevSaved = App.hooks.saved;
  App.hooks.saved = function (key) {
    if (prevSaved) prevSaved(key);
    if (!cur || key !== 'strokes:pdf:' + cur.base) return;
    var m = readMeta(cur.base);
    m.dirty = true; m.dirtyAt = Date.now();
    writeMeta(cur.base, m);
    if (!timer && !busy) schedule(INTERVAL);
  };

  // ファイルを開いたとき → 前のPDFに未反映の分があれば反映する
  var prevOpened = App.hooks.opened;
  App.hooks.opened = function (key, name) {
    var prev = cur;
    var p = window.PdfOpen && PdfOpen.takePending();
    cur = p && key === 'strokes:pdf:' + p.base ? p : null;
    clearTimeout(timer); timer = null;
    if (prevOpened) prevOpened(key, name);
    if (prev && prev !== cur && readMeta(prev.base).dirty) flush(prev);
    // 前回反映できなかった分が残っていれば、少し待ってから反映
    if (cur && readMeta(cur.base).dirty) schedule(15000);
  };

  // アプリを離れるとき（ほかのアプリに切り替える・閉じる）は、待たずに反映
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && cur && readMeta(cur.base).dirty) flush(cur);
  });
  window.addEventListener('online', function () {
    if (cur && readMeta(cur.base).dirty) schedule(5000);
  });
  // 「Drive」ボタン → 今すぐ反映
  document.getElementById('syncBtn').addEventListener('click', function () {
    if (cur && GAuth.hasToken()) flush(cur, true);
  });

  window.PdfWrite = { flush: function (force) { return flush(cur, force); }, bake: bake, loadLib: loadLib, current: function () { return cur; } };
})();
