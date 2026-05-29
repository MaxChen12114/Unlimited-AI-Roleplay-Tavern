/**
 * image-embed.js · 无限制AI 图像侧嵌入（Phase 2 · Wave 1：工坊）
 *
 * 自挂载模块：复用左栏「图像(生/改)」按钮 → 打开 Modal 工坊。
 * 仿 unlimited-editor.js 壳：自注入 DOM + 自注入主题无关 CSS（currentColor）
 * + window.__image API + ESC/遮罩/✕ 关闭。
 *
 * 两个模式：
 *   - 文生图  z-image-turbo        → /img/v1/images/generations（同步）
 *   - 改图    Qwen-Image-Edit-2511 → /img/v1/async/images/edits（异步轮询 task/{id}）
 *
 * 网络：全部走 image-routes.js 暴露的 /img/v1/*（代理 ai.gitee.com/v1）+ /img/dl?url=（下载）。
 * Key：站点 ⚙️ Settings 内运行时注入一张卡，LS key cfw_image_key_v1（迁移旧 moark_api_key）。
 * 主线 footprint：仅需一行 <script src=\"/image-embed.js\">；按钮启用由本模块运行时完成。
 *
 * 公开 API：window.__image = { open, close, switchMode, generate, abort }
 * 画廊 R2+跨设备同步、插入聊天 = Wave 2/后期，另行扩展。
 */
