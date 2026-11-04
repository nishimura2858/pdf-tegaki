/* 「ファイルから開く」: iPadのファイルアプリ（Googleドライブを含む）からPDFを選んで開く
   - 手書きは「PDFの中身」から作った識別子（SHA-256）で結びつける。置き場所や名前が変わっても同じ手書きが出る
   - 開いたPDFはこの端末（IndexedDB）に控えを取る。ログインで画面を離れて戻ったときや、
     次にアプリを開いたときに、前回のPDFを自動で開き直すため */
(function () {
  'use strict';
  var App = window.App;
  var DB = 'pdf-tegaki', STORE = 'pdfs';

  var MESSAGES = {
    popup_failed_to_open: 'ログイン画面を開けませんでした（ポップアップがブロックされている可能性があります）',
    popup_closed: 'ログインが中断されました',
    access_denied: 'Googleへのアクセスが許可されませんでした',
    scope_denied: 'Driveへのアクセスが許可されていません。ログイン時にチェックを入れてください',
    state_mismatch: 'ログインの確認に失敗しました。もう一度お試しください',
    admin_policy_enforced: 'このアカウントでは管理者が外部アプリの利用を制限しています',
    org_internal: 'このアカウントでは利用できません（組織の制限）'
  };
  function message(code) { return MESSAGES[code] || ('ログインできませんでした（' + (code || '不明なエラー') + '）'); }

  /* ---------- この端末へのPDFの控え ---------- */
  function db() {
    return new Promise(function (resolve, reject) {
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function idb(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE, mode), st = tx.objectStore(STORE), out;
        var req = fn(st);
        if (req) req.onsuccess = function () { out = req.result; };
        tx.oncomplete = function () { d.close(); resolve(out); };
        tx.onerror = tx.onabort = function () { d.close(); reject(tx.error); };
      });
    });
  }
  // 控えは最後に開いた1つだけ持つ（容量を食わないように）
  function saveLast(rec) { return idb('readwrite', function (st) { st.put(rec, 'last'); }); }
  function loadLast() { return idb('readonly', function (st) { return st.get('last'); }); }

  function hex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  async function show(buf, name, hash) {
    // pdf.js は渡した配列を作業用に使ってしまうので、コピーを渡す
    var doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
    App.openDoc(doc, name, 'strokes:pdf:' + hash);
  }

  document.getElementById('file').addEventListener('change', async function (e) {
    var f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      App.setStatus('読み込み中…');
      var buf = await f.arrayBuffer();
      var hash = hex(await crypto.subtle.digest('SHA-256', buf));
      await show(buf, f.name, hash);
      saveLast({ name: f.name, hash: hash, data: buf, at: Date.now() }).catch(function (err) { console.error(err); });
    } catch (err) {
      console.error(err);
      App.setStatus('PDFを開けませんでした');
    }
  });

  // 前回のPDFを開き直す
  async function reopenLast(quietIfNone) {
    try {
      var rec = await loadLast();
      if (!rec || !rec.data) { if (!quietIfNone) App.setStatus('PDFを開き直せませんでした。「ファイルから開く」で選んでください'); return false; }
      await show(rec.data, rec.name, rec.hash);
      return true;
    } catch (err) {
      console.error(err);
      if (!quietIfNone) App.setStatus('PDFを開き直せませんでした。「ファイルから開く」で選んでください');
      return false;
    }
  }

  // 起動時: ログインから戻ってきたときは結果を伝え、どちらの場合も前回のPDFを開く
  (async function () {
    var r = GAuth.consumeRedirect();
    if (r) GAuth.takeAfter();
    var opened = await reopenLast(!r);
    if (r && r.error) App.setStatus(message(r.error));
    else if (r && opened) App.setStatus('ログインしました');
  })();

  window.PdfOpen = { reopenLast: reopenLast, message: message };
})();
