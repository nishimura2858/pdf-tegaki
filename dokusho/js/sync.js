/* Driveへの保存（同期）
   ■ 本の書き込み（ペン・マーカー・付箋）
     - 本ごとに1つの .json を、Driveの「読書ノート/_アプリのデータ/書き込み」に置く
     - この端末への保存はすぐ行い、Driveへは書き終えて約10秒後と、アプリを離れたときに送る
     - 本を開いたときにDrive側が新しければ読み込む。両方で書き換えていたら、どちらを残すか聞く
     - 読んでいたページも一緒に送る（別の端末で開いたとき、続きから読めるように）
     この端末での記録: localStorage「dk:sync:<本のid>」= { fileId, md5, dirty, dirtyAt, pos }
   ■ スクラップブック
     - スクラップブックごとのフォルダに、ページの絵（.jpg）と scrap.json（並び・出典・書き込み）を置く
     - 新しく入れたページの絵だけを送るので、通信量は少ない
   仕組みは、手書きノートの drive-sync.js と同じ（中身の指紋 MD5 で、別の端末の変更を見分ける） */
(function () {
  'use strict';
  var App = window.App, S = App.S;
  var btn = document.getElementById('syncBtn');
  var DELAY = 10000;
  var cur = null;        // 開いている本 { id, name }（スクラップブックのときは null）
  var timer = null, busy = false, again = false, state = '';

  function readMeta(id) { try { return JSON.parse(localStorage.getItem('dk:sync:' + id)) || {}; } catch (e) { return {}; } }
  function writeMeta(id, m) { try { localStorage.setItem('dk:sync:' + id, JSON.stringify(m)); } catch (e) {} }
  function keepBackup(id, json) { Store.putKV('backup:' + id, { at: Date.now(), json: json }).catch(function () {}); }

  function show(s, text) {
    var warn = s === 'login' || s === 'error';
    if (warn && s !== state) App.setStatus(text); // 注意が必要な状態に変わったときは、下のお知らせでも伝える
    state = s;
    btn.hidden = false;
    document.getElementById('syncText').textContent = text;
    btn.title = text; btn.setAttribute('aria-label', text);
    btn.className = 'btn icon s-' + s;
    btn.classList.toggle('warn', warn);
    App.dbg('Drive同期: ' + text);
  }
  function jsonName(name) { return String(name || '本').replace(/\.pdf$/i, '') + '.json'; }
  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(function () { timer = null; sync(); }, ms);
  }
  function body() {
    var d = App.exportData();
    d.pos = { page: S.page, at: Date.now() };
    return JSON.stringify(d);
  }

  /* ---------- 本の書き込み ---------- */
  async function sync() {
    if (!cur) return;
    if (busy) { again = true; return; }
    clearTimeout(timer); timer = null;
    var c0 = cur;
    busy = true;
    var token = await GAuth.ensure(); // 切れていれば、画面を出さずに自動更新
    busy = false;
    if (c0 !== cur) { if (again) { again = false; schedule(500); } return; }
    if (!token) {
      if (GAuth.hasToken()) { show('error', 'Drive保存失敗・再試行'); return; } // 通信できないなど → あとで再試行
      show('login', readMeta(cur.id).dirty ? 'Drive未保存・ログイン' : 'Driveにログイン');
      return;
    }
    busy = true;
    var c = cur;
    try {
      var m = readMeta(c.id);
      show('busy', m.dirty ? 'Drive保存中…' : 'Drive確認中…');
      var remote = await DriveX.findAnn(c.id, token);
      if (c !== cur) return;
      var overwriteId = null;
      // Drive側が、この端末が最後に同期したときから変わっている（中身の指紋で比べる）
      var remoteChanged = remote && (remote.id !== m.fileId || (!!m.md5 && !!remote.md5Checksum && remote.md5Checksum !== m.md5));
      if (remoteChanged) {
        var data = await DriveX.getJson(remote.id, token);
        if (c !== cur) return;
        var now = readMeta(c.id), useRemote = true;
        if (now.dirty && App.hasStrokes()) {
          useRemote = window.confirm(
            '「' + Library.bare(c.name) + '」の書き込みが、別の端末でも書き換えられています。\n\n' +
            'OK：Driveの内容に置き換える\n' +
            'キャンセル：この端末の内容でDriveを上書きする\n\n' +
            '選ばなかった方は、この端末に控えとして残します。');
          if (c !== cur) return;
          keepBackup(c.id, useRemote ? App.exportJson() : JSON.stringify(data));
        }
        if (useRemote) {
          if (!App.replaceData(data)) { again = true; return; } // 書いている最中なら、あとでやり直す
          writeMeta(c.id, { fileId: remote.id, md5: remote.md5Checksum, dirty: false, dirtyAt: 0 });
          var p = data && data.pos && Math.floor(+data.pos.page);
          if (p >= 1 && p <= S.total && p !== S.page) {
            App.goPage(p);
            App.setStatus('別の端末で読んでいたページ（' + p + 'ページ）を開きました');
          } else App.setStatus('Driveの書き込みを読み込みました');
          show('ok', 'Drive保存済み');
          return;
        }
        overwriteId = remote.id;
      }

      var before = readMeta(c.id);
      var target = overwriteId || (remote && remote.id) || null;
      // 送るもの: 書き込みが変わった / 読んでいたページだけ変わった（Driveにファイルがあるときだけ送る）
      var need = before.dirty || overwriteId || (before.pos && target);
      if (!need || (!target && !App.hasStrokes())) {
        if (remote && remote.md5Checksum && before.md5 !== remote.md5Checksum) { before.md5 = remote.md5Checksum; writeMeta(c.id, before); }
        show('ok', 'Drive保存済み'); return;
      }

      show('busy', 'Drive保存中…');
      var res;
      if (target) {
        try { res = await DriveX.updateAnn(target, body(), token); }
        catch (e) { if (e.status !== 404) throw e; target = null; }
      }
      if (!target) res = await DriveX.createAnn(c.id, jsonName(c.name), body(), token);
      // 送っている間にまた書いたら、もう一度送る
      var after = readMeta(c.id);
      var changed = after.dirtyAt !== before.dirtyAt;
      writeMeta(c.id, { fileId: res.id, md5: res.md5Checksum, dirty: changed, dirtyAt: after.dirtyAt || 0 });
      if (c !== cur) return;
      if (changed) { show('pending', 'Drive保存待ち'); schedule(DELAY); }
      else show('ok', 'Drive保存済み');
    } catch (e) {
      console.error(e);
      if (e.status === 401) { GAuth.invalidate(); show('login', 'Drive未保存・ログイン'); }
      else if (c === cur) show('error', 'Drive保存失敗・再試行');
    } finally {
      busy = false;
      if (again) { again = false; schedule(1500); }
    }
  }

  // この端末に保存されたとき（＝書き込みが変わったとき）
  App.hooks.saved = function (key) {
    if (S.kind === 'scrap') { // スクラップブックの中に書いた
      // ページ数は、並べ替え・削除を反映した今の数にしておく（本棚の表示用）
      Store.patchBook(key, { dirty: true, editedAt: Date.now(), pages: S.total }).then(function () { scrapChanged(key, DELAY); }, function () {});
      return;
    }
    if (!cur || key !== cur.id) return;
    var m = readMeta(cur.id);
    m.dirty = true; m.dirtyAt = Date.now();
    writeMeta(cur.id, m);
    if (state !== 'login') show('pending', 'Drive保存待ち');
    if (!busy) schedule(DELAY); else again = true;
  };
  // 本を開いたとき
  App.hooks.opened = function (key, name) {
    clearTimeout(timer); timer = null;
    if (S.kind === 'scrap') { cur = null; state = ''; showScrap(); return; }
    cur = { id: key, name: name };
    sync();
  };
  App.on('close', function () { clearTimeout(timer); timer = null; cur = null; state = ''; btn.hidden = true; });
  // 読んでいたページが変わった（これだけでは送らない。アプリを離れるときに、まとめて送る）
  App.on('page', function () {
    if (!cur) return;
    var m = readMeta(cur.id);
    if (!m.pos) { m.pos = true; writeMeta(cur.id, m); }
  });

  /* ---------- スクラップブック ---------- */
  var sTimer = null, sBusy = false, sAgain = false;
  function showScrap(text, s) {
    if (S.kind !== 'scrap' || !S.hasFile) return;
    show(s || (GAuth.hasToken() ? 'ok' : 'login'), text || (GAuth.hasToken() ? 'Drive保存済み' : 'Driveにログイン'));
  }
  function scrapChanged(id, ms) {
    if (S.hasFile && S.key === id && GAuth.hasToken()) showScrap('Drive保存待ち', 'pending');
    clearTimeout(sTimer);
    sTimer = setTimeout(function () { sTimer = null; pushScraps(); }, ms == null ? 4000 : ms);
  }
  function pageName(it, i) {
    var f = it.from || {};
    var base = (f.name ? String(f.name).replace(/[\\/:*?"<>|]/g, ' ').slice(0, 40) + ' p' + f.page : 'page');
    return ('00' + (i + 1)).slice(-3) + ' ' + base + '.jpg';
  }
  async function pushScrap(id, token) {
    var rec = await Store.getBook(id);
    if (!rec || rec.kind !== 'scrap') return;
    var open = S.hasFile && S.key === id;
    if (open) App.flushSave();
    var ann = open ? App.exportData() : await Store.getAnn(id);
    var v = Scrap.view(rec, ann), editedAt = rec.editedAt || 0;
    // フォルダ（なければ作る。名前が変わっていたら直す）
    var dr = rec.drive || {}, folder = dr.folder;
    if (!folder) {
      var f = await DriveX.scrapFolder(id, rec.name, token);
      folder = f.id;
      if (f.name !== rec.name) await DriveX.rename(folder, rec.name, token);
    } else if (dr.name !== rec.name) await DriveX.rename(folder, rec.name, token);
    // まだ送っていないページの絵
    var files = {};
    for (var i = 0; i < v.items.length; i++) {
      var it = v.items[i];
      if (it.file) continue;
      var pr = await Store.getPage(it.id);
      if (!pr || !pr.data) continue;
      var up = await DriveX.uploadPage(folder, pageName(it, i), it.id, pr.data, token);
      files[it.id] = up.id;
      await Store.patchBook(id, function (r) { // 送るたびに覚える（途中で止まっても、続きから送れるように）
        return { items: (r.items || []).map(function (x) { return x.id === it.id ? Object.assign({}, x, { file: up.id }) : x; }) };
      });
    }
    // 削除したページの絵は、Driveのゴミ箱へ
    var trash = (rec.trash || []).concat(v.removed.map(function (x) { return x.file; }).filter(Boolean));
    for (var k = 0; k < trash.length; k++) await DriveX.trash(trash[k], token);
    // 並び・出典・書き込み
    var man = JSON.stringify({
      version: 1, id: id, name: rec.name, editedAt: editedAt, savedAt: Date.now(),
      items: v.items.map(function (x) { return files[x.id] ? Object.assign({}, x, { file: files[x.id] }) : x; }),
      ann: { pages: v.ann.pages || {}, notes: v.ann.notes || {} }
    });
    var res = null, mid = dr.manifest;
    if (!mid) { var found = await DriveX.findManifest(id, token); mid = found && found.id; }
    if (mid) {
      try { res = await DriveX.updateFile(mid, 'application/json; charset=UTF-8', man, token); }
      catch (e) { if (e.status !== 404) throw e; }
    }
    if (!res) res = await DriveX.createManifest(folder, id, man, token);
    await Store.patchBook(id, function (r) {
      var left = (r.trash || []).filter(function (x) { return trash.indexOf(x) < 0; });
      return { drive: { folder: folder, manifest: res.id, md5: res.md5Checksum, name: rec.name },
        dirty: (r.editedAt || 0) !== editedAt ? true : undefined, trash: left.length ? left : undefined };
    });
  }
  async function pushScraps() {
    if (sBusy) { sAgain = true; return; }
    sBusy = true;
    try {
      var token = await GAuth.ensure();
      if (!token) { showScrap(); return; }
      // 削除したスクラップブックは、Driveのフォルダごとゴミ箱へ
      var gone = (await Store.getKV('scrap:gone')) || [];
      while (gone.length) {
        var g = gone[0];
        var dir = g.folder || ((await DriveX.findScrapFolder(g.id, token)) || {}).id;
        if (dir) await DriveX.trash(dir, token);
        gone.shift();
        await Store.putKV('scrap:gone', gone);
      }
      var all = (await Store.books()).filter(function (b) { return b.kind === 'scrap' && b.dirty; });
      for (var k = 0; k < all.length; k++) {
        if (S.hasFile && S.key === all[k].id) showScrap('Drive保存中…', 'busy');
        await pushScrap(all[k].id, token);
      }
      showScrap();
    } catch (e) {
      console.error(e);
      if (e.status === 401) GAuth.invalidate();
      showScrap(e.status === 401 ? 'Drive未保存・ログイン' : 'Drive保存失敗・再試行', e.status === 401 ? 'login' : 'error');
    } finally {
      sBusy = false;
      if (sAgain) { sAgain = false; scrapChanged('', 3000); }
    }
  }
  /* Driveにあるスクラップブックを、この端末の本棚に取りこむ（本棚の「Driveの本を更新」から呼ばれる）
     - この端末にないもの → 取りこむ（ページの絵は、開くときに取る）
     - Drive側だけが変わったもの → Driveの内容にする
     - この端末でも変えていたもの → この端末の内容を残し、Drive側にだけあるページは最後に足す */
  async function pullScraps(token) {
    var remote = await DriveX.listScraps(token);
    var gone = ((await Store.getKV('scrap:gone')) || []).map(function (g) { return g.id; });
    var local = {}; (await Store.books()).forEach(function (b) { if (b.kind === 'scrap') local[b.id] = b; });
    var seen = {};
    for (var i = 0; i < remote.length; i++) {
      var r = remote[i], id = r.scrap, rec = local[id];
      seen[id] = true;
      if (gone.indexOf(id) >= 0 || !r.manifest) continue;
      if (rec && rec.drive && rec.drive.md5 === r.manifest.md5Checksum) continue; // 変わっていない
      if (S.hasFile && S.key === id) continue;                                    // 開いている最中は、さわらない
      var m = await DriveX.getJson(r.manifest.id, token);
      if (!m || !Array.isArray(m.items)) continue;
      var items = m.items.filter(function (x) { return x && typeof x.id === 'string' && x.w > 0 && x.h > 0; });
      var mann = m.ann && typeof m.ann === 'object' ? m.ann : {};
      var drive = { folder: r.folder, manifest: r.manifest.id, md5: r.manifest.md5Checksum, name: m.name || r.name };
      if (!rec) {
        await Store.putAnn(id, { version: 1, pages: mann.pages || {}, notes: mann.notes || {} });
        await Store.putBook({ id: id, kind: 'scrap', name: m.name || r.name, items: items, pages: items.length,
          addedAt: Date.now(), editedAt: +m.editedAt || 0, drive: drive });
      } else if (!rec.dirty) {
        rec = await Scrap.normalize(id);
        var keep = {}; items.forEach(function (x) { keep[x.id] = true; });
        for (var k = 0; k < rec.items.length; k++) if (!keep[rec.items[k].id]) await Store.delPage(rec.items[k].id);
        await Store.putAnn(id, { version: 1, pages: mann.pages || {}, notes: mann.notes || {} });
        await Store.patchBook(id, { name: m.name || rec.name, items: items, pages: items.length, editedAt: +m.editedAt || rec.editedAt, drive: drive });
      } else {
        rec = await Scrap.normalize(id);
        var have = {}; rec.items.forEach(function (x) { have[x.id] = true; });
        var ann = (await Store.getAnn(id)) || { version: 1, pages: {} }, n = rec.items.length, extra = [];
        if (!ann.pages) ann.pages = {};
        items.forEach(function (x, j) {
          if (have[x.id]) return;
          extra.push(x); n++;
          if (mann.pages && mann.pages[j + 1]) ann.pages[n] = mann.pages[j + 1];
          if (mann.notes && mann.notes[j + 1]) { ann.notes = ann.notes || {}; ann.notes[n] = mann.notes[j + 1]; }
        });
        if (extra.length) await Store.putAnn(id, ann);
        await Store.patchBook(id, function (x) { return { items: (x.items || []).concat(extra), pages: n, drive: drive, dirty: true }; });
      }
    }
    // Driveから消えていたスクラップブックは、この端末の内容を残して、次に送り直す
    for (var id2 in local) {
      var b = local[id2];
      if (seen[id2] || !b.drive) continue;
      await Store.patchBook(id2, function (x) {
        return { drive: undefined, dirty: true, items: (x.items || []).map(function (y) { var z = Object.assign({}, y); delete z.file; return z; }) };
      });
    }
    pushScraps();
  }
  // ほかの端末で入れたページの絵を、Driveから取る。全部取れたら true
  async function fetchPages(rec, miss) {
    var token = await GAuth.ensure();
    if (!token) return false;
    try {
      for (var i = 0; i < miss.length; i++) {
        var it = miss[i];
        if (!it.file) return false;
        var buf = await DriveX.getBytes(it.file, token);
        await Store.putPage({ id: it.id, scrap: rec.id, data: buf, w: it.w, h: it.h, at: it.at || Date.now() });
      }
      return true;
    } catch (e) {
      console.error(e);
      if (e.status === 401) GAuth.invalidate();
      return false;
    }
  }

  /* ---------- きっかけ ---------- */
  // アプリを閉じる・ほかのアプリに切りかえるときは、待たずに送る
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) return;
    if (cur) { var m = readMeta(cur.id); if (m.dirty || m.pos) sync(); }
    if (sTimer) { clearTimeout(sTimer); sTimer = null; pushScraps(); }
  });
  // 通信が戻ったら、送れていない分を送る
  window.addEventListener('online', function () {
    if (cur && readMeta(cur.id).dirty) schedule(1000);
    scrapChanged('', 2000);
  });
  // ボタン: ログインが必要ならログインしてから、それ以外はすぐ同期
  btn.addEventListener('click', function () {
    if (!S.hasFile) return;
    if (!GAuth.hasToken() || state === 'login') {
      try { sessionStorage.setItem('dk:reopen', S.key); } catch (e) {}
      GAuth.getToken('sync').then(function () {
        try { sessionStorage.removeItem('dk:reopen'); } catch (e) {}
        if (cur) sync(); else pushScraps();
      }, function (e) {
        try { sessionStorage.removeItem('dk:reopen'); } catch (er) {}
        App.setStatus(Library.message(e && e.message));
      });
      return;
    }
    if (cur) sync(); else pushScraps();
  });

  window.Sync = { sync: sync, scrapChanged: scrapChanged, pushScraps: pushScraps, pullScraps: pullScraps, fetchPages: fetchPages };
})();
