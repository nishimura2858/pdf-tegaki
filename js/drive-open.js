/* 「Driveから開く」ボタン: ログイン → Pickerで選ぶ → ダウンロード → 表示 */
(function () {
  'use strict';
  var App = window.App;

  var MESSAGES = {
    popup_failed_to_open: 'ログイン画面を開けませんでした（ポップアップがブロックされている可能性があります）',
    popup_closed: 'ログインが中断されました',
    access_denied: 'Googleへのアクセスが許可されませんでした',
    scope_denied: 'Driveへのアクセスが許可されていません。ログイン時にチェックを入れてください',
    state_mismatch: 'ログインの確認に失敗しました。もう一度お試しください',
    admin_policy_enforced: 'このアカウントでは管理者が外部アプリの利用を制限しています',
    org_internal: 'このアカウントでは利用できません（組織の制限）',
    gis_not_loaded: 'Googleのログイン部品を読み込めませんでした。通信状況を確認してください',
    gapi_not_loaded: 'Googleの部品を読み込めませんでした。通信状況を確認してください',
    picker_load_failed: 'ファイル選択画面を読み込めませんでした',
    http_403: 'このファイルを開く権限がありません',
    http_404: 'ファイルが見つかりませんでした'
  };
  function message(e) {
    var code = e && e.message;
    return MESSAGES[code] || ('Driveから開けませんでした（' + (code || '不明なエラー') + '）');
  }

  function download(id, token) {
    return Drive.downloadFile(id, token).catch(function (e) {
      if (e.status !== 401) throw e;
      // トークン切れ: 取り直して1回だけやり直す
      GAuth.invalidate();
      return GAuth.getToken('pick').then(function (t) { return Drive.downloadFile(id, t); });
    });
  }

  // DriveのPDFをダウンロードして開く。最後に開いたファイルを覚えておく（ログインで画面を離れたあと開き直すため）
  async function openFile(f, token) {
    App.setStatus('「' + f.name + '」をダウンロード中…');
    var buf = await download(f.id, token);
    var doc = await pdfjsLib.getDocument({ data: buf }).promise;
    try { localStorage.setItem('drive:last', JSON.stringify({ id: f.id, name: f.name })); } catch (e) {}
    App.openDoc(doc, f.name, 'strokes:drive:' + f.id);
  }

  async function openFromDrive() {
    try {
      // ポップアップ方式では、タップ直後に同期的にログイン画面を開く必要があるので、最初に呼ぶ
      var token = await GAuth.getToken('pick');
      App.setStatus('Driveのファイルを表示しています…');
      var f = await GPicker.pickPdf(token);
      if (!f) { App.setStatus('キャンセルしました'); return; }
      await openFile(f, token);
    } catch (e) {
      console.error(e);
      App.setStatus(message(e));
    }
  }

  // 最後に開いたDriveのPDFを開き直す（同期のためにログインし直して戻ってきたとき）
  async function reopenLast() {
    var last = null;
    try { last = JSON.parse(localStorage.getItem('drive:last')); } catch (e) {}
    if (!last || !last.id) { App.setStatus('ログインしました'); return; }
    try { await openFile(last, await GAuth.getToken('sync')); }
    catch (e) { console.error(e); App.setStatus(message(e)); }
  }

  document.getElementById('driveBtn').addEventListener('click', openFromDrive);

  // リダイレクト方式のログインから戻ってきたとき
  var r = GAuth.consumeRedirect();
  if (r) {
    var after = GAuth.takeAfter();
    if (r.error) App.setStatus(message(new Error(r.error)));
    else if (after === 'pick') openFromDrive();
    else if (after === 'sync') reopenLast();
    else App.setStatus('ログインしました');
  }
})();
