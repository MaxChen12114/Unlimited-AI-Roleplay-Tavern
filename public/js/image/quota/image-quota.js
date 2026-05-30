/**
 * image-quota.js · 图像生成每日计数器（单设备 · 本地估算）
 *
 * Gitee 免费图像额度每天约 100 次。本模块在 fetch 层拦截本站图像代理的
 * 生成端点（/img/v1/images/generations 同步生图 + /img/v1/async/images/edits 改图），
 * 成功时按「图片张数」累加今日用量，存 localStorage，并在 ⚙️ Settings 注入一张计数卡。
 *
 * 单一拦截点 → 自动覆盖 工坊 / 微信发图 / 快速生图 所有调用，无需改各模块。
 * 局限：仅统计【本设备】经【本站代理】的调用；独立 /image/ 页、直接打 ai.gitee.com、
 * 其他设备，均不计入。数字为估算，可手动校正。不做硬拦截（真实额度由上游 API 兜底），
 * 仅用于「心里有数」。
 *
 * window.__imageQuota = { add, getToday, getLimit, setLimit, getRemaining, reset, onChange }
 */
(function () {
  'use strict';
  if (window.__imageQuota) return;

  var LS_DATA = 'cfw_image_quota_v1';
  var LS_LIMIT = 'cfw_image_quota_limit_v1';
  var DEFAULT_LIMIT = 100;
  var KEEP_DAYS = 30;
  var listeners = [];

  function pad(n) { return String(n).padStart(2, '0'); }
  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function readMap() {
    try { return JSON.parse(localStorage.getItem(LS_DATA) || '{}') || {}; } catch (e) { return {}; }
  }
  function writeMap(m) {
    try { localStorage.setItem(LS_DATA, JSON.stringify(m)); } catch (e) {}
  }
  function getLimit() {
    var v = parseInt(localStorage.getItem(LS_LIMIT) || '', 10);
    return (isFinite(v) && v > 0) ? v : DEFAULT_LIMIT;
  }
  function setLimit(n) {
    var v = parseInt(String(n), 10);
    if (isFinite(v) && v > 0) { try { localStorage.setItem(LS_LIMIT, String(v)); } catch (e) {} }
    emit();
  }
  function getToday() {
    var m = readMap();
    return parseInt(m[todayKey()] || 0, 10) || 0;
  }
  function getRemaining() { return Math.max(0, getLimit() - getToday()); }
  function add(n) {
    var inc = parseInt(String(n), 10);
    if (!isFinite(inc) || inc === 0) inc = 1;
    var m = readMap(), k = todayKey();
    m[k] = Math.max(0, (parseInt(m[k] || 0, 10) || 0) + inc);
    var keys = Object.keys(m).sort();
    while (keys.length > KEEP_DAYS) { delete m[keys.shift()]; }
    writeMap(m);
    emit();
    return m[k];
  }
  function reset() {
    var m = readMap(); m[todayKey()] = 0; writeMap(m); emit();
  }
  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }
  function snapshot() {
    return { used: getToday(), limit: getLimit(), remaining: getRemaining(), date: todayKey() };
  }
  function emit() {
    var s = snapshot();
    listeners.forEach(function (fn) { try { fn(s); } catch (e) {} });
    try { window.dispatchEvent(new CustomEvent('imagequota:changed', { detail: s })); } catch (e) {}
    renderCard();
  }

  // fetch 拦截：仅统计两个生成端点，其余透传
  var _fetch = window.fetch ? window.fetch.bind(window) : null;
  if (_fetch) {
    window.fetch = function (input, init) {
      var url = '';
      try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch (e) {}
      var isGen = url.indexOf('/img/v1/images/generations') >= 0;
      var isEdit = url.indexOf('/img/v1/async/images/edits') >= 0;
      var p = _fetch(input, init);
      if (isGen || isEdit) {
        p.then(function (res) {
          try {
            if (!res || !res.ok) return;
            if (isGen) {
              var n = 1;
              try {
                var body = init && init.body;
                if (typeof body === 'string') {
                  var j = JSON.parse(body);
                  if (j && j.n) n = parseInt(j.n, 10) || 1;
                }
              } catch (e) {}
              add(n);
            } else {
              add(1);
            }
          } catch (e) {}
        }).catch(function () {});
      }
      return p;
    };
  }

  window.__imageQuota = {
    add: add, getToday: getToday, getLimit: getLimit, setLimit: setLimit,
    getRemaining: getRemaining, reset: reset, onChange: onChange
  };

  function byId(id) { return document.getElementById(id); }

  function renderCard() {
    var disp = byId('imgQuotaDisplay');
    if (!disp) return;
    var s = snapshot();
    var ratio = s.limit ? s.used / s.limit : 0;
    var color = ratio >= 1 ? '#ff5470' : (ratio >= 0.8 ? '#f80' : '#25c2a0');
    disp.innerHTML =
      '<span style="font-size:22px;font-weight:700;color:' + color + ';">' + s.used + '</span>' +
      '<span style="opacity:.6;"> / ' + s.limit + ' 次</span>' +
      '<span style="margin-left:10px;font-size:12px;opacity:.7;">剩余 ' + s.remaining + '</span>';
    var bar = byId('imgQuotaBar');
    if (bar) { bar.style.width = Math.min(100, Math.round(ratio * 100)) + '%'; bar.style.background = color; }
    var lim = byId('imgQuotaLimit');
    if (lim && document.activeElement !== lim) lim.value = s.limit;
  }

  function injectCard() {
    var settings = byId('settings');
    if (!settings || byId('imgQuotaCard')) return;
    var card = document.createElement('div');
    card.className = 'card';
    card.id = 'imgQuotaCard';
    card.innerHTML = [
      '<h4>🧮 图像额度计数（每日）</h4>',
      '<p>Gitee 免费图像额度每天约 <b>100 次</b>。本站发图（工坊 / 微信发图 / 快速生图）成功时按图片张数累加，<b>仅本设备本地统计</b>（不进云同步），每天按日期自动切换。独立 <code>/image/</code> 页、直接调用 API、其他设备均不计入，数字为估算，可手动校正。</p>',
      '<div id="imgQuotaDisplay" style="margin:6px 0 8px;"></div>',
      '<div style="height:6px;border-radius:4px;background:rgba(127,127,127,.2);overflow:hidden;margin-bottom:12px;"><div id="imgQuotaBar" style="height:100%;width:0;transition:width .25s;"></div></div>',
      '<div class="rowline" style="align-items:center;gap:10px;">',
        '<label style="font-size:12px;color:#999;">每日额度</label>',
        '<input type="number" id="imgQuotaLimit" min="1" max="9999" style="width:90px;padding:5px 8px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;">',
        '<div class="btns"><button class="smallbtn" id="imgQuotaMinus">-1</button><button class="smallbtn" id="imgQuotaPlus">+1</button><button class="smallbtn danger" id="imgQuotaReset">今日归零</button></div>',
      '</div>'
    ].join('');
    settings.appendChild(card);

    var lim = byId('imgQuotaLimit');
    if (lim) lim.addEventListener('change', function () { setLimit(lim.value); });
    var plus = byId('imgQuotaPlus'); if (plus) plus.addEventListener('click', function () { add(1); });
    var minus = byId('imgQuotaMinus'); if (minus) minus.addEventListener('click', function () { add(-1); });
    var rst = byId('imgQuotaReset'); if (rst) rst.addEventListener('click', function () { reset(); });
    renderCard();
  }

  function init() {
    injectCard();
    var sb = byId('settingsBtn');
    if (sb) sb.addEventListener('click', function () { setTimeout(renderCard, 50); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();