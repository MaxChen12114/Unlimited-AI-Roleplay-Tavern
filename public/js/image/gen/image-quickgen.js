// image-quickgen.js —— 一键生角色图 / 一键生场景图 / 一键改图
// 设计要点:
// 1. prompt 来源 = 文本侧 /api/chat「免费模式(NVIDIA NIM)」, use_builtin_persona:false + 自定义 system,
//    => 零额外费用调文本模型把中文角色卡/场景压成干净英文出图 prompt;失败回退本地模板。
// 2. 出图走站点自有代理 /img/v1/*(image-routes.js),key 读 cfw_image_key_v1。
// 3. 结果「都要」:填进右栏 形象/场景 面板 + 移动端 tab 面板 + 可一键在大图工坊查看。
// 4. 一键改图:文本模型把口语指令翻成英文编辑指令,作用于当前 形象/场景 图(经 /img/dl 取源图字节)。
(function () {
  if (window.__imageQuick) return;

  // ───── 基础工具 ─────
  function getKey() {
    try { return localStorage.getItem('cfw_image_key_v1') || localStorage.getItem('moark_api_key') || ''; }
    catch (e) { return ''; }
  }
  function authHeaders(extra) {
    var k = getKey();
    var h = extra || {};
    if (k) h['Authorization'] = 'Bearer ' + k;
    return h;
  }
  function dlFetch(u) { return fetch('/img/dl?url=' + encodeURIComponent(u)); }
  function activeCard() {
    try { return (window.__character && window.__character.getActiveCard) ? window.__character.getActiveCard() : null; }
    catch (e) { return null; }
  }

  // ───── 上下文收集 ─────
  function cardToText(c) {
    if (!c) return '一个角色';
    var p = [];
    if (c.name) p.push('姓名:' + c.name);
    if (c.gender) p.push('性别:' + (c.gender === 'male' ? '男' : c.gender === 'female' ? '女' : c.gender));
    if (c.identity) p.push('身份:' + c.identity);
    if (c.personality) p.push('性格:' + c.personality);
    if (c.speakingStyle) p.push('说话风格:' + c.speakingStyle);
    if (c.openingLine) p.push('开场白:' + c.openingLine);
    return p.join('\n');
  }
  function gatherScene() {
    var rows = document.querySelectorAll('#chat .row');
    var arr = [];
    rows.forEach(function (r) {
      var b = r.querySelector('.bubble');
      if (!b || b.classList.contains('wechat-typing')) return;
      var who = r.classList.contains('user') ? '用户' : (r.querySelector('.meta') ? r.querySelector('.meta').textContent : '角色');
      var tx = (b.textContent || '').trim();
      if (tx) arr.push(who + ':' + tx);
    });
    var txt = arr.slice(-8).join('\n');
    var sum = '';
    try { sum = localStorage.getItem('cfw_prior_summary_v1') || ''; } catch (e) {}
    if (sum) txt = '[剧情摘要]' + sum + '\n' + txt;
    txt = txt.slice(-2000);
    return txt || '一个安静的室内场景';
  }

  // ───── 文本模型提示词构建(免费模式,零费用)─────
  // 免费/快速 双模式: 免费=gpt-oss(连接最稳), 断联可切快速 DeepSeek(稳但计费)
  var LS_MODE = 'cfw_quick_llm_mode_v1';
  function llmMode() { try { return localStorage.getItem(LS_MODE) || 'free'; } catch (e) { return 'free'; } }
  function setLlmMode(m) { try { localStorage.setItem(LS_MODE, m); } catch (e) {} updateModeUI(); }
  function pickFreeModel() {
    var list = window.APP_MODELS_FREE || [];
    for (var i = 0; i < list.length; i++) { if ((list[i].id || '').indexOf('gpt-oss') >= 0) return list[i].id; }
    return 'openai/gpt-oss-120b';
  }
  function pickFastModel() { return window.APP_DEFAULT_MODEL_FAST || window.DEFAULT_MODEL || 'deepseek-ai/deepseek-v4-pro'; }
  function updateModeUI() {
    var m = llmMode();
    document.querySelectorAll('[data-qg-mode]').forEach(function (b) {
      var on = b.getAttribute('data-qg-mode') === m;
      b.style.fontWeight = on ? '700' : '400';
      b.style.opacity = on ? '1' : '.5';
    });
  }
  var SYS = {
    character: 'You are an expert image-prompt engineer for an anime/illustration text-to-image model. Given a Chinese roleplay character profile, output ONE single-line English prompt of the character appearance: booru-style comma-separated tags (hair, eyes, clothing, body, expression, pose) plus a short setting, prefixed with "masterpiece, best quality". Output ONLY the prompt, no quotes, no explanation.',
    scene: 'You are an expert image-prompt engineer. Given recent Chinese roleplay context, output ONE single-line English prompt depicting the current SCENE/environment (location, lighting, time of day, atmosphere, key objects), booru-style comma-separated tags prefixed with "masterpiece, best quality, scenery". Do not focus on character faces. Output ONLY the prompt.',
    edit: 'You translate a casual Chinese edit request for an existing image into ONE concise explicit English editing instruction for an instruction-based image-edit model. Describe exactly what to change and keep everything else intact. Output ONLY the instruction.'
  };
  async function llmBuildPrompt(userText, kind) {
    var mode = llmMode();
    var model = mode === 'fast' ? pickFastModel() : pickFreeModel();
    var res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: mode,
        model: model,
        use_builtin_persona: false,
        custom_system_prompt: SYS[kind],
        replyStyle: 'default',
        messages: [{ role: 'user', content: userText }]
      })
    });
    if (!res.ok) throw new Error('llm ' + res.status);
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var out = '';
    while (true) {
      var step = await reader.read();
      if (step.done) break;
      var chunk = dec.decode(step.value, { stream: true });
      var lines = chunk.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf('data: ') !== 0) continue;
        var s = line.slice(6).trim();
        if (!s || s === '[DONE]') continue;
        try {
          var p = JSON.parse(s);
          var d = p.choices && p.choices[0] && p.choices[0].delta && p.choices[0].delta.content;
          if (d) out += d;
        } catch (e) {}
      }
    }
    out = out.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
    if (!out) throw new Error('empty');
    return out;
  }

  // ───── 本地模板兜底 ─────
  function tplCharacter(c) {
    var t = ['masterpiece', 'best quality'];
    if (c && c.gender === 'female') t.push('1girl');
    else if (c && c.gender === 'male') t.push('1boy');
    else t.push('1person');
    if (c && c.identity) t.push(c.identity);
    if (c && c.personality) t.push(c.personality);
    t.push('portrait', 'detailed face', 'best lighting');
    return t.filter(Boolean).join(', ');
  }
  function tplScene(sceneText) {
    return ('masterpiece, best quality, scenery, no humans, ' + (sceneText || 'indoor room').slice(0, 180)).trim();
  }
  async function resolvePrompt(kind, userText, fallback) {
    try { return await llmBuildPrompt(userText, kind); }
    catch (e) { return fallback; }
  }

  // ───── 出图 API ─────
  // 全局画风:读 image-portrait 的 cfw_image_style_v1 追加到提示词末尾
  function styleSuffix() { try { var t = window.__portrait && window.__portrait.getStyleTags && window.__portrait.getStyleTags(); return (t || '').trim(); } catch (e) { return ''; } }
  function withStyle(p) { var st = styleSuffix(); return st ? ((p || '') + ', ' + st) : (p || ''); }
  async function genZImage(prompt, n) {
    var r = await fetch('/img/v1/images/generations', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prompt: withStyle(prompt), model: 'z-image-turbo', n: n || 1, size: '1024x1024' })
    });
    if (!r.ok) throw new Error('生图失败 ' + r.status + ' ' + (await r.text().catch(function () { return ''; })));
    var j = await r.json();
    var arr = (j.data || []).map(function (d) { return d.url || (d.b64_json ? 'data:image/png;base64,' + d.b64_json : ''); }).filter(Boolean);
    if (!arr.length) throw new Error('无返回图片');
    return arr;
  }
  async function genEdit(prompt, srcUrl, onTick) {
    var blob = await (await dlFetch(srcUrl)).blob();
    var fd = new FormData();
    fd.append('prompt', withStyle(prompt));
    fd.append('model', 'Qwen-Image-Edit-2511');
    fd.append('num_inference_steps', '4');
    fd.append('guidance_scale', '1.0');
    fd.append('image', blob, 'src.png');
    var r = await fetch('/img/v1/async/images/edits', { method: 'POST', headers: authHeaders({}), body: fd });
    if (!r.ok) throw new Error('改图提交失败 ' + r.status + ' ' + (await r.text().catch(function () { return ''; })));
    var j = await r.json();
    var taskId = j.id || j.task_id || (j.data && (j.data.id || j.data.task_id));
    if (!taskId) throw new Error('未取到任务 id');
    var start = Date.now();
    var TIMEOUT = 30 * 60 * 1000;
    while (true) {
      if (Date.now() - start > TIMEOUT) throw new Error('改图超时');
      await new Promise(function (rs) { setTimeout(rs, 6000); });
      var pr = await fetch('/img/v1/task/' + encodeURIComponent(taskId), { headers: authHeaders({}) });
      if (!pr.ok) throw new Error('轮询失败 ' + pr.status);
      var pj = await pr.json();
      var status = pj.status || pj.state || (pj.output ? 'success' : '');
      if (onTick) onTick(status || '处理中');
      var fileUrl = (pj.output && pj.output.file_url) ||
        (pj.raw && pj.raw.output && pj.raw.output.file_url) ||
        (pj.data && pj.data[0] && pj.data[0].url);
      if (fileUrl) return fileUrl;
      if (status && /fail|error|cancel/i.test(status)) throw new Error('任务失败:' + status);
    }
  }

  // ───── 结果落地:面板 + 工坊 ─────
  var LS_IMG = { character: 'cfw_image_char_v1', scene: 'cfw_image_scene_v1' };
  function lastImage(kind) { try { return localStorage.getItem(LS_IMG[kind]) || ''; } catch (e) { return ''; } }
  function setLastImage(kind, url) { try { localStorage.setItem(LS_IMG[kind], url); } catch (e) {} }

  function panelInner(kind, label) {
    var holderId = kind === 'character' ? 'qgCharImg' : 'qgSceneImg';
    return '<div style="display:flex;flex-direction:column;gap:8px;">' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
      '<button data-qg="gen-' + kind + '" class="qg-btn">' + (kind === 'character' ? '🎭 一键生角色图' : '🌆 一键生场景图') + '</button>' +
      '<button data-qg="fav-' + kind + '" class="qg-btn">⭐ 收藏</button>' +
      '<button data-qg="edit-' + kind + '" class="qg-btn">🪄 改这张</button>' +
      '</div>' +
      '<div id="' + holderId + '" class="qg-holder"><span class="qg-hint">尚未生成' + label + '</span></div>' +
      '<div data-qg="status-' + kind + '" class="qg-status"></div>' +
      '</div>';
  }
  function ensureStyles() {
    if (document.getElementById('qgStyles')) return;
    var s = document.createElement('style');
    s.id = 'qgStyles';
    s.textContent = [
      '.qg-btn{font-size:12px;padding:5px 9px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;cursor:pointer;opacity:.85;}',
      '.qg-btn:hover{opacity:1;background:rgba(127,127,127,.12);}',
      '.qg-holder{min-height:60px;border:1px dashed rgba(127,127,127,.4);border-radius:8px;display:flex;align-items:center;justify-content:center;padding:6px;}',
      '.qg-holder img{max-width:100%;border-radius:6px;cursor:zoom-in;}',
      '.qg-hint{font-size:11px;opacity:.55;}',
      '.qg-status{font-size:11px;opacity:.7;min-height:14px;}'
    ].join('\n');
    document.head.appendChild(s);
  }
  function statusEl(kind) { return document.querySelector('[data-qg="status-' + kind + '"]'); }
  function setStatus(kind, txt) {
    document.querySelectorAll('[data-qg="status-' + kind + '"]').forEach(function (e) { e.textContent = txt || ''; });
  }
  function placeIntoPanel(kind, url) {
    setLastImage(kind, url);
    var holderId = kind === 'character' ? 'qgCharImg' : 'qgSceneImg';
    document.querySelectorAll('#' + holderId).forEach(function (h) {
      h.innerHTML = '';
      var im = document.createElement('img');
      im.src = url;
      im.title = '点击在大图工坊查看';
      im.onclick = function () { openInStudio(url); };
      h.appendChild(im);
    });
    // 同时塞进工坊输出区(若工坊已构建)
    var out = document.getElementById('imgOutput');
    if (out) {
      var im2 = document.createElement('img');
      im2.src = url;
      im2.style.maxWidth = '100%';
      out.innerHTML = '';
      out.appendChild(im2);
    }
  }
  function openInStudio(url) {
    try {
      if (window.__image && window.__image.open) window.__image.open();
      var out = document.getElementById('imgOutput');
      if (out) {
        var im = document.createElement('img');
        im.src = url; im.style.maxWidth = '100%';
        out.innerHTML = ''; out.appendChild(im);
      }
    } catch (e) {}
  }

  // ───── 三个一键流程 ─────
  async function quickGenerate(kind) {
    var card = activeCard();
    if (kind === 'character' && !card) { alert('请先在「角色卡」里选择一个角色'); return; }
    setStatus(kind, '⏳ 正在构建提示词…');
    var userText = kind === 'character' ? cardToText(card) : gatherScene();
    var fallback = kind === 'character' ? tplCharacter(card) : tplScene(gatherScene());
    var prompt = await resolvePrompt(kind, userText, fallback);
    lastPrompt[kind] = prompt;
    setStatus(kind, '🎨 正在出图… (' + prompt.slice(0, 40) + '…)');
    try {
      var urls = await genZImage(prompt, 1);
      placeIntoPanel(kind, urls[0]);
      setStatus(kind, '✅ 完成');
    } catch (e) {
      setStatus(kind, '❌ ' + e.message);
    }
  }
  async function quickEdit(kind) {
    var src = lastImage(kind);
    if (!src) { alert('请先生成' + (kind === 'character' ? '角色图' : '场景图') + '再改'); return; }
    var instr = prompt('想怎么改?(用大白话说,例如:换成和服 / 改成夜晚 / 加点雪)');
    if (!instr || !instr.trim()) return;
    setStatus(kind, '⏳ 正在理解指令…');
    var editPrompt = await resolvePrompt('edit', instr.trim(), instr.trim());
    lastPrompt[kind] = editPrompt;
    setStatus(kind, '🪄 正在改图…');
    try {
      var url = await genEdit(editPrompt, src, function (st) { setStatus(kind, '🪄 改图中… ' + st); });
      placeIntoPanel(kind, url);
      setStatus(kind, '✅ 改图完成');
    } catch (e) {
      setStatus(kind, '❌ ' + e.message);
    }
  }

  // ───── UI 注入(桌面右栏 + 移动端 tab)─────
  function modeBar() {
    return '<div style="display:flex;align-items:center;gap:6px;font-size:11px;margin-bottom:8px;flex-wrap:wrap;">' +
      '<span style="opacity:.6;">提示词引擎</span>' +
      '<button data-qg-mode="free" class="qg-btn">免费 gpt-oss(稳)</button>' +
      '<button data-qg-mode="fast" class="qg-btn">快速 DeepSeek(计费)</button>' +
      '</div>';
  }
  function bindMode(root) {
    root.querySelectorAll('[data-qg-mode]').forEach(function (b) {
      if (b.__qgMb) return;
      b.__qgMb = true;
      b.addEventListener('click', function () { setLlmMode(b.getAttribute('data-qg-mode')); });
    });
  }
  var lastPrompt = {};
  function favCurrent(kind) {
    var src = lastImage(kind);
    if (!src) { alert('请先生成' + (kind === 'character' ? '角色图' : '场景图')); return; }
    if (window.__gallery && window.__gallery.favorite) window.__gallery.favorite(src, { kind: kind, prompt: lastPrompt[kind] || '' });
    else alert('画廊模块未加载');
  }
  function bindButtons(root) {
    root.querySelectorAll('[data-qg]').forEach(function (btn) {
      var act = btn.getAttribute('data-qg');
      if (!/^(gen|edit|fav)-/.test(act) || btn.__qgBound) return;
      btn.__qgBound = true;
      btn.addEventListener('click', function () {
        var parts = act.split('-');
        if (parts[0] === 'gen') quickGenerate(parts[1]);
        else if (parts[0] === 'edit') quickEdit(parts[1]);
        else favCurrent(parts[1]);
      });
    });
  }
  function injectDesktop() {
    var ph = document.querySelector('#rightSidebar .sidebar-slot-placeholder');
    if (!ph || ph.__qgDone) return;
    ph.__qgDone = true;
    ph.innerHTML = modeBar() + '<div style="font-size:12px;font-weight:600;opacity:.8;margin-bottom:8px;">🎭 角色形象</div>' +
      panelInner('character', '角色图') +
      '<div style="height:14px;"></div>' +
      '<div style="font-size:12px;font-weight:600;opacity:.8;margin-bottom:8px;">🌆 场景图</div>' +
      panelInner('scene', '场景图');
    bindButtons(ph);
    bindMode(ph);
    updateModeUI();
  }
  function injectMobile() {
    // 摘掉 disabled 让既有 tab 切换脚本生效
    document.querySelectorAll('#mobileBottomTabs .mobile-tab-btn[data-tab="avatar"], #mobileBottomTabs .mobile-tab-btn[data-tab="scene"]').forEach(function (b) {
      b.disabled = false;
      b.removeAttribute('disabled');
    });
    var a = document.getElementById('mobileTabPanel-avatar');
    if (a && !a.__qgDone) { a.__qgDone = true; a.innerHTML = modeBar() + panelInner('character', '角色图'); bindButtons(a); bindMode(a); }
    var s = document.getElementById('mobileTabPanel-scene');
    if (s && !s.__qgDone) { s.__qgDone = true; s.innerHTML = modeBar() + panelInner('scene', '场景图'); bindButtons(s); bindMode(s); }
  }
  function restoreLast() {
    ['character', 'scene'].forEach(function (k) {
      var u = lastImage(k);
      if (u) placeIntoPanel(k, u);
    });
  }

  function init() {
    ensureStyles();
    injectDesktop();
    injectMobile();
    restoreLast();
    updateModeUI();
  }

  window.__imageQuick = {
    generateCharacter: function () { return quickGenerate('character'); },
    generateScene: function () { return quickGenerate('scene'); },
    editCharacter: function () { return quickEdit('character'); },
    editScene: function () { return quickEdit('scene'); },
    buildPrompt: llmBuildPrompt,
    setMode: setLlmMode,
    getMode: llmMode
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();