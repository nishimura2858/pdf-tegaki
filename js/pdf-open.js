/* 「ファイルから開く」: iPadのファイルアプリ（Googleドライブを含む）からPDFを選んで開く
   - 手書きは「PDFの中身」から作った識別子（SHA-256）で結びつける。置き場所や名前が変わっても同じ手書きが出る
   - 書き込み入りPDF（元のPDFに書き込みを反映したもの）を開いたときは、元のPDF＋手書きデータとして開く
   - 開いたPDFはこの端末（IndexedDB）に控えを取る。ログインで画面を離れて戻ったときや、
     次にアプリを開いたときに、前回のPDFを自動で開き直すため
   - 最近開いたPDF（12個まで）も控えておき、ホーム画面（home.js）からタップ1回で開ける
     IndexedDB: 'recentIndex' = [{ id, name, at }]（id はファイルの中身の SHA-256）,
                'recent:<id>' = { name, data }, 'thumb:<id>' = 1ページ目の小さな絵（data URL） */
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
    org_internal: 'このアカウントでは利用できません（組織の制限）',
    token_exchange_failed: 'ログインの仕上げに失敗しました。もう一度お試しください',
    not_configured: 'ログインサーバーの準備ができていません',
    invalid_grant: 'ログインの有効期限が切れました。もう一度お試しください'
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
    var token = await GAuth.ensure();
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
      return sha;
    }
    var orig = null;
    try { orig = await getOriginal(base); } catch (e) { console.error(e); if (e.status === 401) GAuth.invalidate(); }
    if (!orig) {
      // 元のPDFが手元にない（ほかの端末で書き込んだPDFなど）。ログインすれば取り寄せられる
      pending = null; needLogin = !GAuth.hasToken();
      App.openDoc(doc, name, 'strokes:view:' + sha);
      App.setStatus(needLogin
        ? '書き込み入りのPDFです。続きを書くには「Driveにログイン」を押してください（元のPDFを取り寄せます）'
        : '書き込み入りのPDFですが、元のPDFが見つからないため、このまま表示しています');
      return sha;
    }
    var odoc = await load(orig);
    pending = { base: base, name: name, fileMd5: fileMd5, origBytes: orig, origMd5: md5(orig), doc: odoc };
    App.openDoc(odoc, name, 'strokes:pdf:' + base);
    return sha;
  }

  /* ---------- 最近開いたPDF ---------- */
  var RECENT_MAX = 12, curRecent = null;
  function recentIndex() {
    return idb('readonly', function (st) { return st.get('recentIndex'); })
      .then(function (l) { return Array.isArray(l) ? l : []; }, function () { return []; });
  }
  function addRecent(id, name, buf) {
    return idb('readwrite', function (st) {
      st.put({ name: name, data: buf }, 'recent:' + id);
      var g = st.get('recentIndex');
      g.onsuccess = function () {
        var list = (Array.isArray(g.result) ? g.result : []).filter(function (x) { return x.id !== id; });
        list.unshift({ id: id, name: name, at: Date.now() });
        list.slice(RECENT_MAX).forEach(function (x) { st.delete('recent:' + x.id); dropThumb(st, x.id); });
        st.put(list.slice(0, RECENT_MAX), 'recentIndex');
      };
    }).catch(function (err) { console.error(err); });
  }
  // 小さな絵は、お気に入りに入っていれば残す
  function dropThumb(st, id) {
    var g = st.get('favIndex');
    g.onsuccess = function () {
      var items = g.result && Array.isArray(g.result.items) ? g.result.items : [];
      if (!items.some(function (x) { return x.id === id; })) st.delete('thumb:' + id);
    };
  }
  function removeRecent(id) {
    return idb('readwrite', function (st) {
      st.delete('recent:' + id); dropThumb(st, id);
      var g = st.get('recentIndex');
      g.onsuccess = function () {
        st.put((Array.isArray(g.result) ? g.result : []).filter(function (x) { return x.id !== id; }), 'recentIndex');
      };
    }).catch(function (err) { console.error(err); });
  }
  function thumbs(ids) {
    var out = {};
    return idb('readonly', function (st) {
      ids.forEach(function (id) { var r = st.get('thumb:' + id); r.onsuccess = function () { if (r.result) out[id] = r.result; }; });
    }).then(function () { return out; }, function () { return out; });
  }
  // いま開いているPDFの1ページ目（手書きも入れて）を小さな絵にして取っておく
  var thumbTimer = null;
  function saveThumb(delay) {
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(function () {
      var id = curRecent; if (!id || !App.S.hasFile) return;
      var c = document.createElement('canvas');
      App.renderThumb(c, 1, 120).then(function () {
        var url = c.toDataURL('image/jpeg', 0.75);
        c.width = c.height = 0;
        if (id !== curRecent) return;
        return idb('readwrite', function (st) { st.put(url, 'thumb:' + id); });
      }).catch(function (err) { console.error(err); });
    }, delay);
  }
  App.on('data', function () { saveThumb(4000); });
  // 開いたPDFを「最近」の先頭に入れる
  function remember(id, name, buf) {
    curRecent = id || null;
    if (!id) return;
    addRecent(id, name, buf).then(function () { saveThumb(1200); });
  }

  /* 端末に取っておいたPDFを開く（key: 'recent:<id>' または 'fav:<id>'）。開けたら true */
  async function openStored(key, id) {
    try {
      var rec = await idb('readonly', function (st) { return st.get(key); });
      if (!rec || !rec.data) {
        App.setStatus('このPDFの控えが見つかりませんでした');
        if (key.indexOf('recent:') === 0) await removeRecent(id);
        return false;
      }
      App.setStatus('読み込み中…');
      var sha = await openBytes(rec.data, rec.name);
      remember(sha, rec.name, rec.data);
      saveLast({ name: rec.name, data: rec.data, at: Date.now() }).catch(function (err) { console.error(err); });
      return true;
    } catch (err) {
      console.error(err);
      App.setStatus('PDFを開けませんでした');
      return false;
    }
  }
  var $ = function (id) { return document.getElementById(id); };
  // 左上のフォルダのボタン: ホーム画面（PDFを選ぶ画面）に戻る
  $('openBtn').addEventListener('click', function () { Home.show(); });

  document.getElementById('file').addEventListener('change', async function (e) {
    var f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      App.setStatus('読み込み中…');
      var buf = await f.arrayBuffer();
      var sha = await openBytes(buf, f.name);
      remember(sha, f.name, buf);
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
      curRecent = await openBytes(rec.data, rec.name);
      if (curRecent) addRecent(curRecent, rec.name, rec.data).then(function () { saveThumb(1500); }); // 前のバージョンで開いたPDFも一覧に入れる
      return true;
    } catch (err) {
      console.error(err);
      if (!quietIfNone) App.setStatus('PDFを開き直せませんでした。「ファイルから開く」で選んでください');
      return false;
    }
  }

  // 起動時: ログインから戻ってきたときは結果を伝え、どちらの場合も前回のPDFを開く
  (async function () {
    var r = await GAuth.consumeRedirect();
    if (r) GAuth.takeAfter();
    // ふだんはホーム画面（PDFを選ぶ画面）から始める。
    // ログインから戻ったときと、新しい版に切り替えて読み直したときだけ、前のPDFを開き直す
    var again = false;
    try { again = sessionStorage.getItem('tegaki:reopen') === '1'; sessionStorage.removeItem('tegaki:reopen'); } catch (e) {}
    var opened = (r || again) ? await reopenLast(!r) : false;
    if (!opened) Home.render().catch(function () {});
    if (r && r.error) App.setStatus(message(r.error));
    else if (r && opened && !needLogin) App.setStatus('ログインしました');
  })();

  window.PdfOpen = {
    reopenLast: reopenLast, message: message, idb: idb, recentIndex: recentIndex, thumbs: thumbs,
    openStored: openStored, removeRecent: removeRecent, current: function () { return curRecent; }, md5: md5, getOrigLocal: getOrigLocal,
    needLogin: function () { return needLogin; },
    takePending: function () { var p = pending; pending = null; return p; }
  };
})();
