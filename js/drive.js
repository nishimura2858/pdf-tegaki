/* Google Drive API の呼び出し
   権限は「Drive全体」（元のPDFに書き込みを反映するため）。ただし実際に触るのは、
   このアプリで開いたPDFと、このアプリが作ったファイル（PDF手書きデータ フォルダの中）だけ
   - 「PDF手書きデータ」はマイドライブ直下に作る。OneDriveと同期しているフォルダ（00 OneDriveと同期）の外なので、
     手書きデータ（.strokes.json）や書き込み前の控えが県のOneDriveへ同期されることはない */
(function () {
  'use strict';
  var API = 'https://www.googleapis.com/drive/v3/files';
  var UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  var FOLDER_NAME = 'PDF手書きデータ';
  var FOLDER_MIME = 'application/vnd.google-apps.folder';

  function httpError(r) { var e = new Error('http_' + r.status); e.status = r.status; return e; }
  function auth(token, extra) {
    var h = { Authorization: 'Bearer ' + token };
    for (var k in extra) h[k] = extra[k];
    return h;
  }
  function call(url, token, opt) {
    opt = opt || {};
    return fetch(url, { method: opt.method || 'GET', headers: auth(token, opt.headers), body: opt.body })
      .then(function (r) {
        if (!r.ok) throw httpError(r);
        return opt.raw ? r : r.json();
      });
  }
  function q(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
  function list(query, fields, token) {
    var p = new URLSearchParams({
      q: query, fields: 'files(' + fields + ')', spaces: 'drive', pageSize: '10',
      orderBy: 'modifiedTime desc', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true'
    });
    return call(API + '?' + p.toString(), token).then(function (d) { return d.files || []; });
  }

  /* ファイルの中身をダウンロードする（PDF用） */
  function downloadFile(id, token) {
    return call(API + '/' + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true', token, { raw: true })
      .then(function (r) { return r.arrayBuffer(); });
  }

  /* 手書きデータ用のフォルダ「PDF手書きデータ」を探し、なければ作る（マイドライブ直下） */
  function ensureFolder(token) {
    var query = "mimeType='" + FOLDER_MIME + "' and appProperties has { key='pdfTegaki' and value='folder' } and trashed=false";
    return list(query, 'id', token).then(function (files) {
      if (files.length) return files[0].id;
      return call(API + '?fields=id', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME, appProperties: { pdfTegaki: 'folder' } })
      }).then(function (f) { return f.id; });
    });
  }

  /* PDFの中身の識別子（SHA-256）に対応する手書きデータ（○○.strokes.json）を探す。なければ null */
  function findStrokes(pdfHash, token) {
    var query = "appProperties has { key='pdfHash' and value='" + q(pdfHash) + "' } and trashed=false";
    return list(query, 'id,version,md5Checksum,modifiedTime', token).then(function (files) { return files[0] || null; });
  }

  /* 名前で手書きデータを探す（前の版の手書きを引き継ぐとき用。新しいものから） */
  function findStrokesByName(name, token) {
    var query = "name='" + q(name) + "' and mimeType='application/json' and trashed=false";
    return list(query, 'id,modifiedTime,appProperties', token);
  }

  function getJson(id, token) {
    return call(API + '/' + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true', token);
  }

  /* 手書きデータを新しく作る */
  function createStrokes(folderId, name, pdfHash, body, token) {
    var b = 'pdftegaki' + Math.random().toString(16).slice(2);
    var meta = { name: name, mimeType: 'application/json', parents: [folderId], appProperties: { pdfHash: pdfHash } };
    var payload =
      '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n' +
      '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + body + '\r\n' +
      '--' + b + '--';
    return call(UPLOAD + '?uploadType=multipart&fields=id,version,md5Checksum&supportsAllDrives=true', token, {
      method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: payload
    });
  }

  /* 既存の手書きデータを上書きする */
  function updateStrokes(id, body, token) {
    return call(UPLOAD + '/' + encodeURIComponent(id) + '?uploadType=media&fields=id,version,md5Checksum&supportsAllDrives=true', token, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: body
    });
  }

  /* ---------- 元のPDFへの書き込み反映で使うもの ---------- */

  /* 同期フォルダ（APP_CONFIG.SYNC_FOLDER「00 OneDriveと同期」）の中（サブフォルダを含む）にあるか
     親のフォルダを上へたどって調べる。調べたフォルダの結果は覚えておく（同じフォルダを何度も聞かない） */
  var syncOf = {}; // フォルダID → true（同期フォルダの中）/ false（外）
  async function inSyncFolder(file, token) {
    var sync = window.APP_CONFIG && APP_CONFIG.SYNC_FOLDER;
    if (!sync || !file) return false;
    syncOf[sync] = true;
    var id = file.parents && file.parents[0], path = [];
    for (var depth = 0; id && depth < 30; depth++) {
      if (id in syncOf) break;
      path.push(id);
      var f = await call(API + '/' + encodeURIComponent(id) + '?fields=id,parents&supportsAllDrives=true', token);
      id = f.parents && f.parents[0];
    }
    var ans = !!(id && syncOf[id]);
    path.forEach(function (p) { syncOf[p] = ans; });
    return ans;
  }

  /* 名前と中身（MD5）が一致するPDFを探す。md5s のどれかに一致したものを返す。なければ null
     同期フォルダの中にあるものを優先し（新しいものから）、なければほかの場所のもの。返すファイルに inSync を付ける */
  async function findPdf(name, md5s, token) {
    var query = "name='" + q(name) + "' and mimeType='application/pdf' and trashed=false";
    var files = (await list(query, 'id,name,md5Checksum,parents,modifiedTime,capabilities(canEdit)', token))
      .filter(function (f) { return md5s.indexOf(f.md5Checksum) >= 0; });
    for (var i = 0; i < files.length; i++) {
      if (await inSyncFolder(files[i], token)) { files[i].inSync = true; return files[i]; }
    }
    if (files[0]) files[0].inSync = false;
    return files[0] || null;
  }
  function getMeta(id, token) {
    return call(API + '/' + encodeURIComponent(id) + '?fields=id,name,md5Checksum,trashed,parents,appProperties,capabilities(canEdit)&supportsAllDrives=true', token);
  }
  // 書き込む前の元のPDFの控え（PDF手書きデータ フォルダ内）を探す
  function findOriginal(base, token) {
    var query = "appProperties has { key='tegakiOrig' and value='" + q(base) + "' } and trashed=false";
    return list(query, 'id,appProperties', token).then(function (files) { return files[0] || null; });
  }
  function createOriginal(folderId, name, base, bytes, lastMd5, token) {
    var b = 'pdftegaki' + Math.random().toString(16).slice(2);
    var meta = { name: name, mimeType: 'application/pdf', parents: [folderId],
      appProperties: { tegakiOrig: base, lastMd5: lastMd5 } };
    var body = new Blob([
      '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n' +
      '--' + b + '\r\nContent-Type: application/pdf\r\n\r\n', bytes, '\r\n--' + b + '--']);
    return call(UPLOAD + '?uploadType=multipart&fields=id,appProperties&supportsAllDrives=true', token, {
      method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: body
    });
  }
  function setAppProps(id, props, token) {
    return call(API + '/' + encodeURIComponent(id) + '?fields=id&supportsAllDrives=true', token, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ appProperties: props })
    });
  }
  /* PDFの中身を上書きする
     - 5MBまでは1回で送る。5MBを超えるものは、小分けにして送る（再開可能アップロード）。
       途中で通信が切れても、続きから送り直せる（教科書のような大きなPDF用）
     - どちらの送り方でも、Driveの中身は最後まで届いた時点で一度に切り替わる。
       書きかけのファイルが見えることはない（rcloneでOneDriveへ同期されても安全） */
  var SIMPLE_MAX = 5 * 1024 * 1024;
  var CHUNK = 8 * 1024 * 1024; // 256KBの倍数にすること（Driveの決まり）
  function uploadPdf(id, bytes, token) {
    var size = bytes.byteLength != null ? bytes.byteLength : bytes.length;
    if (size <= SIMPLE_MAX) return uploadSimple(id, bytes, token);
    return uploadResumable(id, bytes, size, token).catch(function (e) {
      // 小分けの送り方が使えなかった（送り先を受け取れないなど）→ 1回で送る
      if (e && e.message === 'no_session') return uploadSimple(id, bytes, token);
      throw e;
    });
  }
  function uploadSimple(id, bytes, token) {
    return call(UPLOAD + '/' + encodeURIComponent(id) + '?uploadType=media&fields=id,md5Checksum&supportsAllDrives=true', token, {
      method: 'PATCH', headers: { 'Content-Type': 'application/pdf' }, body: new Blob([bytes], { type: 'application/pdf' })
    });
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // Driveが受け取った所までのバイト数（「Range: bytes=0-N」→ N+1）。わからなければ null
  function received(r) {
    var m = /bytes=0-(\d+)/.exec(r.headers.get('Range') || '');
    return m ? +m[1] + 1 : null;
  }
  async function uploadResumable(id, bytes, size, token) {
    // 1. 送り先（この上書き専用のURL）を用意してもらう
    var r0 = await fetch(UPLOAD + '/' + encodeURIComponent(id) + '?uploadType=resumable&fields=id,md5Checksum&supportsAllDrives=true', {
      method: 'PATCH',
      headers: auth(token, { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/pdf', 'X-Upload-Content-Length': String(size) }),
      body: '{}'
    });
    if (!r0.ok) throw httpError(r0);
    var url = r0.headers.get('Location');
    if (!url) throw new Error('no_session');
    var blob = new Blob([bytes], { type: 'application/pdf' });
    // 2. 小分けにして送る。通信が切れたら、Driveが受け取った所を聞いて、続きから送る
    var pos = 0, fails = 0;
    while (true) {
      var end = Math.min(pos + CHUNK, size), r;
      try {
        r = await fetch(url, { method: 'PUT', headers: { 'Content-Range': 'bytes ' + pos + '-' + (end - 1) + '/' + size }, body: blob.slice(pos, end) });
      } catch (e) {
        r = null; // 通信が切れた
      }
      if (r && (r.status === 200 || r.status === 201)) return r.json(); // 全部届いた（ここで中身が切り替わる）
      if (r && r.status === 308) { var got = received(r); pos = got != null ? got : end; fails = 0; continue; }
      if (r && r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) throw httpError(r); // 送り先の期限切れなど
      // 通信エラー・サーバーの一時的な不調 → 少し待って、受け取った所を聞いてから続きを送る
      if (++fails > 4) throw r ? httpError(r) : new Error('upload_network');
      await wait(1000 * Math.pow(2, fails));
      try {
        var s = await fetch(url, { method: 'PUT', headers: { 'Content-Range': 'bytes */' + size } });
        if (s.status === 200 || s.status === 201) return s.json();
        if (s.status === 308) { var g = received(s); if (g != null) pos = g; }
        else if (s.status >= 400 && s.status < 500) throw httpError(s);
      } catch (e) { if (e && e.status) throw e; }
    }
  }

  /* 自分のドライブに since（ISO形式の時刻）より後に新しく置かれたPDF（新しいものから）
     ファイルアプリ経由で保存したPDFを、アプリを開いたときに「開きますか？」と聞くため */
  function listNewPdfs(since, token) {
    var query = "mimeType='application/pdf' and createdTime > '" + q(since) + "' and 'me' in owners and trashed=false";
    var p = new URLSearchParams({
      q: query, fields: 'files(id,name,createdTime,appProperties)', spaces: 'drive', pageSize: '10', orderBy: 'createdTime desc'
    });
    return call(API + '?' + p.toString(), token).then(function (d) { return d.files || []; });
  }

  window.Drive = {
    listNewPdfs: listNewPdfs,
    downloadFile: downloadFile, ensureFolder: ensureFolder, findStrokes: findStrokes, findStrokesByName: findStrokesByName,
    getJson: getJson, createStrokes: createStrokes, updateStrokes: updateStrokes,
    findPdf: findPdf, getMeta: getMeta, findOriginal: findOriginal, createOriginal: createOriginal,
    setAppProps: setAppProps, uploadPdf: uploadPdf, inSyncFolder: inSyncFolder
  };
})();
