/* 本の中身の出し入れ
   - 自炊した本は1冊で100MBを超えることがあるので、PDFを丸ごとメモリに載せない。
     端末（Store の chunks）に2MBずつ分けて置き、pdf.js には「言われた範囲だけ」渡す
   - スクラップブックは、写したページの絵（JPEG）の集まり。pdf.js のPDFと同じ形の入れ物（imageDoc）にして、
     表示の部分（app.js）からはPDFと同じように扱えるようにする */
(function () {
  'use strict';
  var CHUNK = 2 * 1024 * 1024;

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  /* ---------- 端末に入れる ---------- */
  // Blob（ファイルアプリで選んだPDFなど）を、2MBずつ端末に入れる。入れた数を返す
  async function importBlob(id, blob, onProgress) {
    var n = Math.ceil(blob.size / CHUNK);
    await Store.delChunks(id);
    for (var i = 0; i < n; i++) {
      var buf = await blob.slice(i * CHUNK, Math.min(blob.size, (i + 1) * CHUNK)).arrayBuffer();
      await Store.putChunk(id, i, buf);
      if (onProgress) onProgress(Math.min(blob.size, (i + 1) * CHUNK), blob.size);
    }
    return n;
  }
  /* 通信で届く順に、2MBたまるごとに端末に入れていく（Driveからのダウンロード用）
     w.push(届いたかたまり) を順に呼び、最後に w.close() を呼ぶ。from: 何番目のかたまりから続けるか */
  function writer(id, from) {
    var parts = [], have = 0, idx = from || 0, total = (from || 0) * CHUNK, q = Promise.resolve();
    function flush(all) {
      while (have >= CHUNK || (all && have > 0)) {
        var size = Math.min(CHUNK, have), out = new Uint8Array(size), off = 0;
        while (off < size) {
          var p = parts[0], take = Math.min(p.length, size - off);
          out.set(p.subarray(0, take), off); off += take;
          if (take === p.length) parts.shift(); else parts[0] = p.subarray(take);
        }
        have -= size;
        (function (i, buf) { q = q.then(function () { return Store.putChunk(id, i, buf); }); })(idx++, out.buffer);
      }
    }
    return {
      push: function (u8) { parts.push(u8); have += u8.length; total += u8.length; flush(false); return q; },
      close: function () { flush(true); return q.then(function () { return { chunks: idx, size: total }; }); },
      size: function () { return total; }
    };
  }

  /* ---------- 端末のPDFを、言われた範囲だけ読んで開く ---------- */
  var KEEP = 6; // 読んだかたまりを覚えておく数（6 × 2MB）
  function chunkReader(id) {
    var cache = new Map();
    function chunk(i) {
      var hit = cache.get(i);
      if (hit) { cache.delete(i); cache.set(i, hit); return hit; }
      var p = Store.getChunk(id, i).then(function (buf) {
        if (!buf) throw new Error('chunk_missing');
        return new Uint8Array(buf);
      });
      cache.set(i, p);
      p.catch(function () { cache.delete(i); });
      while (cache.size > KEEP) cache.delete(cache.keys().next().value);
      return p;
    }
    return async function read(begin, end) {
      var out = new Uint8Array(end - begin);
      for (var i = Math.floor(begin / CHUNK); i * CHUNK < end; i++) {
        var c = await chunk(i), a = Math.max(begin, i * CHUNK), b = Math.min(end, i * CHUNK + c.length);
        if (b > a) out.set(c.subarray(a - i * CHUNK, b - i * CHUNK), a - begin);
      }
      return out;
    };
  }
  function openPdf(book) {
    var read = chunkReader(book.id), size = book.size;
    var t = new pdfjsLib.PDFDataRangeTransport(size, null);
    var dead = false;
    t.requestDataRange = function (begin, end) {
      read(begin, Math.min(end, size)).then(function (u8) { if (!dead) t.onDataRange(begin, u8); }, function (e) {
        console.error(e);
        if (!dead && window.App) App.setStatus('本のデータを読めませんでした。本棚の「…」から、この端末に入れ直してください');
      });
    };
    var task = pdfjsLib.getDocument({ range: t, length: size, disableAutoFetch: true, disableStream: true, rangeChunkSize: 524288 });
    return task.promise.then(function (doc) {
      doc._dkClose = function () { dead = true; try { task.destroy(); } catch (e) {} };
      return doc;
    });
  }

  /* ---------- スクラップブック: 絵の集まりを、PDFと同じ形の入れ物にする ---------- */
  var imgs = new Map(), IMG_KEEP = 8;
  function pageImage(id) {
    var hit = imgs.get(id);
    if (hit) { imgs.delete(id); imgs.set(id, hit); return hit; }
    var p = Store.getPage(id).then(function (rec) {
      if (!rec || !rec.data) throw new Error('page_missing');
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(new Blob([rec.data], { type: 'image/jpeg' })), im = new Image();
        im.onload = function () { URL.revokeObjectURL(url); resolve(im); };
        im.onerror = function () { URL.revokeObjectURL(url); reject(new Error('page_image')); };
        im.src = url;
      });
    });
    imgs.set(id, p);
    p.catch(function () { imgs.delete(id); });
    while (imgs.size > IMG_KEEP) imgs.delete(imgs.keys().next().value);
    return p;
  }
  function forgetImage(id) { imgs.delete(id); }
  // items: [{ id, w, h }]（w, h はページの大きさ。PDFの単位）
  function imageDoc(items) {
    function page(it) {
      return {
        rotate: 0,
        getViewport: function (o) {
          var rot = (((o.rotation || 0) % 360) + 360) % 360, side = rot % 180 !== 0;
          var w = (side ? it.h : it.w) * o.scale, h = (side ? it.w : it.h) * o.scale;
          return { width: w, height: h, scale: o.scale, rotation: rot,
            convertToPdfPoint: function (x, y) { return [x / o.scale, (h - y) / o.scale]; } };
        },
        render: function (o) {
          var stop = false;
          var p = pageImage(it.id).then(function (im) {
            if (stop) { var e = new Error('cancelled'); e.name = 'RenderingCancelledException'; throw e; }
            var c = o.canvasContext, v = o.viewport;
            c.save();
            if (o.transform) c.transform.apply(c, o.transform);
            c.fillStyle = '#fff'; c.fillRect(0, 0, v.width, v.height);
            if (v.rotation) {
              c.translate(v.width / 2, v.height / 2); c.rotate(v.rotation * Math.PI / 180);
              var side = v.rotation % 180 !== 0, dw = side ? v.height : v.width, dh = side ? v.width : v.height;
              c.drawImage(im, -dw / 2, -dh / 2, dw, dh);
            } else c.drawImage(im, 0, 0, v.width, v.height);
            c.restore();
          });
          return { promise: p, cancel: function () { stop = true; } };
        },
        getTextContent: function () { return Promise.resolve({ items: [] }); }
      };
    }
    return {
      numPages: items.length, isImages: true,
      getPage: function (n) {
        var it = items[n - 1];
        return it ? Promise.resolve(page(it)) : Promise.reject(new Error('no_page'));
      },
      getMetadata: function () { return Promise.resolve({ info: {} }); },
      _dkClose: function () {}
    };
  }

  /* ---------- そのほか ---------- */
  function hex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  // ファイルアプリで選んだPDFの識別子: 大きさと、先頭・末尾の中身から作る（大きな本を丸ごと読まなくて済むように）
  async function localId(blob) {
    var n = 262144, head = await blob.slice(0, n).arrayBuffer(), tail = await blob.slice(Math.max(0, blob.size - n)).arrayBuffer();
    var all = new Uint8Array(head.byteLength + tail.byteLength + 8);
    all.set(new Uint8Array(head), 0); all.set(new Uint8Array(tail), head.byteLength);
    new DataView(all.buffer).setFloat64(head.byteLength + tail.byteLength, blob.size);
    return 'l:' + hex(await crypto.subtle.digest('SHA-256', all)).slice(0, 40);
  }
  function rid(prefix) {
    var a = new Uint8Array(8); crypto.getRandomValues(a);
    return (prefix || '') + hex(a.buffer);
  }
  function canvasBlob(canvas, type, q) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { if (b) resolve(b); else reject(new Error('to_blob')); }, type || 'image/jpeg', q || 0.85);
    });
  }

  window.Source = {
    CHUNK: CHUNK, importBlob: importBlob, writer: writer, openPdf: openPdf,
    imageDoc: imageDoc, pageImage: pageImage, forgetImage: forgetImage,
    localId: localId, rid: rid, canvasBlob: canvasBlob
  };
})();
