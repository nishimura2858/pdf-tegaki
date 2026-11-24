/* Google Drive とのやり取り（読書ノート用）
   Driveの中の置き場所（アプリが最初に作る。名前や場所は変えてもよい。目印は appProperties で付けている）:
     読書ノート/                         ← ここに本のPDFを入れる（フォルダ分けしてもよい。ショートカットも読む）
       _アプリのデータ/
         書き込み/        ○○.json       … 本ごとの、ペン・マーカー・付箋
         スクラップブック/ ○○/            … スクラップブックごとのフォルダ（scrap.json と、ページの絵 .jpg）
   ログイン（GAuth）と設定（APP_CONFIG）は、手書きノートと同じものを使う */
(function () {
  'use strict';
  var API = 'https://www.googleapis.com/drive/v3/files';
  var UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  var FOLDER = 'application/vnd.google-apps.folder', SHORTCUT = 'application/vnd.google-apps.shortcut', PDF = 'application/pdf';
  var NAMES = { root: '読書ノート', data: '_アプリのデータ', ann: '書き込み', scraps: 'スクラップブック' };

  function httpError(r) { var e = new Error('http_' + r.status); e.status = r.status; return e; }
  function call(url, token, opt) {
    opt = opt || {};
    var h = { Authorization: 'Bearer ' + token };
    for (var k in opt.headers) h[k] = opt.headers[k];
    return fetch(url, { method: opt.method || 'GET', headers: h, body: opt.body, signal: opt.signal })
      .then(function (r) {
        if (!r.ok) throw httpError(r);
        return opt.raw ? r : r.status === 204 ? {} : r.json();
      });
  }
  function q(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
  // 条件に合うファイルを全部（100件ずつ続きを取る）
  async function listAll(query, fields, token, order) {
    var out = [], page = '';
    for (var i = 0; i < 50; i++) {
      var p = new URLSearchParams({
        q: query, fields: 'nextPageToken,files(' + fields + ')', spaces: 'drive', pageSize: '200',
        supportsAllDrives: 'true', includeItemsFromAllDrives: 'true'
      });
      if (order) p.set('orderBy', order);
      if (page) p.set('pageToken', page);
      var d = await call(API + '?' + p.toString(), token);
      out = out.concat(d.files || []);
      page = d.nextPageToken || '';
      if (!page) break;
    }
    return out;
  }
  function byProp(key, value) { return "appProperties has { key='" + q(key) + "' and value='" + q(value) + "' } and trashed=false"; }
  function meta(id, token, fields) {
    return call(API + '/' + encodeURIComponent(id) + '?fields=' + (fields || 'id,name,size,md5Checksum,modifiedTime,trashed,mimeType') + '&supportsAllDrives=true', token);
  }
  function createFolder(name, parent, props, token) {
    var body = { name: name, mimeType: FOLDER, appProperties: props };
    if (parent) body.parents = [parent];
    return call(API + '?fields=id&supportsAllDrives=true', token, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body)
    }).then(function (f) { return f.id; });
  }

  /* ---------- 置き場所（なければ作る） ---------- */
  var foldersP = null;
  async function findOrMake(kind, parent, token) {
    var found = await listAll("mimeType='" + FOLDER + "' and " + byProp('dokusho', kind), 'id', token, 'createdTime');
    return found.length ? found[0].id : createFolder(NAMES[kind], parent, { dokusho: kind }, token);
  }
  function folders(token) {
    if (!foldersP) foldersP = (async function () {
      var root = await findOrMake('root', null, token);
      var data = await findOrMake('data', root, token);
      var ann = await findOrMake('ann', data, token), scraps = await findOrMake('scraps', data, token);
      return { root: root, data: data, ann: ann, scraps: scraps };
    })().catch(function (e) { foldersP = null; throw e; });
    return foldersP;
  }

  /* ---------- 本の一覧 ----------
     「読書ノート」フォルダの中のPDFを、下のフォルダまでたどって集める（アプリのデータのフォルダは除く）
     ショートカット（別の場所にあるPDFやフォルダへの近道）も読む */
  async function listBooks(token) {
    var f = await folders(token);
    var out = [], seen = {}, todo = [{ id: f.root, path: '' }], visited = {};
    visited[f.data] = true;
    var fields = 'id,name,mimeType,size,md5Checksum,modifiedTime,thumbnailLink,shortcutDetails(targetId,targetMimeType)';
    for (var n = 0; todo.length && n < 300; n++) {
      var cur = todo.shift();
      if (visited[cur.id]) continue;
      visited[cur.id] = true;
      var items = await listAll("'" + q(cur.id) + "' in parents and trashed=false", fields, token, 'name_natural');
      for (var i = 0; i < items.length; i++) {
        var it = items[i], type = it.mimeType, id = it.id, late = false;
        if (type === SHORTCUT && it.shortcutDetails) { id = it.shortcutDetails.targetId; type = it.shortcutDetails.targetMimeType; late = true; }
        if (type === FOLDER) { todo.push({ id: id, path: cur.path ? cur.path + ' / ' + it.name : it.name }); continue; }
        if (type !== PDF && !/\.pdf$/i.test(it.name || '')) continue;
        if (seen[id]) continue;
        seen[id] = true;
        var b = { driveId: id, name: it.name, size: +it.size || 0, md5: it.md5Checksum || '', modified: it.modifiedTime || '', folder: cur.path, thumbLink: it.thumbnailLink || '' };
        if (late) { // ショートカットの先の大きさなどは、あらためて聞く
          try { var m = await meta(id, token, 'id,size,md5Checksum,modifiedTime,trashed,thumbnailLink'); if (m.trashed) continue; b.size = +m.size || 0; b.md5 = m.md5Checksum || ''; b.modified = m.modifiedTime || ''; b.thumbLink = m.thumbnailLink || ''; }
          catch (e) { if (e.status === 404 || e.status === 403) continue; throw e; }
        }
        out.push(b);
      }
    }
    return out;
  }

  /* ---------- ダウンロード ----------
     届いた順に w（Source.writer）へ渡す。from > 0 なら、その位置（バイト）から続きを頼む。
     戻り値: { resumed: 続きから取れたか } */
  async function download(id, token, w, onProgress, from, signal) {
    var url = API + '/' + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true';
    var h = { Authorization: 'Bearer ' + token }, r;
    if (from > 0) {
      try { r = await fetch(url, { headers: { Authorization: h.Authorization, Range: 'bytes=' + from + '-' }, signal: signal }); }
      catch (e) { if (e && e.name === 'AbortError') throw e; r = null; }
      if (r && r.status !== 206) { try { if (r.body) r.body.cancel(); } catch (e) {} r = null; }
      if (!r) return { resumed: false };
    } else {
      r = await fetch(url, { headers: h, signal: signal });
      if (!r.ok) throw httpError(r);
    }
    if (r.body && r.body.getReader) {
      var rd = r.body.getReader();
      for (;;) {
        var x = await rd.read();
        if (x.done) break;
        await w.push(x.value);
        if (onProgress) onProgress(w.size());
      }
    } else {
      await w.push(new Uint8Array(await r.arrayBuffer()));
      if (onProgress) onProgress(w.size());
    }
    return { resumed: from > 0 };
  }
  function getBytes(id, token) {
    return call(API + '/' + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true', token, { raw: true })
      .then(function (r) { return r.arrayBuffer(); });
  }
  function getJson(id, token) { return call(API + '/' + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true', token); }

  /* ---------- 作る・書きかえる ---------- */
  var OUT = 'id,name,md5Checksum,modifiedTime';
  // 中身つきでファイルを作る。body: 文字列・ArrayBuffer・Blob
  function createFile(parent, name, mime, props, body, token) {
    var b = 'dokusho' + Math.random().toString(16).slice(2);
    var m = { name: name, mimeType: mime, parents: [parent], appProperties: props || {} };
    var payload = new Blob([
      '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(m) + '\r\n' +
      '--' + b + '\r\nContent-Type: ' + mime + '\r\n\r\n', body, '\r\n--' + b + '--']);
    return call(UPLOAD + '?uploadType=multipart&fields=' + OUT + '&supportsAllDrives=true', token, {
      method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: payload
    });
  }
  function updateFile(id, mime, body, token) {
    return call(UPLOAD + '/' + encodeURIComponent(id) + '?uploadType=media&fields=' + OUT + '&supportsAllDrives=true', token, {
      method: 'PATCH', headers: { 'Content-Type': mime }, body: body
    });
  }
  function patch(id, body, token) {
    return call(API + '/' + encodeURIComponent(id) + '?fields=id&supportsAllDrives=true', token, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body)
    });
  }
  function rename(id, name, token) { return patch(id, { name: name }, token); }
  // 消すときは、Driveのゴミ箱へ（30日は戻せる）
  function trash(id, token) { return patch(id, { trashed: true }, token).catch(function (e) { if (e.status !== 404) throw e; }); }

  /* ---------- 書き込み（本ごとの .json） ---------- */
  function findAnn(bookId, token) {
    return listAll(byProp('dkAnn', bookId), 'id,md5Checksum,modifiedTime', token, 'modifiedTime desc').then(function (l) { return l[0] || null; });
  }
  async function createAnn(bookId, name, body, token) {
    var f = await folders(token);
    return createFile(f.ann, name, 'application/json', { dkAnn: bookId }, body, token);
  }
  function updateAnn(id, body, token) { return updateFile(id, 'application/json; charset=UTF-8', body, token); }

  /* ---------- スクラップブック ---------- */
  // Driveにあるスクラップブックの一覧 [{ scrap, folder, name, manifest: { id, md5Checksum } | null }]
  async function listScraps(token) {
    var dirs = await listAll("mimeType='" + FOLDER + "' and " + byProp('dkKind', 'scrap'), 'id,name,appProperties', token);
    var mans = await listAll(byProp('dkKind', 'manifest'), 'id,md5Checksum,modifiedTime,appProperties,parents', token);
    return dirs.filter(function (d) { return d.appProperties && d.appProperties.dkScrap; }).map(function (d) {
      var m = mans.filter(function (x) { return x.appProperties && x.appProperties.dkScrap === d.appProperties.dkScrap; })[0] || null;
      return { scrap: d.appProperties.dkScrap, folder: d.id, name: d.name, manifest: m };
    });
  }
  function findScrapFolder(scrapId, token) {
    return listAll("mimeType='" + FOLDER + "' and " + byProp('dkScrap', scrapId), 'id,name', token).then(function (l) { return l[0] || null; });
  }
  async function scrapFolder(scrapId, name, token) {
    var found = await findScrapFolder(scrapId, token);
    if (found) return found;
    var f = await folders(token);
    var id = await createFolder(name, f.scraps, { dkKind: 'scrap', dkScrap: scrapId }, token);
    return { id: id, name: name };
  }
  function findManifest(scrapId, token) {
    return listAll("mimeType='application/json' and " + byProp('dkScrap', scrapId), 'id,md5Checksum,modifiedTime', token).then(function (l) { return l[0] || null; });
  }
  function createManifest(folder, scrapId, body, token) {
    return createFile(folder, 'scrap.json', 'application/json', { dkKind: 'manifest', dkScrap: scrapId }, body, token);
  }
  function uploadPage(folder, name, pageId, bytes, token) {
    return createFile(folder, name, 'image/jpeg', { dkPage: pageId }, bytes, token);
  }

  window.DriveX = {
    folders: folders, listBooks: listBooks, meta: meta, download: download, getBytes: getBytes, getJson: getJson,
    findAnn: findAnn, createAnn: createAnn, updateAnn: updateAnn,
    listScraps: listScraps, scrapFolder: scrapFolder, findScrapFolder: findScrapFolder, findManifest: findManifest, createManifest: createManifest,
    updateFile: updateFile, uploadPage: uploadPage, rename: rename, trash: trash,
    forget: function () { foldersP = null; }
  };
})();
