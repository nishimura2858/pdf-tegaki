/* Google Picker（Drive上のPDFを選ぶ画面）
   drive.file スコープでは、ここで選んだファイルだけにアプリがアクセスできるようになる */
(function () {
  'use strict';
  var C = window.APP_CONFIG;
  var loading = null;

  function loadPicker() {
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      if (!window.gapi) { reject(new Error('gapi_not_loaded')); return; }
      gapi.load('picker', { callback: resolve, onerror: function () { reject(new Error('picker_load_failed')); } });
    });
    loading.catch(function () { loading = null; });
    return loading;
  }

  function pickPdf(token) {
    return loadPicker().then(function () {
      return new Promise(function (resolve) {
        var P = google.picker;
        var view = new P.DocsView(P.ViewId.DOCS)
          .setMimeTypes('application/pdf')
          .setIncludeFolders(true)
          .setMode(P.DocsViewMode.LIST);
        var picker = new P.PickerBuilder()
          .addView(view)
          .setOAuthToken(token)
          .setDeveloperKey(C.API_KEY)
          .setAppId(C.APP_ID)
          .setLocale('ja')
          .setTitle('開くPDFを選んでください')
          .setSize(Math.min(1051, window.innerWidth - 20), Math.min(650, window.innerHeight - 20))
          .setCallback(function (d) {
            var a = d[P.Response.ACTION];
            if (a === P.Action.PICKED) {
              var doc = d[P.Response.DOCUMENTS][0];
              resolve({ id: doc[P.Document.ID], name: doc[P.Document.NAME] });
            } else if (a === P.Action.CANCEL) {
              resolve(null);
            }
          })
          .build();
        picker.setVisible(true);
      });
    });
  }

  window.GPicker = { pickPdf: pickPdf, preload: loadPicker };
})();
