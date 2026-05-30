/**
 * image-portrait.js · 角色立绘 → 微信发图基准图 桥接
 *
 * 读 window.__character.getActiveCard() 拼提示词 → z-image 出半身立绘
 * （优先走 window.__image.generate，否则回退直接 fetch /img/v1/images/generations）
 * → 一键 window.__chatImage.setBaseImage 锁为该角色基准图，发图不再需手动上传。
 * 顺带托管「全局画风」(LS cfw_image_style_v1)，立绘提示词自动追加；以后工坊/发图也可读同一设置。
 * 自注入 Settings 卡，不改主线 HTML。SFW 立绘（头像/半身），不做露骨内容。
 *
 * window.__portrait = { generateForActive, setAsBase, buildPrompt, getStyle, setStyle, getLastImage }
 */
(function () {
  'use strict';
  if (window.__portrait) return;
  // 4.38-ui: 配色去硬编码,muted 文本改用 currentColor+opacity,随四主题(minimal/glass/lewd-peach/lewd-doll)自适应,不再用 #999/#888/#c0392b。

  var LS_STYLE = 'cfw_image_style_v1';
  var STYLES = {
    none:  { label: '默认 · 不指定', tags: '' },
    real:  { label: '写实', tags: 'photorealistic, realistic, natural soft lighting, detailed skin, 85mm portrait' },
    anime: { label: '动漫', tags: 'anime style, cel shading, clean lineart, vibrant colors' },
    soft:  { label: '日系插画', tags: 'soft illustration, pastel tones, delicate shading' },
    water: { label: '水彩', tags: 'watercolor painting, soft edges, artistic, textured paper' },
    cyber: { label: '赛博朋克', tags: 'cyberpunk, neon rim light, futuristic, moody atmosphere' }
  };
  var lastImage = null;

  function byId(id) { return document.getElementById(id); }
  function getStyle() { try { return localStorage.getItem(LS_STYLE) || 'none'; } catch (e) { return 'none'; } }
  function setStyle(s) {
    try { localStorage.setItem(LS_STYLE, s || 'none'); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('imagestyle:changed', { detail: { style: getStyle() } })); } catch (e) {}
  }
  function styleTags() { var s = STYLES[getStyle()]; return s ? s.tags : ''; }

  function mapWho(card) {
    var s = (((card && card.gender) || '') + ' ' + ((card && card.name) || '')).toLowerCase();
    if (/女|girl|female|woman/.test(s)) return '1girl';
    if (/男|boy|male|man/.test(s)) return '1boy';
    return '1person';
  }
  function buildPrompt(card) {
    var t = ['masterpiece', 'best quality', 'highly detailed', mapWho(card), 'solo', 'upper body portrait', 'looking at viewer', 'detailed face', 'clean simple background', 'soft natural lighting'];
    if (card) {
      if (card.name) t.push('character: ' + card.name);
      if (card.identity) t.push(card.identity);
      if (card.personality) t.push(card.personality + ' vibe');
    }
    var st = styleTags();
    if (st) t.push(st);
    return t.filter(Boolean).join(', ');
  }
  function activeCard() {
    try { return (window.__character && window.__character.getActiveCard) ? window.__character.getActiveCard() : null; } catch (e) { return null; }
  }

  async function rawGenerate(prompt) {
    if (window.__image && typeof window.__image.generate === 'function') {
      var data = await window.__image.generate({ prompt: prompt, n: 1, size: '768x1024' });
      var d = (data && data[0]) || null;
      if (d) return d.url || (d.b64_json ? 'data:image/png;base64,' + d.b64_json : null);
      return null;
    }
    var key = '';
    try { key = localStorage.getItem('cfw_image_key_v1') || localStorage.getItem('moark_api_key') || ''; } catch (e) {}
    if (!key) throw new Error('请先在 ⚙️ 设置 → 图像 API Key 填写 Gitee Key');
    var r = await fetch('/img/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt, model: 'z-image-turbo', n: 1, size: '768x1024' })
    });
    if (!r.ok) throw new Error('生成失败 ' + r.status);
    var j = await r.json();
    var first = (j.data || [])[0] || null;
    if (!first) throw new Error('无返回');
    return first.url || (first.b64_json ? 'data:image/png;base64,' + first.b64_json : null);
  }

  async function generateForActive() {
    var card = activeCard();
    if (!card) throw new Error('请先在「角色卡」里选择一个角色');
    var img = await rawGenerate(buildPrompt(card));
    if (!img) throw new Error('未取到图片');
    lastImage = { url: img, characterId: card.id || 'default', name: card.name || '' };
    return lastImage;
  }
  async function setAsBase(imageUrl, characterId) {
    var card = activeCard();
    var id = characterId || (lastImage && lastImage.characterId) || (card && card.id) || 'default';
    var url = imageUrl || (lastImage && lastImage.url);
    if (!url) throw new Error('还没有可用的立绘');
    if (!(window.__chatImage && window.__chatImage.setBaseImage)) throw new Error('发图模块未就绪(image-chat.js)');
    await window.__chatImage.setBaseImage({ characterId: id, imageUrl: url });
    return id;
  }
  function getLastImage() { return lastImage; }

  window.__portrait = {
    generateForActive: generateForActive, setAsBase: setAsBase, buildPrompt: buildPrompt,
    getStyle: getStyle, setStyle: setStyle, getStyleTags: styleTags, getLastImage: getLastImage
  };

  function injectCard() {
    var settings = byId('settings');
    if (!settings || byId('imgPortraitCard')) return;
    var opts = Object.keys(STYLES).map(function (k) { return '<option value="' + k + '">' + STYLES[k].label + '</option>'; }).join('');
    var card = document.createElement('div');
    card.className = 'card';
    card.id = 'imgPortraitCard';
    card.innerHTML = [
      '<h4>🖼️ 角色立绘 → 发图基准图</h4>',
      '<p>用当前选中<b>角色卡</b>的身份/性格自动拼提示词，z-image 出一张半身立绘，一键设为该角色的<b>微信发图基准图</b>（以后发图都以这张保持同一人，不用再手动上传）。SFW 半身像；消耗 1 次图像额度。<b>仅本设备</b>。</p>',
      '<div id="imgPortraitWho" style="font-size:13px;margin:4px 0;"></div>',
      '<div class="rowline" style="align-items:center;gap:10px;margin-top:8px;">',
        '<label style="font-size:12px;opacity:.6;">画风</label>',
        '<select id="imgPortraitStyle" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;">' + opts + '</select>',
      '</div>',
      '<div class="rowline" style="margin-top:10px;"><div></div><div class="btns">',
        '<button class="smallbtn" id="imgPortraitGen">✨ 生成立绘</button>',
        '<button class="smallbtn" id="imgPortraitSet" disabled>设为基准图</button>',
      '</div></div>',
      '<div id="imgPortraitStatus" style="font-size:11px;opacity:.6;margin-top:8px;"></div>',
      '<div id="imgPortraitPreview" style="margin-top:10px;display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;"></div>'
    ].join('');
    settings.appendChild(card);

    var sel = byId('imgPortraitStyle');
    if (sel) {
      sel.value = getStyle();
      sel.addEventListener('change', function () { setStyle(sel.value); });
      window.addEventListener('imagestyle:changed', function (e) { var v = (e && e.detail && e.detail.style) || getStyle(); if (sel.value !== v) sel.value = v; });
    }
    var genBtn = byId('imgPortraitGen');
    var setBtn = byId('imgPortraitSet');
    var status = byId('imgPortraitStatus');
    var preview = byId('imgPortraitPreview');
    function setMsg(t) { if (status) status.textContent = t || ''; }

    function refreshWho() {
      var who = byId('imgPortraitWho');
      var c = activeCard();
      if (who) who.innerHTML = c
        ? '当前角色：<b>' + ((c.icon ? c.icon + ' ' : '') + (c.name || '(未命名)')) + '</b>'
        : '<span style="color:#e5484d;">未选择角色卡 — 先去左侧「角色卡」选一个</span>';
      try {
        if (window.__chatImage && window.__chatImage.getBaseImage && c) {
          Promise.resolve(window.__chatImage.getBaseImage({ characterId: c.id || 'default' })).then(function (b) {
            if (b && preview && !preview.querySelector('[data-gen]')) {
              preview.innerHTML = '<div style="text-align:center;"><img src="' + b + '" style="max-width:140px;border-radius:8px;display:block;"><div style="font-size:11px;opacity:.6;margin-top:4px;">当前基准图</div></div>';
            }
          }).catch(function () {});
        }
      } catch (e) {}
    }

    if (genBtn) genBtn.addEventListener('click', async function () {
      genBtn.disabled = true; setMsg('生成中…（约 10-30 秒）');
      try {
        var r = await generateForActive();
        if (preview) preview.innerHTML = '<div style="text-align:center;"><img data-gen="1" src="' + r.url + '" style="max-width:160px;border-radius:8px;display:block;"><div style="font-size:11px;opacity:.6;margin-top:4px;">新立绘 · ' + (r.name || '') + '</div></div>';
        if (setBtn) setBtn.disabled = false;
        setMsg('生成完成，点「设为基准图」锁定。');
      } catch (e) { setMsg('错误：' + ((e && e.message) || e)); }
      genBtn.disabled = false;
    });
    if (setBtn) setBtn.addEventListener('click', async function () {
      setBtn.disabled = true; setMsg('保存基准图中…');
      try { await setAsBase(); setMsg('✅ 已设为当前角色的发图基准图。'); }
      catch (e) { setMsg('错误：' + ((e && e.message) || e)); setBtn.disabled = false; }
    });

    refreshWho();
    var sb = byId('settingsBtn'); if (sb) sb.addEventListener('click', function () { setTimeout(refreshWho, 50); });
    window.addEventListener('character:changed', refreshWho);
  }

  // 显眼入口:独立「全局画风」卡,置设置顶部,与立绘卡下拉双向同步(走 imagestyle:changed)
  function injectGlobalStyleCard() {
    var settings = byId('settings');
    if (!settings || byId('imgStyleCard')) return;
    var opts = Object.keys(STYLES).map(function (k) { return '<option value="' + k + '">' + STYLES[k].label + '</option>'; }).join('');
    var card = document.createElement('div');
    card.className = 'card';
    card.id = 'imgStyleCard';
    card.innerHTML = [
      '<h4>🎨 全局画风（全站出图生效）</h4>',
      '<p>统一控制<b>所有自动出图</b>的画风：发图、表情差分、角色头像、一键生角色/场景图、立绘都会套用。工坤手动文生图按你输入的提示词来，不受影响。仅本设备。</p>',
      '<div class="rowline" style="align-items:center;gap:10px;margin-top:6px;">',
        '<label style="font-size:12px;opacity:.6;">画风</label>',
        '<select id="imgStyleSelect" style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;">' + opts + '</select>',
      '</div>'
    ].join('');
    settings.insertBefore(card, settings.firstChild);
    var sel = byId('imgStyleSelect');
    if (sel) {
      sel.value = getStyle();
      sel.addEventListener('change', function () { setStyle(sel.value); });
      window.addEventListener('imagestyle:changed', function (e) { var v = (e && e.detail && e.detail.style) || getStyle(); if (sel.value !== v) sel.value = v; });
    }
  }
  function init() { injectGlobalStyleCard(); injectCard(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();