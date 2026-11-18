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
  // bw: 白黒にした絵を返す（スクラップのページごとの「白黒にする」。書き込みは別に描くので色のまま）
  function pageImage(id, bw) {
    var key = bw ? id + '|bw' : id, hit = imgs.get(key);
    if (hit) { imgs.delete(key); imgs.set(key, hit); return hit; }
    var p = bw ? pageImage(id).then(toBw) : Store.getPage(id).then(function (rec) {
      if (!rec || !rec.data) throw new Error('page_missing');
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(new Blob([rec.data], { type: 'image/jpeg' })), im = new Image();
        im.onload = function () { URL.revokeObjectURL(url); resolve(im); };
        im.onerror = function () { URL.revokeObjectURL(url); reject(new Error('page_image')); };
        im.src = url;
      });
    });
    imgs.set(key, p);
    p.catch(function () { imgs.delete(key); });
    while (imgs.size > IMG_KEEP) imgs.delete(imgs.keys().next().value);
    return p;
  }
  function forgetImage(id) { imgs.delete(id); imgs.delete(id + '|bw'); }
  /* 白黒にする: 灰色にしてから、紙の色（黄ばみ・のどの影・ムラ）を白に、文字を黒に寄せる。
     紙の明るさは場所ごとに測る（小さな区画ごとの「明るいほうの平均」を、まわりと合わせてなめらかにしたもの）ので、
     のどの近くが暗いスキャンでも、紙はむらなく白くなる。写真などの濃淡は残す（白と黒の2色にはしない） */
  function toBw(im) {
    var W = im.naturalWidth || im.width, H = im.naturalHeight || im.height;
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var x = c.getContext('2d');
    x.drawImage(im, 0, 0);
    var d = x.getImageData(0, 0, W, H), a = d.data, n = W * H, L = new Uint8Array(n), i, j;
    for (i = 0, j = 0; i < n; i++, j += 4) L[i] = (a[j] * 77 + a[j + 1] * 150 + a[j + 2] * 29) >> 8;
    // 区画ごとの紙の明るさ
    var cs = Math.max(8, Math.round(Math.max(W, H) / 48)), gw = Math.ceil(W / cs), gh = Math.ceil(H / cs);
    var bg = new Float32Array(gw * gh), gx, gy, px, py;
    for (gy = 0; gy < gh; gy++) for (gx = 0; gx < gw; gx++) {
      var x0 = gx * cs, y0 = gy * cs, x1 = Math.min(W, x0 + cs), y1 = Math.min(H, y0 + cs), s = 0, k = 0;
      for (py = y0; py < y1; py += 2) for (px = x0; px < x1; px += 2) { s += L[py * W + px]; k++; }
      var mean = s / k, su = 0, ku = 0;
      for (py = y0; py < y1; py += 2) for (px = x0; px < x1; px += 2) { var v = L[py * W + px]; if (v >= mean) { su += v; ku++; } }
      bg[gy * gw + gx] = ku ? su / ku : mean;
    }
    var sorted = Array.prototype.slice.call(bg).sort(function (p, q) { return p - q; });
    var paper = sorted[Math.floor(sorted.length * 0.8)] || 255;
    // 紙の明るさが大きく下がってよいのは、左右の端（のどの影が出る所）だけ。まん中の写真・図は、紙として扱わない
    var floorAt = new Float32Array(gw);
    for (gx = 0; gx < gw; gx++) {
      var e = Math.min(gx + 0.5, gw - gx - 0.5) / gw;
      floorAt[gx] = paper * (e >= 0.14 ? 0.85 : 0.3 + 0.55 * e / 0.14);
    }
    // まわりの区画のいちばん明るい値にそろえ（太い文字・図の上の区画も、紙の明るさにする）、なめらかにする
    function pass(src, fn) {
      var out = new Float32Array(gw * gh);
      for (gy = 0; gy < gh; gy++) for (gx = 0; gx < gw; gx++) {
        var acc = 0, cnt = 0;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          var X = gx + dx, Y = gy + dy; if (X < 0 || Y < 0 || X >= gw || Y >= gh) continue;
          var b = src[Y * gw + X];
          if (fn === 'max') acc = Math.max(acc, b); else { acc += b; cnt++; }
        }
        out[gy * gw + gx] = fn === 'max' ? Math.max(floorAt[gx], acc) : acc / cnt;
      }
      return out;
    }
    bg = pass(pass(pass(bg, 'max'), 'avg'), 'avg');
    // 紙の明るさに対する割合で、白黒の濃さを決める
    var LO = 0.3, HI = 0.9, map = new Uint8Array(1024);
    for (i = 0; i < 1024; i++) { var t = Math.max(0, Math.min(1, (i / 1023 * 1.25 - LO) / (HI - LO))); map[i] = Math.round(255 * Math.pow(t, 1.2)); }
    for (py = 0; py < H; py++) {
      var fy = Math.max(0, Math.min(gh - 1, py / cs - 0.5)), ya = Math.floor(fy), yb = Math.min(gh - 1, ya + 1), wy = fy - ya;
      for (px = 0; px < W; px++) {
        var fx = Math.max(0, Math.min(gw - 1, px / cs - 0.5)), xa = Math.floor(fx), xb = Math.min(gw - 1, xa + 1), wx = fx - xa;
        var top = bg[ya * gw + xa] * (1 - wx) + bg[ya * gw + xb] * wx, bot = bg[yb * gw + xa] * (1 - wx) + bg[yb * gw + xb] * wx;
        var r = L[py * W + px] / Math.max(1, top * (1 - wy) + bot * wy); // 0〜1.25 を 0〜1023 に
        var g = map[Math.min(1023, Math.round(r / 1.25 * 1023))], q = (py * W + px) * 4;
        a[q] = a[q + 1] = a[q + 2] = g; a[q + 3] = 255;
      }
    }
    x.putImageData(d, 0, 0);
    return c;
  }
  // items: [{ id, w, h, bw }]（w, h はページの大きさ。PDFの単位。bw: 白黒で見せる）
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
          var p = pageImage(it.id, !!it.bw).then(function (im) {
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
