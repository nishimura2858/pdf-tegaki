/* ホーム画面（本棚）の設定
   - 右上の歯車のボタンで、設定の画面（iPadの「設定」アプリのような一覧）が下からせり上がって出る
   - 変えるとすぐ、うしろの本棚に反映される（「完了」を押すか、外側を押すと閉じる）
   - 設定はこの端末に覚えておく（localStorage「dk:homecfg」）。壁の写真は IndexedDB（kv「homeWall」）
   - 1冊ごとの印は本の記録に付ける: pin（最近の段に固定した時刻）, shelf（自分で作った段のid）, stash（本棚からしまった） */
(function () {
  'use strict';
  var KEY = 'dk:homecfg';
  var DEF = {
    group: 'folder',     // 段の分け方: folder（Driveのフォルダごと）| custom（自分で作った段）| none（分けない）
    sort: 'name',        // 段の中の並び順: name | recent | added | pages
    shelves: [],         // 自分で作った段 [{ id, name }]（上から順に）
    order: [],           // Driveのフォルダの段の順番（フォルダ名）
    folded: {},          // たたんでいる段
    recentShow: true, recentCount: 5, recentProg: true,
    spColor: 'cover',    // 背表紙の色: cover（表紙から）| name（名前から）| shelf（段ごとにそろえる）
    spWidth: 'pages',    // 背表紙の太さ: pages（ページ数どおり）| even（そろえる）
    spTitle: true, ribbon: true,
    wood: 'oak',         // 棚の色: light | oak | dark | white | black
    wall: 'plain',       // 壁: plain | plaster | brick | photo
    bookends: false, plant: false,
    theme: 'auto',       // 外観（アプリ全体）: auto | light | dark
    start: 'last',       // 最初に出す: shelf | scrap | last
    showUsage: true, showHelp: true
  };
  function clone(v) { return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; }
  var cfg = {};
  (function load() {
    var c = {};
    try { c = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {}
    Object.keys(DEF).forEach(function (k) { cfg[k] = k in c ? c[k] : clone(DEF[k]); });
  })();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) {} }
  var rT = 0;
  function rerender() {
    clearTimeout(rT);
    rT = setTimeout(function () { window.Library && Library.render().catch(function (e) { console.error(e); }); }, 0);
  }
  function set(k, v) { cfg[k] = v; save(); applyLook(); rerender(); if (sheetOpen) repaint(); }
  function changed() { save(); applyLook(); rerender(); if (sheetOpen) repaint(); }

  /* ---------- 見た目（棚の色・壁・外観）を画面に当てる ---------- */
  var WOOD = {
    light: { wall: '#efe5d3', board: '#d6b088', hi: '#e6c49f', lo: '#b48a60' },
    oak: null, // いつもの色（明るい・暗い外観に合わせて変わる）
    dark: { wall: '#3a2e24', board: '#5e412b', hi: '#7a5840', lo: '#3c2819' },
    white: { wall: '#f5f3ef', board: '#fbfaf8', hi: '#ffffff', lo: '#d8d3ca' },
    black: { wall: '#2b2b2d', board: '#1d1d1f', hi: '#3c3c3f', lo: '#0d0d0e' }
  };
  var wallUrl = '';
  function applyLook() {
    var root = document.documentElement;
    if (cfg.theme === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', cfg.theme);
    var home = document.getElementById('home'); if (!home) return;
    var w = WOOD[cfg.wood], st = home.style;
    ['wall', 'board', 'board-hi', 'board-lo'].forEach(function (k) { st.removeProperty('--shelf-' + k); });
    if (w) { st.setProperty('--shelf-wall', w.wall); st.setProperty('--shelf-board', w.board); st.setProperty('--shelf-board-hi', w.hi); st.setProperty('--shelf-board-lo', w.lo); }
    var wall = cfg.wall === 'photo' && !wallUrl ? 'plain' : cfg.wall;
    home.className = home.className.replace(/\bwall-\w+\b|\bwalled\b|\bno-sptitle\b/g, '').trim();
    home.classList.add('wall-' + wall);
    if (wall !== 'plain') home.classList.add('walled');
    if (!cfg.spTitle) home.classList.add('no-sptitle');
    if (wall === 'photo') st.setProperty('--wall-img', 'url("' + wallUrl + '")'); else st.removeProperty('--wall-img');
    var u = document.getElementById('usage'), h = document.querySelector('.h-help');
    if (u) u.classList.toggle('off', !cfg.showUsage);
    if (h) h.hidden = !cfg.showHelp;
  }
  if (window.Store) Store.getKV('homeWall').then(function (v) { if (v) { wallUrl = v; applyLook(); } }).catch(function () {});

  /* ---------- 1冊ごとの印（本の「…」・長押しのメニューからも使う） ---------- */
  function uid() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function newShelf(name) {
    name = String(name || '').trim(); if (!name) return null;
    var s = { id: uid(), name: name.slice(0, 40) };
    cfg.shelves.push(s); changed();
    return s;
  }
  function askNewShelf() {
    var n = window.prompt('新しい段の名前（例: 英語教育・授業づくり・雑誌）', '');
    return n ? newShelf(n) : null;
  }
  function toggleFold(key) {
    if (cfg.folded[key]) delete cfg.folded[key]; else cfg.folded[key] = true;
    save(); rerender();
  }

  /* ---------- 設定の画面 ---------- */
  var ICONS = {
    rows: '<path d="M4 5h16M4 12h16M4 19h16"/>',
    order: '<path d="M8 4v16M8 4L4.5 7.5M8 4l3.5 3.5M16 20V4M16 20l-3.5-3.5M16 20l3.5-3.5"/>',
    sort: '<path d="M4 6h10M4 12h7M4 18h4"/><path d="M17 5v14M17 19l-3-3M17 19l3-3"/>',
    box: '<path d="M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M3 4h18v4H3zM10 12h4"/>',
    photo: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5-8 8"/>'
  };
  function ic(name, color) {
    return '<span class="hs-ic" style="background:' + color + '"><svg viewBox="0 0 24 24">' + ICONS[name] + '</svg></span>';
  }
  var CHEV = '<svg class="hs-chev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>';
  var CHECK = '<svg class="hs-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function bare(n) { return String(n || '本').replace(/\.pdf$/i, ''); }
  function attr(v) { return esc(JSON.stringify(v)); }

  // 1行の部品
  function sec(t) { return '<div class="hs-sec">' + esc(t) + '</div>'; }
  function group(rows, foot) { return '<div class="hs-group">' + rows.join('') + '</div>' + (foot ? '<div class="hs-foot">' + foot + '</div>' : ''); }
  function nav(label, value, page, arg, icon) {
    return '<button class="hs-row nav' + (icon ? ' has-ic' : '') + '" data-act="nav" data-page="' + page + '"' + (arg ? ' data-arg="' + esc(arg) + '"' : '') + '>' + (icon || '') +
      '<span class="hs-lbl">' + label + '</span>' + (value != null ? '<span class="hs-val">' + esc(value) + '</span>' : '') + CHEV + '</button>';
  }
  function toggle(label, key, sub) {
    return '<button class="hs-row" data-act="toggle" data-key="' + key + '" role="switch" aria-checked="' + !!cfg[key] + '"><span class="hs-lbl">' + label +
      (sub ? '<small>' + sub + '</small>' : '') + '</span><span class="hs-sw' + (cfg[key] ? ' on' : '') + '"></span></button>';
  }
  function seg(label, key, opts, sub) {
    return '<div class="hs-row col"><span class="hs-lbl">' + label + (sub ? '<small>' + sub + '</small>' : '') + '</span><span class="hs-seg">' + opts.map(function (o) {
      return '<button data-act="set" data-key="' + key + '" data-v="' + attr(o[0]) + '" class="' + (cfg[key] === o[0] ? 'on' : '') + '">' + esc(o[1]) + '</button>';
    }).join('') + '</span></div>';
  }
  function stepper(label, key, min, max, unit) {
    return '<div class="hs-row"><span class="hs-lbl">' + label + '</span><span class="hs-step">' +
      '<button data-act="step" data-key="' + key + '" data-d="-1" data-min="' + min + '" data-max="' + max + '"' + (cfg[key] <= min ? ' disabled' : '') + ' aria-label="減らす">−</button>' +
      '<b>' + cfg[key] + unit + '</b>' +
      '<button data-act="step" data-key="' + key + '" data-d="1" data-min="' + min + '" data-max="' + max + '"' + (cfg[key] >= max ? ' disabled' : '') + ' aria-label="増やす">＋</button></span></div>';
  }
  function choice(label, key, value, sub) {
    return '<button class="hs-row" data-act="set" data-key="' + key + '" data-v="' + attr(value) + '"><span class="hs-lbl">' + label +
      (sub ? '<small>' + sub + '</small>' : '') + '</span>' + (cfg[key] === value ? CHECK : '') + '</button>';
  }
  function swatches(label, key, opts) {
    return '<div class="hs-row col"><span class="hs-lbl">' + label + '</span><span class="hs-sws">' + opts.map(function (o) {
      return '<button class="hs-swatch ' + (o.cls || '') + (cfg[key] === o.v ? ' on' : '') + '" data-act="' + (o.act || 'set') + '" data-key="' + key + '" data-v="' + attr(o.v) + '">' +
        '<i style="' + (o.style || '') + '">' + (o.inner || '') + '</i><span>' + esc(o.label) + '</span></button>';
    }).join('') + '</span></div>';
  }
  function act(label, a, cls, arg) {
    return '<button class="hs-row ' + (cls || '') + '" data-act="' + a + '"' + (arg ? ' data-arg="' + esc(arg) + '"' : '') + '><span class="hs-lbl">' + label + '</span></button>';
  }

  var GROUP_LABEL = { folder: 'Driveのフォルダごと', custom: '自分で作った段', none: '分けない' };
  var SORT_LABEL = { name: '名前順', recent: '最近開いた順', added: '本棚に入れた順', pages: 'ページ数の多い順' };
  function woodPrev(k) {
    var w = WOOD[k] || { wall: '#e4d8c3', board: '#b08155', hi: '#c99a6c', lo: '#8a6140' };
    return 'background:linear-gradient(to bottom,' + w.wall + ' 0 66%,' + w.hi + ' 66% 70%,' + w.board + ' 70% 90%,' + w.lo + ' 90%)';
  }
  function folderKey(b) { return b.kind === 'local' ? '￿このiPadから入れた本' : (b.folder || ''); }
  function folderName(g) { return g ? g.replace(/^￿/, '') : 'フォルダに入れていない本'; }
  // 本棚に並んでいるDriveのフォルダ（いまの順番で）
  function folderOrder(books) {
    var seen = {}, list = [];
    books.forEach(function (b) { if (b.kind === 'scrap') return; var g = folderKey(b); if (!seen[g]) { seen[g] = true; list.push(g); } });
    return sortFolders(list);
  }
  function sortFolders(list) {
    return list.slice().sort(function (a, b) {
      var ia = cfg.order.indexOf(a), ib = cfg.order.indexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1; if (ib >= 0) return 1;
      return a.localeCompare(b, 'ja', { numeric: true });
    });
  }
  function allBooks() { return Store.books().then(function (l) { return l.filter(function (b) { return b.kind !== 'scrap'; }); }); }

  var PAGES = {
    main: { title: '本棚の設定', render: async function () {
      var books = await allBooks(), stash = books.filter(function (b) { return b.stash; }).length;
      var rowsVal = cfg.group === 'custom' ? cfg.shelves.length + '段' : cfg.group === 'folder' ? folderOrder(books.filter(function (b) { return !b.stash; })).length + '段' : '';
      return sec('本棚') + group([
        nav('段の分け方', GROUP_LABEL[cfg.group], 'group', null, ic('rows', '#7d95d8')),
        nav(cfg.group === 'custom' ? '段を作る・名前・順番' : '段の順番', rowsVal, 'rows', null, ic('order', '#2e9e55')),
        nav('段の中の並び順', SORT_LABEL[cfg.sort], 'sort', null, ic('sort', '#d9822b')),
        nav('しまった本', stash + '冊', 'stash', null, ic('box', '#8d6e63'))
      ], '段の名前を押すと、その段をたためます。本を長押しすると「段を移す」「ピン留め」「本棚からしまう」が出ます。') +
      sec('最近読んでいる本') + group([
        toggle('いちばん上の段に出す', 'recentShow'),
        stepper('並べる冊数', 'recentCount', 3, 10, '冊'),
        toggle('どこまで読んだかのバー', 'recentProg', '表紙の下に細い線で出します')
      ], 'ピン留めした本は、冊数に関係なくいつも先頭に並びます。') +
      sec('背表紙') + group([
        seg('色', 'spColor', [['cover', '表紙から'], ['name', '名前から'], ['shelf', '段ごとにそろえる']]),
        seg('太さ', 'spWidth', [['pages', 'ページ数どおり'], ['even', 'そろえる']], 'そろえると、1段にたくさん並びます'),
        toggle('書名を出す', 'spTitle'),
        toggle('しおりのひも', 'ribbon', '読みかけの本だけ、背表紙の下からひもが出ます')
      ]) +
      sec('見た目') + group([
        swatches('棚の色', 'wood', [
          { v: 'light', label: '明るい木', style: woodPrev('light') }, { v: 'oak', label: '木', style: woodPrev('oak') },
          { v: 'dark', label: '濃い木', style: woodPrev('dark') }, { v: 'white', label: '白', style: woodPrev('white') },
          { v: 'black', label: '黒', style: woodPrev('black') }]),
        swatches('壁', 'wall', [
          { v: 'plain', label: '無地', cls: 'wp-plain' }, { v: 'plaster', label: 'しっくい', cls: 'wp-plaster' },
          { v: 'brick', label: 'レンガ', cls: 'wp-brick' },
          { v: 'photo', label: wallUrl ? '写真' : '写真を選ぶ', act: 'wallPhoto', cls: 'wp-photo',
            style: wallUrl ? 'background:url(&quot;' + esc(wallUrl) + '&quot;) center/cover' : '', inner: wallUrl ? '' : '<svg viewBox="0 0 24 24">' + ICONS.photo + '</svg>' }]),
        toggle('本立て', 'bookends', '段の両はしに本立てを置きます'),
        toggle('観葉植物', 'plant', 'いちばん上の段に鉢植えを飾ります'),
        seg('外観', 'theme', [['auto', '自動'], ['light', 'ライト'], ['dark', 'ダーク']], '読んでいるときの画面も含め、アプリ全体が変わります')
      ], wallUrl ? '<button class="hs-flink" data-act="wallPhoto">壁の写真を選び直す</button>　<button class="hs-flink" data-act="wallClear">写真を消す</button>' : '') +
      sec('ホーム画面') + group([
        seg('アプリを開いたときに出す', 'start', [['shelf', '本棚'], ['scrap', 'スクラップブック'], ['last', '前回のまま']]),
        toggle('この端末に入っている量を出す', 'showUsage'),
        toggle('「使い方」を出す', 'showHelp')
      ]) +
      '<div class="hs-gap"></div>' + group([act('すべて最初の設定に戻す', 'reset', 'danger center')],
        'この設定は、このiPadに覚えておきます。本・書き込み・スクラップブックは変わりません。') +
      '<div class="hs-ver">' + esc((document.getElementById('verText') || {}).textContent || '') + '</div>';
    } },
    group: { title: '段の分け方', render: function () {
      return '<div class="hs-gap"></div>' + group([
        choice('Driveのフォルダごと', 'group', 'folder', 'Googleドライブの「読書ノート」の中のフォルダが、そのまま段になります'),
        choice('自分で作った段', 'group', 'custom', '「英語教育」「雑誌」のように段を作り、本を好きな段へ入れます'),
        choice('分けない', 'group', 'none', 'すべての本を1つの棚に並べます')
      ]) + (cfg.group === 'custom' ? '<div class="hs-gap"></div>' + group([nav('段を作る・名前・順番', cfg.shelves.length + '段', 'rows')]) : '');
    } },
    sort: { title: '段の中の並び順', render: function () {
      return '<div class="hs-gap"></div>' + group(Object.keys(SORT_LABEL).map(function (k) { return choice(SORT_LABEL[k], 'sort', k); }));
    } },
    rows: { title: '段', render: async function () {
      if (cfg.group === 'none') return '<div class="hs-gap"></div>' + group([nav('段の分け方', GROUP_LABEL[cfg.group], 'group')], 'いまは段に分けずに並べています。段を使うときは、分け方を変えてください。');
      if (cfg.group === 'folder') {
        var books = (await allBooks()).filter(function (b) { return !b.stash; }), list = folderOrder(books);
        var count = {}; books.forEach(function (b) { var g = folderKey(b); count[g] = (count[g] || 0) + 1; });
        return sec('上から順に並びます') + group(list.map(function (g, i) {
          return moveRow(esc(folderName(g)), count[g] + '冊', 'f', i, list.length);
        }), '段の名前はDriveのフォルダの名前です。名前を変えるときは、Driveでフォルダの名前を変えてください。');
      }
      var all = await allBooks(), n = {};
      all.forEach(function (b) { if (b.shelf && !b.stash) n[b.shelf] = (n[b.shelf] || 0) + 1; });
      return sec('上から順に並びます') + group(cfg.shelves.map(function (s, i) {
        return moveRow(esc(s.name), (n[s.id] || 0) + '冊', 'c', i, cfg.shelves.length, s.id);
      }).concat([act('＋ 新しい段を作る', 'newShelf', 'add')]), 'どの段にも入れていない本は、いちばん下の「そのほかの本」に並びます。段の名前を押すと、名前を変えたり、本を入れたりできます。');
    } },
    shelf: { title: '段', render: async function (id) {
      var s = cfg.shelves.filter(function (x) { return x.id === id; })[0];
      if (!s) return '<div class="hs-gap"></div><div class="hs-foot">この段はもうありません。</div>';
      var books = (await allBooks()).filter(function (b) { return !b.stash; }).sort(function (a, b) { return bare(a.name).localeCompare(bare(b.name), 'ja', { numeric: true }); });
      var names = {}; cfg.shelves.forEach(function (x) { names[x.id] = x.name; });
      return sec('名前') + group([act(esc(s.name) + '<small>押して名前を変える</small>', 'renameShelf', 'nm', id)]) +
        sec('この段に入れる本（押して入れる・外す）') + (books.length ? group(books.map(function (b) {
          var on = b.shelf === id, other = !on && names[b.shelf];
          return '<button class="hs-row" data-act="putBook" data-arg="' + esc(id) + '" data-book="' + esc(b.id) + '"><span class="hs-lbl">' + esc(bare(b.name)) +
            (other ? '<small>いまは「' + esc(other) + '」</small>' : '') + '</span>' + (on ? CHECK : '') + '</button>';
        })) : '<div class="hs-foot">本棚に本がありません。</div>') +
        '<div class="hs-gap"></div>' + group([act('この段を削除', 'delShelf', 'danger center', id)], '段を削除しても、本は消えません（「そのほかの本」に並びます）。');
    } },
    stash: { title: 'しまった本', render: async function () {
      var list = (await allBooks()).filter(function (b) { return b.stash; });
      if (!list.length) return '<div class="hs-empty"><svg viewBox="0 0 24 24">' + ICONS.box + '</svg><b>しまった本はありません</b>読み終えた本などは、本を長押しして「本棚からしまう」を選ぶと、本棚から下げてここにまとめられます。</div>';
      return sec(list.length + '冊') + group(list.map(function (b) {
        return '<div class="hs-row"><span class="hs-lbl">' + esc(bare(b.name)) + '</span><button class="hs-pill" data-act="unstash" data-book="' + esc(b.id) + '">本棚に戻す</button></div>';
      }), 'しまった本も、この端末やDriveからは消えていません。書き込みもそのままです。');
    } }
  };
  function moveRow(label, val, kind, i, n, id) {
    var main = kind === 'c'
      ? '<button class="hs-mvlbl" data-act="nav" data-page="shelf" data-arg="' + esc(id) + '"><span class="hs-lbl">' + label + '</span><span class="hs-val">' + val + '</span>' + CHEV + '</button>'
      : '<span class="hs-mvlbl"><span class="hs-lbl">' + label + '</span><span class="hs-val">' + val + '</span></span>';
    return '<div class="hs-row mv">' + main + '<span class="hs-mv">' +
      '<button data-act="move" data-kind="' + kind + '" data-i="' + i + '" data-d="-1"' + (i === 0 ? ' disabled' : '') + ' aria-label="上へ"><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg></button>' +
      '<button data-act="move" data-kind="' + kind + '" data-i="' + i + '" data-d="1"' + (i === n - 1 ? ' disabled' : '') + ' aria-label="下へ"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button></span></div>';
  }

  // 画面の骨組み
  var sheet = document.createElement('div');
  sheet.id = 'hsSheet'; sheet.hidden = true;
  sheet.innerHTML = '<div class="hs-back"></div><div class="hs-panel" role="dialog" aria-modal="true" aria-label="本棚の設定">' +
    '<div class="hs-nav"><button class="hs-backbtn" data-act="back" hidden><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg><span></span></button>' +
    '<b class="hs-title"></b><button class="hs-done" data-act="done">完了</button></div><div class="hs-stack"></div></div>' +
    '<input type="file" accept="image/*" hidden>';
  document.body.appendChild(sheet);
  var panel = sheet.querySelector('.hs-panel'), stackEl = sheet.querySelector('.hs-stack'), titleEl = sheet.querySelector('.hs-title');
  var backBtn = sheet.querySelector('.hs-backbtn'), fileIn = sheet.querySelector('input[type=file]');
  var stack = [], sheetOpen = false;

  async function paintInto(el, entry) {
    el.innerHTML = await PAGES[entry.page].render(entry.arg);
  }
  function curEl() { return stackEl.lastElementChild; }
  function navBar() {
    var top = stack[stack.length - 1], prev = stack[stack.length - 2];
    titleEl.textContent = top.page === 'shelf' ? (cfg.shelves.filter(function (s) { return s.id === top.arg; })[0] || { name: '段' }).name : PAGES[top.page].title;
    backBtn.hidden = !prev;
    if (prev) backBtn.querySelector('span').textContent = prev.page === 'main' ? '設定' : PAGES[prev.page].title;
  }
  function repaint() { // いまの画面を描き直す（スクロールの位置はそのまま）
    var el = curEl(); if (!el) return;
    var top = el.scrollTop;
    paintInto(el, stack[stack.length - 1]).then(function () { el.scrollTop = top; navBar(); });
  }
  function push(page, arg) {
    var old = curEl(), el = document.createElement('div');
    el.className = 'hs-page r';
    stack.push({ page: page, arg: arg });
    navBar();
    paintInto(el, stack[stack.length - 1]).then(function () {
      stackEl.appendChild(el);
      void el.offsetWidth;
      el.classList.remove('r');
      if (old) old.classList.add('l');
    });
  }
  function pop() {
    if (stack.length < 2) return;
    var el = curEl(), prev = el.previousElementSibling;
    stack.pop(); navBar();
    el.classList.add('r');
    if (prev) { prev.classList.remove('l'); paintInto(prev, stack[stack.length - 1]); }
    setTimeout(function () { el.remove(); }, 340);
  }
  function openSheet() {
    if (sheetOpen) return;
    window.App && App.toolbar && App.toolbar.closePops();
    sheetOpen = true; stack = []; stackEl.textContent = '';
    sheet.hidden = false;
    push('main');
    requestAnimationFrame(function () { requestAnimationFrame(function () { sheet.classList.add('open'); }); });
  }
  function closeSheet() {
    if (!sheetOpen) return;
    sheetOpen = false;
    sheet.classList.remove('open');
    setTimeout(function () { if (!sheetOpen) { sheet.hidden = true; stackEl.textContent = ''; } }, 320);
  }
  sheet.querySelector('.hs-back').addEventListener('click', closeSheet);
  document.addEventListener('keydown', function (e) { if (sheetOpen && e.key === 'Escape') closeSheet(); });

  function moveIn(list, i, d) { var j = i + d; if (j < 0 || j >= list.length) return list; var x = list[i]; list[i] = list[j]; list[j] = x; return list; }
  panel.addEventListener('click', async function (e) {
    var b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    var d = b.dataset, a = d.act;
    try {
      switch (a) {
        case 'done': closeSheet(); break;
        case 'back': pop(); break;
        case 'nav': push(d.page, d.arg); break;
        case 'toggle': set(d.key, !cfg[d.key]); break;
        case 'set': set(d.key, JSON.parse(d.v)); break;
        case 'step': set(d.key, Math.max(+d.min, Math.min(+d.max, cfg[d.key] + +d.d))); break;
        case 'move':
          if (d.kind === 'c') { moveIn(cfg.shelves, +d.i, +d.d); changed(); }
          else { cfg.order = moveIn(folderOrder((await allBooks()).filter(function (x) { return !x.stash; })), +d.i, +d.d); changed(); }
          break;
        case 'newShelf': if (askNewShelf()) repaint(); break;
        case 'renameShelf': {
          var s = cfg.shelves.filter(function (x) { return x.id === d.arg; })[0]; if (!s) break;
          var n = window.prompt('段の名前', s.name);
          if (n && n.trim()) { s.name = n.trim().slice(0, 40); changed(); }
          break;
        }
        case 'delShelf': {
          var s2 = cfg.shelves.filter(function (x) { return x.id === d.arg; })[0]; if (!s2) break;
          if (!window.confirm('段「' + s2.name + '」を削除しますか？\n入っている本は消えずに、「そのほかの本」に並びます。')) break;
          cfg.shelves = cfg.shelves.filter(function (x) { return x.id !== d.arg; });
          delete cfg.folded['c:' + d.arg];
          var bs = await allBooks();
          for (var i = 0; i < bs.length; i++) if (bs[i].shelf === d.arg) await Store.patchBook(bs[i].id, { shelf: undefined });
          changed(); pop();
          break;
        }
        case 'putBook': {
          var bk = await Store.getBook(d.book); if (!bk) break;
          await Store.patchBook(d.book, { shelf: bk.shelf === d.arg ? undefined : d.arg });
          rerender(); repaint();
          break;
        }
        case 'unstash': await Store.patchBook(d.book, { stash: undefined }); rerender(); repaint(); break;
        case 'wallPhoto': fileIn.click(); break;
        case 'wallClear':
          wallUrl = ''; await Store.delKV('homeWall');
          if (cfg.wall === 'photo') cfg.wall = 'plain';
          changed();
          break;
        case 'reset':
          if (!window.confirm('本棚の設定を、すべて最初の状態に戻しますか？\n自分で作った段・ピン留め・しまった本の印も外れます（本と書き込みはそのままです）。')) break;
          Object.keys(DEF).forEach(function (k) { cfg[k] = clone(DEF[k]); });
          var all = await allBooks();
          for (var j = 0; j < all.length; j++) if (all[j].shelf || all[j].pin || all[j].stash) await Store.patchBook(all[j].id, { shelf: undefined, pin: undefined, stash: undefined });
          wallUrl = ''; await Store.delKV('homeWall').catch(function () {});
          changed();
          break;
      }
    } catch (err) { console.error(err); }
  });
  // 壁の写真: 選んだ画像を、長い辺2000pxのJPEGにしてこの端末に取っておく
  fileIn.addEventListener('change', function () {
    var f = fileIn.files[0]; fileIn.value = '';
    if (!f) return;
    var u = URL.createObjectURL(f), im = new Image();
    im.onload = function () {
      var k = Math.min(1, 2000 / Math.max(im.naturalWidth, im.naturalHeight)), c = document.createElement('canvas');
      c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(u);
      var data = c.toDataURL('image/jpeg', 0.82); c.width = c.height = 0;
      Store.putKV('homeWall', data).then(function () { wallUrl = data; set('wall', 'photo'); })
        .catch(function (e) { console.error(e); window.App && App.setStatus('写真を取っておけませんでした（端末の空きが足りない可能性があります）'); });
    };
    im.onerror = function () { URL.revokeObjectURL(u); window.App && App.setStatus('この画像は使えませんでした'); };
    im.src = u;
  });

  applyLook();
  window.HomeSet = {
    cfg: cfg, open: openSheet, close: closeSheet, set: set, changed: changed, applyLook: applyLook,
    newShelf: newShelf, askNewShelf: askNewShelf, toggleFold: toggleFold,
    folderKey: folderKey, sortFolders: sortFolders
  };
})();
