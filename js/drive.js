/* Google Drive API の呼び出し
   権限は「Drive全体」（元のPDFに書き込みを反映するため）。ただし実際に触るのは、
   このアプリで開いたPDFと、このアプリが作ったファイル（PDF手書きデータ フォルダの中）だけ */
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

  // 名前と中身（MD5）が一致するPDFを探す。md5s のどれかに一致したものを返す。なければ null
  function findPdf(name, md5s, token) {
    var query = "name='" + q(name) + "' and mimeType='application/pdf' and trashed=false";
    return list(query, 'id,name,md5Checksum,capabilities(canEdit)', token).then(function (files) {
      for (var i = 0; i < files.length; i++) if (md5s.indexOf(files[i].md5Checksum) >= 0) return files[i];
      return null;
    });
  }
  function getMeta(id, token) {
    return call(API + '/' + encodeURIComponent(id) + '?fields=id,name,md5Checksum,trashed,appProperties&supportsAllDrives=true', token);
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
  // PDFの中身を上書きする
  function uploadPdf(id, bytes, token) {
    return call(UPLOAD + '/' + encodeURIComponent(id) + '?uploadType=media&fields=id,md5Checksum&supportsAllDrives=true', token, {
      method: 'PATCH', headers: { 'Content-Type': 'application/pdf' }, body: new Blob([bytes], { type: 'application/pdf' })
    });
  }

  window.Drive = {
    downloadFile: downloadFile, ensureFolder: ensureFolder, findStrokes: findStrokes, findStrokesByName: findStrokesByName,
    getJson: getJson, createStrokes: createStrokes, updateStrokes: updateStrokes,
    findPdf: findPdf, getMeta: getMeta, findOriginal: findOriginal, createOriginal: createOriginal,
    setAppProps: setAppProps, uploadPdf: uploadPdf
  };
})();
