/* PDFとして共有: 書き込み入りのPDFを作って、iPadの共有メニュー（メール・LINE・ファイルに保存など）を出す */
(function () {
  'use strict';
  var App = window.App, S = App.S;
  var $ = function (id) { return document.getElementById(id); };
  var file = null, busy = false;

  function fileName() {
    return (String(S.name || 'ノート').replace(/\.pdf$/i, '') || 'ノート') + '（書き込み入り）.pdf';
  }
  async function build() {
    App.flushSave();
    var c = null;
    if (S.pdf) {
      c = window.PdfWrite && PdfWrite.current();
      if (!c || S.key !== 'strokes:pdf:' + c.base) throw new Error('no_original');
    } else c = { origBytes: null, doc: null, base: '' }; // 白紙のノート
    var bytes = await PdfWrite.bake(c, App.exportData());
    return new File([bytes], fileName(), { type: 'application/pdf' });
  }
  function download(f) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
  }
  async function share(f) {
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      try { await navigator.share({ files: [f], title: f.name }); return true; }
      catch (e) {
        if (e.name === 'AbortError') return true;  // 共有メニューを閉じた
        if (e.name === 'NotAllowedError') return false; // 準備に時間がかかった → もう一度タップしてもらう
        throw e;
      }
    }
    download(f);
    return true;
  }
  function openDlg(f) {
    file = f;
    $('shareName').textContent = f.name;
    $('shareDlg').classList.add('open');
  }
  function closeDlg() { $('shareDlg').classList.remove('open'); file = null; }

  $('shareBtn').addEventListener('click', async function () {
    if (!S.hasFile) { App.setStatus('先にPDFを開いてください'); return; }
    if (busy) return;
    busy = true;
    App.setStatus('PDFを作っています…');
    try {
      var f = await build();
      if (!(await share(f))) openDlg(f);
    } catch (e) {
      console.error(e);
      App.setStatus(e.message === 'no_original'
        ? 'このPDFは元のPDFが手元にないため、共有できません（Driveにログインすると取り寄せられます）'
        : e.message === 'lib_load' ? '通信できないため、PDFを作れませんでした' : 'PDFを作れませんでした');
    } finally { busy = false; }
  });
  $('shareGo').addEventListener('click', function () {
    var f = file; closeDlg();
    if (f) share(f).catch(function (e) { console.error(e); App.setStatus('共有できませんでした'); });
  });
  $('shareClose').addEventListener('click', closeDlg);
})();