(function () {
  'use strict';
  if (window.__image) return;

  var MASK_ID = 'imageStudioMask';
  var KEY_LS = 'cfw_image_key_v1';
  var OLD_KEY_LS = 'moark_api_key';

  // 迁移旧 key（原独立工具用 moark_api_key）
  try {
    if (!localStorage.getItem(KEY_LS)) {
      var legacy = localStorage.getItem(OLD_KEY_LS);
      if (legacy) localStorage.setItem(KEY_LS, legacy);
    }
  } catch (e) {}

  var Z_RESOLUTIONS = {
    '1:1 (2048x2048)': [2048, 2048],
    '1:1 (1024x1024)': [1024, 1024],
    '3:4 (768x1024)': [768, 1024],
    '4:3 (1024x768)': [1024, 768],
    '16:9 (1024x576)': [1024, 576],
    '9:16 (576x1024)': [576, 1024]
  };
  var EDIT_TASK_TYPES = ['id', 'style', 'pose', 'layout', 'color', 'background'];
  var EDIT_DEFAULT_TYPES = { id: 1, style: 1 };

  var currentMode = 'z'; // 'z' | 'edit'
  var mask = null;
  var pollAbort = { aborted: false };

  function byId(id) { return document.getElementById(id); }
  function getKey() {
    var k = '';
    try { k = (localStorage.getItem(KEY_LS) || '').trim(); } catch (e) {}
    if (!k) throw new Error('请先在 ⚙️ 设置 → 图像 API Key 里填写 Gitee Key');
    return k;
  }
  function nowTs() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function clampInt(v, lo, hi, dv) {
    var n = parseInt(String(v), 10);
    return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dv;
  }
  function clampFloat(v, lo, hi, dv) {
    var n = parseFloat(String(v));
    return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dv;
  }

  // ── 网络：走 image-routes 的 /img/v1/* + /img/dl ──
  function apiFetch(path, opts) {
    opts = opts || {};
    return fetch('/img/v1/' + String(path).replace(/^\/+/, ''), {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body || null,
      signal: opts.signal || null
    });
  }
  function dlFetch(url, opts) {
    opts = opts || {};
    return fetch('/img/dl?url=' + encodeURIComponent(url), { method: 'GET', signal: opts.signal || null });
  }
  async function readJsonSafely(res) {
    var t = await res.text();
    try { return JSON.parse(t); } catch (e) { return { _text: t }; }
  }
  async function fetchAsBlob(url) {
    var r = await dlFetch(url);
    if (!r.ok) {
      var j = await readJsonSafely(r);
      throw new Error('下载失败 (' + r.status + '): ' + JSON.stringify(j).slice(0, 200));
    }
    var blob = await r.blob();
    return { blob: blob, objUrl: URL.createObjectURL(blob) };
  }

  // ── 轮询 task/{id} ──
  async function pollTask(taskId, key, o) {
    o = o || {};
    var timeoutMs = o.timeoutMs || 30 * 60 * 1000;
    var intervalMs = o.intervalMs || 6000;
    var start = Date.now(), tick = 0;
    pollAbort.aborted = false;
    while (Date.now() - start < timeoutMs) {
      if (pollAbort.aborted) return { status: 'cancelled', raw: { status: 'cancelled', message: '用户取消' } };
      tick++;
      if (o.onTick) o.onTick({ tick: tick, elapsedMs: Date.now() - start });
      var res = await apiFetch('task/' + encodeURIComponent(taskId), {
        method: 'GET', headers: { 'Authorization': 'Bearer ' + key }
      });
      var j = await readJsonSafely(res);
      var st = j.status || 'unknown';
      if (st === 'success' || st === 'failed' || st === 'cancelled') return { status: st, raw: j };
      await new Promise(function (r) { setTimeout(r, intervalMs); });
    }
    return { status: 'timeout', raw: { status: 'timeout' } };
  }

  // ── 状态条 ──
  function setStatus(text, kind) {
    var el = byId('imgStatusBadge');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'img-badge' + (kind ? ' img-badge-' + kind : '');
  }

  // ── 输出区 ──
  function addOutput(opts) {
    var out = byId('imgOutput');
    if (!out) return;
    var box = document.createElement('div');
    box.className = 'img-item';
    var h = document.createElement('h4');
    h.textContent = opts.title || '';
    box.appendChild(h);
    if (opts.meta) {
      var m = document.createElement('div');
      m.className = 'img-item-meta';
      m.textContent = opts.meta;
      box.appendChild(m);
    }
    if (opts.element) box.appendChild(opts.element);
    if (opts.download) {
      var row = document.createElement('div');
      row.className = 'img-item-row';
      var a = document.createElement('a');
      a.className = 'img-btn';
      a.textContent = '下载';
      a.href = opts.download.href;
      a.download = opts.download.filename || '';
      a.target = '_blank'; a.rel = 'noopener';
      row.appendChild(a);
      box.appendChild(row);
    }
    out.prepend(box);
    return box;
  }
  function clearOutput() { var o = byId('imgOutput'); if (o) o.innerHTML = ''; }

  // ── 文生图 z-image-turbo（同步）──
  async function runZImage() {
    var key = getKey();
    var prompt = (byId('imgZPrompt').value || '').trim();
    if (!prompt) throw new Error('请输入提示词');
    var n = clampInt(byId('imgZN').value, 1, 4, 1);
    var res = Z_RESOLUTIONS[byId('imgZRes').value] || [1024, 1024];
    var size = res[0] + 'x' + res[1];
    setStatus('文生图 生成中…');
    var r = await apiFetch('images/generations', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt, model: 'z-image-turbo', n: n, size: size })
    });
    var j = await readJsonSafely(r);
    if (!r.ok) { setStatus('文生图 失败', 'err'); addOutput({ title: '文生图失败 HTTP ' + r.status, meta: JSON.stringify(j).slice(0, 200) }); return; }
    var data = Array.isArray(j.data) ? j.data : [];
    if (!data.length) { setStatus('文生图 无数据', 'err'); addOutput({ title: '返回无数据', meta: JSON.stringify(j).slice(0, 200) }); return; }
    for (var i = 0; i < data.length; i++) {
      var item = data[i] || {}, bi = null;
      if (item.url) bi = await fetchAsBlob(item.url);
      else if (item.b64_json) {
        var bc = atob(item.b64_json), bytes = new Uint8Array(bc.length);
        for (var k = 0; k < bc.length; k++) bytes[k] = bc.charCodeAt(k);
        var blob = new Blob([bytes], { type: 'image/png' });
        bi = { blob: blob, objUrl: URL.createObjectURL(blob) };
      } else { addOutput({ title: '第 ' + (i + 1) + ' 张无数据' }); continue; }
      var img = document.createElement('img');
      img.src = bi.objUrl; img.className = 'img-out-img';
      addOutput({ title: '文生图 #' + (i + 1), meta: 'size=' + size + ' · n=' + n, element: img, download: { href: bi.objUrl, filename: 'z-image-' + nowTs() + '-' + (i + 1) + '.png' } });
    }
    setStatus('文生图 成功', 'ok');
  }

  // ── 改图 Qwen-Image-Edit-2511（异步；支持 1 或 2 张源图）──
  async function runEdit() {
    var key = getKey();
    var f1 = (byId('imgEditImg1').files || [])[0];
    var f2 = (byId('imgEditImg2').files || [])[0];
    var prompt = (byId('imgEditPrompt').value || '').trim();
    if (!f1 || !prompt) throw new Error('请至少上传 1 张图片并输入提示词');
    var types = Array.prototype.slice.call(document.querySelectorAll('input[name=\"imgEditType\"]:checked')).map(function (x) { return x.value; });
    if (!types.length) throw new Error('至少选择一个 task_type');
    var steps = clampInt(byId('imgEditSteps').value, 1, 50, 4);
    var guidance = clampFloat(byId('imgEditGuidance').value, 0, 10, 1.0);
    var fd = new FormData();
    fd.append('prompt', prompt);
    fd.append('model', 'Qwen-Image-Edit-2511');
    fd.append('num_inference_steps', String(steps));
    fd.append('guidance_scale', String(guidance));
    types.forEach(function (t) { fd.append('task_types', t); });
    fd.append('image', f1, f1.name);
    if (f2) fd.append('image', f2, f2.name); // 2 张时追加；1 张时省略，待实测接口是否接受
    setStatus('改图 创建任务…');
    var r = await apiFetch('async/images/edits', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key }, body: fd });
    var j = await readJsonSafely(r);
    if (!r.ok || !j.task_id) { setStatus('改图 创建失败', 'err'); addOutput({ title: '改图创建失败 HTTP ' + r.status, meta: JSON.stringify(j).slice(0, 200) }); return; }
    var taskId = j.task_id;
    setStatus('改图 轮询中… (' + taskId.slice(0, 8) + ')');
    var result = await pollTask(taskId, key, {
      intervalMs: 6000,
      onTick: function (info) { setStatus('改图 轮询中… 已等待 ' + Math.floor(info.elapsedMs / 1000) + 's · 第 ' + info.tick + ' 次检查 · 正常等待并非卡死'); }
    });
    if (result.status !== 'success') { setStatus('改图 ' + result.status, result.status === 'failed' ? 'err' : 'info'); addOutput({ title: '改图任务结束：' + result.status, meta: 'task=' + taskId.slice(0, 8) }); return; }
    var fileUrl = result.raw && result.raw.output && result.raw.output.file_url;
    if (!fileUrl) { setStatus('改图 无 file_url', 'err'); addOutput({ title: '成功但无 file_url' }); return; }
    setStatus('改图 下载中…');
    var bi = await fetchAsBlob(fileUrl);
    var img = document.createElement('img');
    img.src = bi.objUrl; img.className = 'img-out-img';
    addOutput({ title: '改图输出', meta: 'task=' + taskId.slice(0, 8) + ' · ' + (f2 ? '2 图' : '1 图') + ' · ' + types.join('+'), element: img, download: { href: bi.objUrl, filename: 'edit-2511-' + nowTs() + '.png' } });
    setStatus('改图 成功', 'ok');
  }

  // ── Modal DOM ──
  function buildDom() {
    if (byId(MASK_ID)) return;
    ensureStyles();
    mask = document.createElement('div');
    mask.id = MASK_ID;
    mask.className = 'img-mask';
    mask.innerHTML = [
      '<div class=\"img-studio\" role=\"dialog\" aria-modal=\"true\" aria-label=\"图像工坊\">',
        '<div class=\"img-header\">',
          '<div class=\"img-title\">🎨 图像工坊 <span class=\"img-badge-ver\">生图 / 改图</span></div>',
          '<button class=\"img-close\" id=\"imgCloseBtn\" title=\"关闭(ESC)\">✕</button>',
        '</div>',
        '<div class=\"img-tabs\" role=\"tablist\">',
          '<button class=\"img-tab\" data-mode=\"z\" role=\"tab\">文生图</button>',
          '<button class=\"img-tab\" data-mode=\"edit\" role=\"tab\">改图</button>',
        '</div>',
        '<div class=\"img-body\" id=\"imgBody\"></div>',
        '<div class=\"img-statusbar\"><span class=\"img-badge\" id=\"imgStatusBadge\">准备就绪</span><button class=\"img-btn img-btn-ghost\" id=\"imgAbortBtn\">取消轮询</button></div>',
        '<div class=\"img-output-head\">输出 <button class=\"img-btn img-btn-ghost\" id=\"imgClearOut\">清空</button></div>',
        '<div class=\"img-output\" id=\"imgOutput\"></div>',
      '</div>'
    ].join('');
    document.body.appendChild(mask);
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    byId('imgCloseBtn').addEventListener('click', close);
    byId('imgClearOut').addEventListener('click', clearOutput);
    byId('imgAbortBtn').addEventListener('click', function () { pollAbort.aborted = true; setStatus('已请求取消…', 'info'); });
    mask.querySelector('.img-tabs').addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.img-tab');
      if (b) switchMode(b.getAttribute('data-mode'));
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && mask && mask.classList.contains('open')) close();
    });
  }

  function renderBody() {
    var body = byId('imgBody');
    if (!body) return;
    if (currentMode === 'z') {
      body.innerHTML = [
        '<label class=\"img-lab\">提示词 Prompt</label>',
        '<textarea class=\"img-textarea\" id=\"imgZPrompt\" rows=\"5\" placeholder=\"例如：一只戴墨镜的柴犬，赛博朋克风，超清\"></textarea>',
        '<div class=\"img-grid2\">',
          '<div><label class=\"img-lab\">分辨率</label><select class=\"img-input\" id=\"imgZRes\"></select></div>',
          '<div><label class=\"img-lab\">张数 n (1-4)</label><input class=\"img-input\" id=\"imgZN\" type=\"number\" min=\"1\" max=\"4\" value=\"1\"></div>',
        '</div>',
        '<div class=\"img-row\"><button class=\"img-btn img-btn-primary\" id=\"imgZRun\">执行 / 生成</button></div>'
      ].join('');
      var sel = byId('imgZRes');
      Object.keys(Z_RESOLUTIONS).forEach(function (kk) {
        var o = document.createElement('option'); o.value = kk; o.textContent = kk; sel.appendChild(o);
      });
      sel.value = Object.keys(Z_RESOLUTIONS)[1]; // 默认 1024，避开 2048 高成本
      byId('imgZRun').addEventListener('click', function () {
        runZImage().catch(function (e) { setStatus('错误：' + e.message, 'err'); });
      });
    } else {
      body.innerHTML = [
        '<div class=\"img-grid2\">',
          '<div><label class=\"img-lab\">图1（必填）</label><input class=\"img-input\" id=\"imgEditImg1\" type=\"file\" accept=\"image/png,image/jpeg,image/webp\"></div>',
          '<div><label class=\"img-lab\">图2（可选）</label><input class=\"img-input\" id=\"imgEditImg2\" type=\"file\" accept=\"image/png,image/jpeg,image/webp\"></div>',
        '</div>',
        '<label class=\"img-lab\">提示词 Prompt</label>',
        '<textarea class=\"img-textarea\" id=\"imgEditPrompt\" rows=\"4\" placeholder=\"描述要的编辑效果，例如：把背景换成海边日落，保留人物\"></textarea>',
        '<label class=\"img-lab\">任务类型 task_types（可多选）</label>',
        '<div class=\"img-checks\" id=\"imgEditTypes\"></div>',
        '<div class=\"img-grid2\">',
          '<div><label class=\"img-lab\">steps (1-50)</label><input class=\"img-input\" id=\"imgEditSteps\" type=\"number\" min=\"1\" max=\"50\" value=\"4\"></div>',
          '<div><label class=\"img-lab\">guidance (0-10)</label><input class=\"img-input\" id=\"imgEditGuidance\" type=\"number\" min=\"0\" max=\"10\" step=\"0.5\" value=\"1\"></div>',
        '</div>',
        '<div class=\"img-row\"><button class=\"img-btn img-btn-primary\" id=\"imgEditRun\">执行 / 改图</button></div>'
      ].join('');
      var box = byId('imgEditTypes');
      EDIT_TASK_TYPES.forEach(function (t) {
        var lab = document.createElement('label'); lab.className = 'img-chk';
        var inp = document.createElement('input'); inp.type = 'checkbox'; inp.name = 'imgEditType'; inp.value = t;
        if (EDIT_DEFAULT_TYPES[t]) inp.checked = true;
        lab.appendChild(inp); lab.appendChild(document.createTextNode(' ' + t));
        box.appendChild(lab);
      });
      byId('imgEditRun').addEventListener('click', function () {
        runEdit().catch(function (e) { setStatus('错误：' + e.message, 'err'); });
      });
    }
  }

  function refreshTabs() {
    if (!mask) return;
    mask.querySelectorAll('.img-tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-mode') === currentMode);
    });
  }

  function open(mode) {
    buildDom();
    if (mode === 'z' || mode === 'edit') currentMode = mode;
    refreshTabs(); renderBody();
    mask.classList.add('open');
    document.body.classList.add('img-open');
  }
  function close() {
    if (!mask) return;
    mask.classList.remove('open');
    document.body.classList.remove('img-open');
  }
  function switchMode(mode) {
    if (mode !== 'z' && mode !== 'edit') return;
    currentMode = mode; refreshTabs(); renderBody();
  }

  // ── 程序化生成 API（供以后 形象/场景 调用）──
  async function generate(opts) {
    opts = opts || {};
    var key = getKey();
    var r = await apiFetch('images/generations', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: opts.prompt || '', model: 'z-image-turbo', n: opts.n || 1, size: opts.size || '1024x1024' })
    });
    var j = await readJsonSafely(r);
    if (!r.ok) throw new Error('生成失败 HTTP ' + r.status);
    return Array.isArray(j.data) ? j.data : [];
  }
  function abort() { pollAbort.aborted = true; }

  // ── 站点 Settings 注入 图像 API Key 卡（运行时，不改主线 HTML）──
  function injectSettingsCard() {
    var settings = byId('settings');
    if (!settings || byId('imgKeyCard')) return;
    var card = document.createElement('div');
    card.className = 'card';
    card.id = 'imgKeyCard';
    card.innerHTML = [
      '<h4>🎨 图像 API Key（Gitee）</h4>',
      '<p>图像工坊（生图 / 改图）调用 <code>ai.gitee.com</code>，需要单独的 Gitee API Key（与聊天密码无关）。仅本设备保存（LS <code>cfw_image_key_v1</code>），不进云同步。</p>',
      '<div class=\"rowline\"><input type=\"password\" id=\"imgKeyInput\" placeholder=\"Bearer Token\" style=\"flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;\"></div>',
      '<div class=\"rowline\" style=\"margin-top:8px;\"><div></div><div class=\"btns\"><button class=\"smallbtn\" id=\"imgKeySave\">保存</button><button class=\"smallbtn danger\" id=\"imgKeyClear\">清除</button></div></div>',
      '<div id=\"imgKeyStatus\" style=\"font-size:11px;color:#888;margin-top:8px;\"></div>'
    ].join('');
    settings.appendChild(card);
    var input = byId('imgKeyInput'), status = byId('imgKeyStatus');
    try { input.value = localStorage.getItem(KEY_LS) || ''; } catch (e) {}
    function setMsg() { try { status.textContent = localStorage.getItem(KEY_LS) ? '✅ 已保存 Key' : '未设置 Key'; } catch (e) {} }
    setMsg();
    byId('imgKeySave').addEventListener('click', function () {
      try { localStorage.setItem(KEY_LS, (input.value || '').trim()); } catch (e) {}
      setMsg();
    });
    byId('imgKeyClear').addEventListener('click', function () {
      try { localStorage.removeItem(KEY_LS); } catch (e) {}
      input.value = ''; setMsg();
    });
  }

  // ── 运行时启用左栏「图像(生/改)」按钮（避免改动主线 HTML）──
  function bindSidebarEntry() {
    var btns = document.querySelectorAll('.sidebar-btn');
    var target = null;
    Array.prototype.forEach.call(btns, function (b) {
      var lbl = b.querySelector('.sidebar-btn-label');
      if (lbl && /图像/.test(lbl.textContent || '')) target = b;
    });
    if (!target || target.__imgBound) return;
    target.__imgBound = true;
    target.removeAttribute('disabled');
    target.classList.remove('sidebar-btn-disabled');
    target.title = '🎨 图像工坊：文生图 / 改图';
    target.addEventListener('click', function (e) { e.preventDefault(); open(); });
  }

  function init() {
    injectSettingsCard();
    bindSidebarEntry();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // ── 自注入主题无关 CSS（currentColor 适配 极简/毛玻璃/蜜桃/少女）──
  function ensureStyles() {
    if (byId('imgStudioStyles')) return;
    var s = document.createElement('style');
    s.id = 'imgStudioStyles';
    s.textContent = [
      '.img-mask{position:fixed;inset:0;z-index:40;display:none;align-items:flex-start;justify-content:center;background:rgba(0,0,0,.55);overflow:auto;padding:32px 16px;}',
      '.img-mask.open{display:flex;}',
      '.img-studio{width:100%;max-width:680px;background:var(--bg,#1a1a1a);color:inherit;border:1px solid currentColor;border-radius:14px;padding:18px;box-shadow:0 12px 40px rgba(0,0,0,.5);}',
      '.img-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}',
      '.img-title{font-weight:600;font-size:16px;}',
      '.img-badge-ver{font-size:11px;opacity:.6;border:1px solid currentColor;border-radius:6px;padding:1px 6px;margin-left:6px;}',
      '.img-close{background:transparent;border:1px solid rgba(127,127,127,.4);color:inherit;border-radius:8px;cursor:pointer;width:30px;height:30px;}',
      '.img-tabs{display:flex;gap:8px;margin-bottom:14px;}',
      '.img-tab{flex:1;padding:8px;border-radius:8px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;cursor:pointer;font-size:14px;opacity:.7;}',
      '.img-tab.active{opacity:1;border-color:currentColor;box-shadow:inset 0 -2px 0 currentColor;font-weight:600;}',
      '.img-lab{display:block;font-size:12px;opacity:.7;margin:10px 0 4px;}',
      '.img-input,.img-textarea{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:rgba(0,0,0,.15);color:inherit;font:inherit;}',
      '.img-textarea{resize:vertical;min-height:80px;}',
      '.img-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px;}',
      '.img-checks{display:flex;flex-wrap:wrap;gap:10px;margin:4px 0;}',
      '.img-chk{font-size:13px;display:flex;align-items:center;gap:4px;cursor:pointer;}',
      '.img-row{margin-top:14px;}',
      '.img-btn{padding:8px 14px;border-radius:8px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;font-size:13px;opacity:.9;text-decoration:none;display:inline-block;}',
      '.img-btn:hover{opacity:1;background:rgba(127,127,127,.12);}',
      '.img-btn-primary{border-width:1.5px;opacity:1;}',
      '.img-btn-ghost{border-color:rgba(127,127,127,.35);font-size:12px;padding:4px 10px;}',
      '.img-statusbar{display:flex;align-items:center;gap:10px;margin:14px 0 6px;}',
      '.img-badge{font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid rgba(127,127,127,.3);opacity:.85;flex:1;}',
      '.img-badge-ok{border-color:rgba(37,194,160,.7);}',
      '.img-badge-err{border-color:rgba(255,84,112,.75);}',
      '.img-output-head{display:flex;align-items:center;justify-content:space-between;font-size:13px;opacity:.7;margin:10px 0 6px;}',
      '.img-output{display:flex;flex-direction:column;gap:10px;}',
      '.img-item{border:1px solid rgba(127,127,127,.2);border-radius:10px;padding:10px;}',
      '.img-item h4{margin:0 0 4px;font-size:13px;}',
      '.img-item-meta{font-size:11px;opacity:.6;margin-bottom:6px;}',
      '.img-out-img{max-width:100%;border-radius:8px;display:block;}',
      '.img-item-row{margin-top:8px;display:flex;gap:8px;}',
      '@media(max-width:640px){.img-grid2{grid-template-columns:1fr;}.img-studio{padding:14px;}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  window.__image = { open: open, close: close, switchMode: switchMode, generate: generate, abort: abort };
})();