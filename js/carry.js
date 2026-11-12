/* 前の版の手書きを引き継ぐ
   - Wordを直してPDFを作り直すと、PDFの中身が変わるので、手書きは別の資料として扱われる
   - そこで、手書きがまだない新しいPDFを開いたとき、同じ名前のPDFに書いた手書きを探して、
     「前の版の手書きを引き継ぎますか？」と聞く（同じ名前の別の資料もあり得るので、勝手には乗せない）
   - 探す場所: この端末（localStorage の strokes:pdf:<識別子>）と、Driveの「PDF手書きデータ」（○○.strokes.json）
   - 位置は前の版のまま。ページが減ったときも、なくなったページの手書きは消さずにデータに残す
   - 「いいえ」を選んだら、その版ではもう聞かない（localStorage「carry:no:<識別子>」） */
(function () {
  'use strict';
  var App = window.App;
  var HIDE = 1000; // 行き場のなくなったページの手書きを置く番号（画面には出ないが、データには残る）

  function base(name) {
    return String(name || '').normalize('NFC').replace(/\.pdf$/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  function hasPages(d) {
    if (!d || !d.pages) return false;
    for (var k in d.pages) if (Array.isArray(d.pages[k]) && d.pages[k].length) return true;
    return false;
  }
  function readJson(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }

  // この端末にある、同じ名前の別のPDFの手書き（いちばん新しいもの）
  async function findLocal(sha, name) {
    var times = {};
    try {
      (await PdfOpen.recentIndex()).forEach(function (x) { times[x.id] = x.at || 0; });
    } catch (e) {}
    var best = null;
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i), m = /^strokes:pdf:([0-9a-f]{64})$/.exec(k || '');
      if (!m || m[1] === sha) continue;
      var d = readJson(k);
      if (!d || base(d.pdf) !== base(name) || !hasPages(d)) continue;
      var meta = readJson('sync:' + m[1]) || {};
      var at = Math.max(times[m[1]] || 0, meta.dirtyAt || 0);
      if (!best || at > best.at) best = { at: at, data: d };
    }
    return best;
  }

  // Driveにある、同じ名前の別のPDFの手書き（いちばん新しいもの）。この版の手書きが既にDriveにあれば 'mine'
  async function findDrive(sha, name, token) {
    if (await Drive.findStrokes(sha, token)) return 'mine';
    var files = await Drive.findStrokesByName(String(name || 'PDF').replace(/\.pdf$/i, '') + '.strokes.json', token);
    var f = files.filter(function (x) { var h = x.appProperties && x.appProperties.pdfHash; return h && h !== sha; })[0];
    if (!f) return null;
    var d = await Drive.getJson(f.id, token);
    if (!hasPages(d)) return null;
    return { at: Date.parse(f.modifiedTime) || 0, data: d };
  }

  /* 前の版のデータを、新しいPDF（ページ数 max）に合うように直す */
  function adapt(d, max) {
    var pages = {}, hidden = HIDE;
    function hide(arr) { pages[++hidden] = arr; }
    if (!Array.isArray(d.layout) || !d.layout.length) {
      // ページを足していない: ページ番号はそのまま（なくなったページの分は画面に出ないだけで、データに残る。
      // あとでページが戻れば、また見える）
      return { version: 1, pdf: d.pdf, images: d.images, pages: d.pages };
    }
    // ページを足している: 元のPDFのページと足したページの並びを、新しいPDFに合わせて作り直す
    var layout = [], seen = {};
    d.layout.forEach(function (e, i) {
      var src = Math.floor(+(e && e.src)), arr = d.pages[i + 1];
      if (src === 0 || (src >= 1 && src <= max && !seen[src])) {
        if (src > 0) seen[src] = true;
        layout.push(e);
        if (arr) pages[layout.length] = arr;
      } else if (arr) hide(arr);
    });
    // 新しく増えたページは、前のページのすぐ後ろに入れる
    for (var s = 1; s <= max; s++) {
      if (seen[s]) continue;
      var at = 0;
      layout.forEach(function (e, j) { if (e.src > 0 && e.src < s) at = j + 1; });
      layout.splice(at, 0, { src: s });
      var moved = {};
      Object.keys(pages).forEach(function (k) { var n = +k; moved[n > at && n <= HIDE ? n + 1 : n] = pages[k]; });
      pages = moved; seen[s] = true;
    }
    // 見えない所の手書きは、ページの並びの後ろに置く（ページ数より大きい番号）
    var out = {}, extra = layout.length;
    Object.keys(pages).forEach(function (k) { var n = +k; out[n > HIDE ? ++extra : n] = pages[k]; });
    return { version: 1, pdf: d.pdf, layout: layout, images: d.images, pages: out };
  }

  /* 新しく開いたPDFについて、前の版の手書きを探して聞く */
  async function check(sha, name, max) {
    var key = 'strokes:pdf:' + sha;
    try {
      if (localStorage.getItem('carry:no:' + sha) || localStorage.getItem(key)) return;
      var found = await findLocal(sha, name);
      if (window.GAuth && GAuth.hasToken()) {
        try {
          var token = await GAuth.ensure();
          if (token) {
            var r = await findDrive(sha, name, token);
            if (r === 'mine') return; // この版の手書きはDriveにある（同期で読み込まれる）
            if (r && (!found || r.at >= found.at)) found = r;
          }
        } catch (e) { console.error(e); }
      }
      // 探している間に、別のPDFを開いた・書き始めた・Driveから読み込まれた
      if (!found || App.currentKey() !== key || App.hasStrokes()) return;
      var ok = window.confirm(
        '「' + name + '」の前の版に書いた手書きがあります。この版に引き継ぎますか？\n\n' +
        '手書きは前と同じ位置に乗ります。Wordで行がずれたところは、投げ縄で囲んで動かしてください。');
      if (App.currentKey() !== key || App.hasStrokes()) return;
      if (!ok) { localStorage.setItem('carry:no:' + sha, '1'); return; }
      if (!App.replaceData(adapt(found.data, max))) { App.setStatus('引き継げませんでした。もう一度開き直してください'); return; }
      App.scheduleSave(); // この版の手書きとして、この端末とDriveに保存する
      App.setStatus('前の版の手書きを引き継ぎました');
    } catch (e) { console.error(e); }
  }

  window.Carry = { check: check, adapt: adapt };
})();
