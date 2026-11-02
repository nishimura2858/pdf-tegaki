/* Google Drive API の呼び出し */
(function () {
  'use strict';
  var API = 'https://www.googleapis.com/drive/v3/files/';

  function httpError(r) { var e = new Error('http_' + r.status); e.status = r.status; return e; }

  /* ファイルの中身をダウンロードする（PDF用） */
  function downloadFile(id, token) {
    return fetch(API + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true', {
      headers: { Authorization: 'Bearer ' + token }
    }).then(function (r) {
      if (!r.ok) throw httpError(r);
      return r.arrayBuffer();
    });
  }

  window.Drive = { downloadFile: downloadFile };
})();
