/* 「ファイルから開く」: iPadのファイルアプリ（Googleドライブを含む）からPDFを選んで開く
   - 手書きは「PDFの中身」から作った識別子（SHA-256）で結びつける。置き場所や名前が変わっても同じ手書きが出る
   - 書き込み入りPDF（元のPDFに書き込みを反映したもの）を開いたときは、元のPDF＋手書きデータとして開く
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
  // 最後に開いたPDF（'last'）と、書き込む前の元のPDF（'orig:<識別子>'）を持つ
  function saveLast(rec) { return idb('readwrite', function (st) { st.put(rec, 'last'); }); }
  function loadLast() { return idb('readonly', function (st) { return st.get('last'); }); }
  function getOrigLocal(hash) {
    return idb('readonly', function (st) { return st.get('orig:' + hash); })
      .then(function (r) { return r && r.data ? r.data : null; }, function () { return null; });
  }
  var KEEP_ORIG = 15; // 元のPDFの控えは、最近使った15個まで
  function putOrigLocal(hash, data) {
    return idb('readwrite', function (st) {
      st.put({ data: data, at: Date.now() }, 'orig:' + hash);
      var list = [];
      st.openCursor().onsuccess = function (e) {
        var c = e.target.result;
        if (c) { if (String(c.key).indexOf('orig:') === 0 && c.key !== 'orig:' + hash) list.push({ k: c.key, at: c.value.at || 0 }); c.continue(); return; }
        list.sort(function (a, b) { return b.at - a.at; });
        list.slice(KEEP_ORIG - 1).forEach(function (x) { st.delete(x.k); });
      };
    }).catch(function (err) { console.error(err); });
  }

  function hex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  async function sha256(buf) { return hex(await crypto.subtle.digest('SHA-256', buf)); }
  function md5(buf) { return window.SparkMD5 ? SparkMD5.ArrayBuffer.hash(buf) : ''; }
  // pdf.js は渡した配列を作業用に使ってしまうので、コピーを渡す
  function load(buf) { return pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise; }

  // 書き込み入りPDF（このアプリが書き込みを反映したPDF）なら、元のPDFの識別子を返す
  async function bakedBase(doc, sha) {
    try {
      var m = await doc.getMetadata();
      var b = m && m.info && m.info.Custom && m.info.Custom.TegakiBase;
      b = b && String(b.name || b);
      return b && /^[0-9a-f]{64}$/.test(b) && b !== sha ? b : null;
    } catch (e) { return null; }
  }
  // 元のPDFを、この端末の控え → Drive の控え の順に探す
  async function getOriginal(base) {
    var data = await getOrigLocal(base);
    if (data) return data;
    var token = GAuth.current();
    if (!token) return null;
    var f = await Drive.findOriginal(base, token);
    if (!f) return null;
    data = await Drive.downloadFile(f.id, token);
    if ((await sha256(data)) !== base) return null;
    putOrigLocal(base, data);
    return data;
  }

  var pending = null; // 開こうとしているPDFの情報（元のPDFへの反映で使う）
  var needLogin = false;

  /* PDFを開く。書き込み入りPDFのときは、元のPDF＋手書きデータとして開く
     （前の書き込みも消しゴムで消せるように） */
  async function openBytes(buf, name) {
    var sha = await sha256(buf), fileMd5 = md5(buf);
    var doc = await load(buf);
    var base = await bakedBase(doc, sha);
    needLogin = false;
    if (!base) {
      pending = { base: sha, name: name, fileMd5: fileMd5, origBytes: buf, origMd5: fileMd5, doc: doc };
      App.openDoc(doc, name, 'strokes:pdf:' + sha);
      putOrigLocal(sha, buf);
      return true;
    }
    var orig = null;
    try { orig = await getOriginal(base); } catch (e) { console.error(e); if (e.status === 401) GAuth.invalidate(); }
    if (!orig) {
      // 元のPDFが手元にない（ほかの端末で書き込んだPDFなど）。ログインすれば取り寄せられる
      pending = null; needLogin = !GAuth.current();
      App.openDoc(doc, name, 'strokes:view:' + sha);
      App.setStatus(needLogin
        ? '書き込み入りのPDFです。続きを書くには「Driveにログイン」を押してください（元のPDFを取り寄せます）'
        : '書き込み入りのPDFですが、元のPDFが見つからないため、このまま表示しています');
      return true;
    }
    var odoc = await load(orig);
    pending = { base: base, name: name, fileMd5: fileMd5, origBytes: orig, origMd5: md5(orig), doc: odoc };
    App.openDoc(odoc, name, 'strokes:pdf:' + base);
    return true;
  }

  document.getElementById('file').addEventListener('change', async function (e) {
    var f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      App.setStatus('読み込み中…');
      var buf = await f.arrayBuffer();
      await openBytes(buf, f.name);
      saveLast({ name: f.name, data: buf, at: Date.now() }).catch(function (err) { console.error(err); });
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
      await openBytes(rec.data, rec.name);
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
    else if (r && opened && !needLogin) App.setStatus('ログインしました');
  })();

  window.PdfOpen = {
    reopenLast: reopenLast, message: message, md5: md5, getOrigLocal: getOrigLocal,
    needLogin: function () { return needLogin; },
    takePending: function () { var p = pending; pending = null; return p; }
  };
})();
