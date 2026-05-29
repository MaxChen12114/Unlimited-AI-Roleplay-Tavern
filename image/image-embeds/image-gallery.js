// image-gallery.js —— 工坊内画廊 tab + 手动收藏入 R2 + KV 跨设备同步 + IDB 缓存
(function () {
  if (window.__gallery) return;
  var LS_META = 'cfw_image_gallery_v1';   // 本地元数据(离线兜底,JSON 数组)
  var IDB_NAME = 'cfw_image_gallery';
  var IDB_STORE = 'blobs';

  // ── 鉴权:复用文本侧云同步 token(= CHAT_PASSWORD)──
  function token() { try { return (window.__auth && window.__auth.getToken && window.__auth.getToken()) || ''; } catch (e) { return ''; } }
  function syncHeaders(extra) { var h = extra || {}; var t = token(); if (t) h['Authorization'] = 'Bearer ' + t; return h; }
  function syncOn() { try { return !!(window.__sync && window.__sync.syncEnabled && window.__sync.syncEnabled()) && !!token(); } catch (e) { return false; } }

  // ── 本地元数据 ──
  var STATE = { items: load() };
  function load() { try { return JSON.parse(localStorage.getItem(LS_META) || '[]') || []; } catch (e) { return []; } }
  function persist() { try { localStorage.setItem(LS_META, JSON.stringify(STATE.items)); } catch (e) {} }
  function uuid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('g-' + Date.now() + '-' + Math.random().toString(16).slice(2)); }
  function visible() { return STATE.items.filter(function (it) { return it && !it.deleted; }); }

  // ── IDB 缓存(blob)──
  function idb() {
    return new Promise(function (res) {
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () { try { req.result.createObjectStore(IDB_STORE); } catch (e) {} };
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { res(null); };
    });
  }
  async function idbPut(key, blob) { var db = await idb(); if (!db) return; try { db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(blob, key); } catch (e) {} }
  async function idbGet(key) {
    var db = await idb(); if (!db) return null;
    return new Promise(function (res) { try { var r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key); r.onsuccess = function () { res(r.result || null); }; r.onerror = function () { res(null); }; } catch (e) { res(null); } });
  }

  // ── 同步:拉 / 合并(id-union, 较新覆盖, 保留 tombstone) / 推 ──
  function merge(a, b) {
    var map = {};
    (a || []).forEach(function (it) { if (it && it.id) map[it.id] = it; });
    (b || []).forEach(function (it) { if (!it || !it.id) return; var p = map[it.id]; if (!p || (it.ts || 0) >= (p.ts || 0)) map[it.id] = it; });
    var arr = Object.keys(map).map(function (k) { return map[k]; });
    arr.sort(function (x, y) { return (y.ts || 0) - (x.ts || 0); });
    return arr;
  }
  async function pull() {
    if (!syncOn()) { renderGrid(); return; }
    try {
      var r = await fetch('/img/gallery', { headers: syncHeaders() });
      if (!r.ok) return;
      var j = await r.json();
      STATE.items = merge(STATE.items, j.items || []);
      persist(); renderGrid();
    } catch (e) {}
  }
  var pushTimer = null;
  function pushSoon() { if (!syncOn()) return; if (pushTimer) clearTimeout(pushTimer); pushTimer = setTimeout(doPush, 1500); }
  async function doPush() {
    pushTimer = null;
    if (!syncOn()) return;
    try {
      var r = await fetch('/img/gallery', { method: 'PUT', headers: syncHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ items: STATE.items }) });
      if (!r.ok) return;
      var j = await r.json();
      STATE.items = merge(STATE.items, j.items || []);
      persist(); renderGrid();
    } catch (e) {}
  }

  // ── 收藏 / 删除 ──
  async function favorite(srcUrl, info) {
    info = info || {};
    if (!srcUrl) return;
    var savedUrl = srcUrl, key = '', r2Missing = false;
    if (syncOn()) {
      try {
        var r = await fetch('/img/r2/save?url=' + encodeURIComponent(srcUrl), { method: 'POST', headers: syncHeaders() });
        if (r.ok) { var j = await r.json(); key = j.key || ''; savedUrl = j.url || srcUrl; }
        else if (r.status === 501) { r2Missing = true; } // 未绑 R2 → 纯本地降级
      } catch (e) {}
    }
    var item = { id: uuid(), key: key, url: savedUrl, src: srcUrl, kind: info.kind || '', prompt: info.prompt || '', ts: Date.now(), deleted: false, local: !key };
    STATE.items.unshift(item);
    persist();
    // 缓存 blob 到 IDB(R2 用 key,纯本地用 local:<id>),保证缩略图离线 / 过期后仍可显示
    var cacheKey = key || ('local:' + item.id);
    try { var b = await (await fetch(key ? savedUrl : ('/img/dl?url=' + encodeURIComponent(srcUrl)))).blob(); if (b) await idbPut(cacheKey, b); } catch (e) {}
    renderGrid();
    // 仅当图已进 R2 才把元数据推 KV;没 R2 的纯本地条目不同步,避免别的设备拿到裂图
    if (key) pushSoon();
    toast(key ? (syncOn() ? '已收藏并同步到画廊' : '已收藏到本地画廊')
              : (r2Missing ? '未配置云存储,收藏仅保存在本机' : '已收藏到本地画廊(未开云同步,暂不跨设备)'));
    return item;
  }
  function remove(id) {
    var it = STATE.items.filter(function (x) { return x.id === id; })[0];
    if (!it) return;
    it.deleted = true; it.ts = Date.now();
    persist(); renderGrid(); pushSoon();
  }
  function toast(msg) {
    try { var t = document.getElementById('galToast'); if (!t) { t = document.createElement('div'); t.id = 'galToast'; t.className = 'gal-toast'; document.body.appendChild(t); } t.textContent = msg; t.style.opacity = '1'; setTimeout(function () { t.style.opacity = '0'; }, 2000); } catch (e) {}
  }

  // ── 缩略图取源:优先 IDB 缓存,否则走 R2/原始 url ──
  async function thumbSrc(it) {
    var ck = it.key || ('local:' + it.id);
    var b = await idbGet(ck); if (b) return URL.createObjectURL(b);
    return it.url || it.src || '';
  }

  // ── UI:工坊(#imgBody)内画廊 tab ──
  function ensureStyles() {
    if (document.getElementById('galStyles')) return;
    var s = document.createElement('style'); s.id = 'galStyles';
    s.textContent = [
      '.gal-bar{display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap;}',
      '.gal-btn{font-size:12px;padding:5px 9px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;cursor:pointer;opacity:.85;}',
      '.gal-btn:hover{opacity:1;background:rgba(127,127,127,.12);}',
      '#galPanel{position:absolute;inset:0;z-index:6;background:inherit;overflow:auto;padding:12px;}',
      '.gal-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;}',
      '.gal-cell{position:relative;border:1px solid rgba(127,127,127,.3);border-radius:8px;overflow:hidden;}',
      '.gal-cell img{width:100%;display:block;cursor:zoom-in;}',
      '.gal-cell .gal-actions{position:absolute;top:4px;right:4px;display:flex;gap:4px;}',
      '.gal-cell .gal-actions button{font-size:11px;padding:2px 6px;border-radius:5px;border:none;background:rgba(0,0,0,.55);color:#fff;cursor:pointer;}',
      '.gal-empty{opacity:.55;font-size:12px;padding:24px;text-align:center;}',
      '.gal-toast{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);background:rgba(0,0,0,.82);color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;z-index:9999;opacity:0;transition:opacity .3s;pointer-events:none;}'
    ].join('\n');
    document.head.appendChild(s);
  }
  function ensureUI() {
    var body = document.getElementById('imgBody');
    if (!body || body.__galDone) return;
    body.__galDone = true;
    try { if (getComputedStyle(body).position === 'static') body.style.position = 'relative'; } catch (e) {}
    var bar = document.createElement('div'); bar.className = 'gal-bar';
    bar.innerHTML = '<button id="galToggleBtn" class="gal-btn">🖼️ 画廊</button>';
    body.insertBefore(bar, body.firstChild);
    var panel = document.createElement('div'); panel.id = 'galPanel'; panel.style.display = 'none';
    panel.innerHTML = '<div class="gal-bar"><button id="galBackBtn" class="gal-btn">← 返回生成</button><button id="galRefreshBtn" class="gal-btn">↻ 刷新</button></div><div class="gal-grid" id="galGrid"></div>';
    body.appendChild(panel);
    bar.querySelector('#galToggleBtn').onclick = function () { panel.style.display = 'block'; renderGrid(); pull(); };
    panel.querySelector('#galBackBtn').onclick = function () { panel.style.display = 'none'; };
    panel.querySelector('#galRefreshBtn').onclick = function () { pull(); };
    renderGrid();
  }
  async function renderGrid() {
    var grid = document.getElementById('galGrid');
    if (!grid) return;
    var items = visible();
    if (!items.length) { grid.innerHTML = '<div class="gal-empty">画廊还是空的。生成图片后点「⭐ 收藏」即可存入,开了云同步还能跨设备。</div>'; return; }
    grid.innerHTML = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var cell = document.createElement('div'); cell.className = 'gal-cell';
      var im = document.createElement('img');
      im.src = await thumbSrc(it);
      im.title = ((it.kind || '') + ' ' + (it.prompt || '')).trim();
      (function (u) { im.onclick = function () { openInStudio(u); }; })(it.url || it.src);
      var acts = document.createElement('div'); acts.className = 'gal-actions';
      var del = document.createElement('button'); del.textContent = '🗑';
      (function (id) { del.onclick = function (e) { e.stopPropagation(); remove(id); }; })(it.id);
      acts.appendChild(del);
      cell.appendChild(im); cell.appendChild(acts);
      grid.appendChild(cell);
    }
  }
  function openInStudio(url) {
    try {
      if (window.__image && window.__image.open) window.__image.open();
      var out = document.getElementById('imgOutput');
      if (out) { var im = document.createElement('img'); im.src = url; im.style.maxWidth = '100%'; out.innerHTML = ''; out.appendChild(im); }
      var p = document.getElementById('galPanel'); if (p) p.style.display = 'none';
    } catch (e) {}
  }

  // 工坊是按需创建的:监听 DOM,出现 #imgBody 就注入画廊
  function watch() {
    ensureStyles();
    if (document.getElementById('imgBody')) ensureUI();
    try { var mo = new MutationObserver(function () { if (document.getElementById('imgBody')) ensureUI(); }); mo.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
  }

  window.__gallery = {
    favorite: favorite,
    remove: remove,
    pull: pull,
    items: function () { return visible(); },
    open: function () {
      var b = document.getElementById('galToggleBtn');
      if (b) { b.click(); return; }
      if (window.__image && window.__image.open) { window.__image.open(); setTimeout(function () { var b2 = document.getElementById('galToggleBtn'); if (b2) b2.click(); }, 300); }
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { watch(); pull(); });
  else { watch(); pull(); }
})();