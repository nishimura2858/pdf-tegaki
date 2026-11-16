/* この端末の保存場所（IndexedDB「dokusho」）
   - books : 本棚の1冊ごとの記録 { id, kind: 'drive'|'local'|'scrap', name, … }
   - chunks: 本のPDFの中身。2MBずつに分けて置く（大きな本でも、読むところだけ取り出せるように）。キーは [本のid, 何番目]
   - ann   : 書き込み（ペン・マーカー・付箋）。キーは本のid
   - pages : スクラップブックの1ページ（写したページの絵）{ id, scrap, data(JPEG), … }
   - kv    : そのほかの小さな記録（Driveのフォルダの場所など）
   手書きノート（pdf-tegaki）とは別の保存場所なので、互いに影響しない */
(function () {
  'use strict';
  var NAME = 'dokusho', VER = 1, dbP = null;

  function open() {
    if (dbP) return dbP;
    dbP = new Promise(function (resolve, reject) {
      var r = indexedDB.open(NAME, VER);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks');
        if (!d.objectStoreNames.contains('ann')) d.createObjectStore('ann');
        if (!d.objectStoreNames.contains('pages')) d.createObjectStore('pages', { keyPath: 'id' }).createIndex('scrap', 'scrap');
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      r.onsuccess = function () {
        var d = r.result;
        d.onversionchange = function () { d.close(); dbP = null; };
        resolve(d);
      };
      r.onerror = function () { dbP = null; reject(r.error); };
    });
    return dbP;
  }
  // fn(tx) の中で頼んだ読み書きが全部終わったら、fn が返した request の結果（なければ fn の戻り値）を返す
  function tx(stores, mode, fn) {
    return open().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(stores, mode), out, req;
        try { req = fn(t); } catch (e) { reject(e); return; }
        if (req && 'onsuccess' in req) req.onsuccess = function () { out = req.result; };
        else out = req;
        t.oncomplete = function () { resolve(out); };
        t.onerror = t.onabort = function () { reject(t.error || new Error('idb')); };
      });
    });
  }
  function get(store, key) { return tx(store, 'readonly', function (t) { return t.objectStore(store).get(key); }); }
  function put(store, val, key) {
    return tx(store, 'readwrite', function (t) { key === undefined ? t.objectStore(store).put(val) : t.objectStore(store).put(val, key); });
  }
  function del(store, key) { return tx(store, 'readwrite', function (t) { t.objectStore(store).delete(key); }); }
  function all(store) { return tx(store, 'readonly', function (t) { return t.objectStore(store).getAll(); }); }

  /* ---------- 本 ---------- */
  function books() { return all('books').then(function (l) { return l || []; }); }
  function getBook(id) { return get('books', id); }
  function putBook(rec) { return put('books', rec); }
  // 1冊の記録の一部だけを書きかえる（読んで・直して・書くを1回の処理で。なければ何もしない）
  function patchBook(id, patch) {
    return tx('books', 'readwrite', function (t) {
      var st = t.objectStore('books'), g = st.get(id);
      g.onsuccess = function () {
        var rec = g.result; if (!rec) return;
        var p = typeof patch === 'function' ? patch(rec) : patch;
        if (p) Object.keys(p).forEach(function (k) { if (p[k] === undefined) delete rec[k]; else rec[k] = p[k]; });
        st.put(rec);
      };
    });
  }
  function chunkRange(id) { return IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]); }
  function putChunk(id, i, buf) { return put('chunks', buf, [id, i]); }
  function getChunk(id, i) { return get('chunks', [id, i]); }
  function delChunks(id) { return tx('chunks', 'readwrite', function (t) { t.objectStore('chunks').delete(chunkRange(id)); }); }
  function countChunks(id) { return tx('chunks', 'readonly', function (t) { return t.objectStore('chunks').count(chunkRange(id)); }); }
  // 本を本棚から外す（PDFの中身も消す。keepAnn: 書き込みは残す）
  function removeBook(id, keepAnn) {
    return tx(['books', 'chunks', 'ann'], 'readwrite', function (t) {
      t.objectStore('books').delete(id);
      t.objectStore('chunks').delete(chunkRange(id));
      if (!keepAnn) t.objectStore('ann').delete(id);
    });
  }

  /* ---------- 書き込み ---------- */
  function getAnn(id) { return get('ann', id); }
  function putAnn(id, obj) { return put('ann', obj, id); }

  /* ---------- スクラップブックのページ ---------- */
  function putPage(rec) { return put('pages', rec); }
  function getPage(id) { return get('pages', id); }
  function delPage(id) { return del('pages', id); }
  // そのスクラップブックのページのうち、この端末に絵があるものの id
  function pageKeys(scrap) {
    return tx('pages', 'readonly', function (t) { return t.objectStore('pages').index('scrap').getAllKeys(scrap); })
      .then(function (l) { return l || []; });
  }
  function pagesOf(scrap) {
    return tx('pages', 'readonly', function (t) { return t.objectStore('pages').index('scrap').getAll(scrap); })
      .then(function (l) { return l || []; });
  }
  // スクラップブックを丸ごと消す
  function removeScrap(id) {
    return tx(['books', 'ann', 'pages'], 'readwrite', function (t) {
      t.objectStore('books').delete(id);
      t.objectStore('ann').delete(id);
      var ix = t.objectStore('pages').index('scrap').openKeyCursor(IDBKeyRange.only(id));
      ix.onsuccess = function () { var c = ix.result; if (c) { t.objectStore('pages').delete(c.primaryKey); c.continue(); } };
    });
  }

  /* ---------- そのほか ---------- */
  function getKV(k) { return get('kv', k); }
  function putKV(k, v) { return put('kv', v, k); }
  function delKV(k) { return del('kv', k); }

  // 保存場所を、端末の空きが減っても勝手に消されにくい扱いにしてもらう（できる端末だけ）
  function persist() {
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); } catch (e) {}
  }
  function usage() {
    try {
      if (navigator.storage && navigator.storage.estimate) return navigator.storage.estimate().catch(function () { return null; });
    } catch (e) {}
    return Promise.resolve(null);
  }

  window.Store = {
    books: books, getBook: getBook, putBook: putBook, patchBook: patchBook, removeBook: removeBook,
    putChunk: putChunk, getChunk: getChunk, delChunks: delChunks, countChunks: countChunks,
    getAnn: getAnn, putAnn: putAnn,
    putPage: putPage, getPage: getPage, delPage: delPage, pagesOf: pagesOf, pageKeys: pageKeys, removeScrap: removeScrap,
    getKV: getKV, putKV: putKV, delKV: delKV, persist: persist, usage: usage
  };
})();
