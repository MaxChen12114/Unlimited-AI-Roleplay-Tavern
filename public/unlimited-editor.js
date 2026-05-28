/**
 * unlimited-editor.js · 解限编辑器（Unlimited Editor）
 *
 * 项目灵魂的「编辑器壳」—— 区别于正常酒馆聊天，提供独立 Modal 弹窗，
 * 在 base 解限模式之上做 JSON 资产编排：preset / 角色 / 世界观 / UI 配置。
 *
 * 4.7 v0 骨架：
 *   - 左侧栏 🛠 按钮 → 打开 Modal（z-index:30 高于 settings）
 *   - 顶部 4 tab：Preset · 角色 · 世界观 · UI 配置
 *   - 各 tab 仅显示占位说明 + 未来计划，先验大方向
 *   - ESC / 遮罩外点击 / ✕ / 底部「关闭」均可关闭
 *
 * 存储方案（用户拍板 KV+本地，后续填充）：
 *   - LS（被现有 sync.js 推 KV）：preset / UI 配置 / 世界观文本
 *   - IndexedDB 本地：角色卡 + base64 立绘（不上云）
 *
 * 公开 API：window.__unlimitedEditor = { open, close, switchTab }
 */
(function(){
  'use strict';

  if (window.__unlimitedEditor) return;

  var MASK_ID = 'unlimitedEditorMask';

  var TABS = [
    {
      id: 'preset', icon: '🎯', label: 'Preset 提示词',
      desc: '编辑提示词追加层（PROMPT_1/2/3 之后的语调约束层），管理多个 starter 包。',
      plan: '即将上线：\n  · RP-Hub 12 个 starter 默认包加载（替换现有 5 个内置）\n  · JSON schema 编辑器 + 导入/导出\n  · 启用顺序拖拽（COT 在快速模式自动禁）\n  · 命名空间隔离（避免预设互相覆盖）\n\n存储：LS key `cfw_prompt_presets_v1` → 现有 sync.js 自动推 KV → 跨设备同步。'
    },
    {
      id: 'character', icon: '🎭', label: '角色卡',
      desc: '编辑 RP 角色卡：人设 / 背景 / 立绘 / 初始关系。区别于左栏「角色卡」面板：那里是切换，这里是 schema 级编辑。',
      plan: '即将上线：\n  · 角色 JSON schema 编辑（name / persona / scenario / first_message / example_dialogs）\n  · base64 立绘上传 + 裁剪预览\n  · 初始关系/好感度键值编辑\n  · 单卡导出 .png 内嵌 JSON（兼容 SillyTavern V2 卡）\n\n存储：IndexedDB 本地 db `ue_characters_v1`（大文件不上云）。'
    },
    {
      id: 'world', icon: '🌐', label: '世界观',
      desc: '编辑世界观条目（Lore Book）：地点 / 设定 / 事件线 / 关键词触发。',
      plan: '即将上线：\n  · 条目 CRUD（key / content / trigger keywords / priority）\n  · 关键词命中扫描 + 注入到 system prompt\n  · 多世界切换 + 角色绑定\n  · 优先级排序 + token 预算控制\n\n存储：LS key `cfw_lorebooks_v1` → 跨设备同步。'
    },
    {
      id: 'ui', icon: '🎨', label: 'UI 配置',
      desc: '编辑界面 UI 微调层：在 4 主题之上叠加用户偏好（不替换主题，只覆盖变量）。',
      plan: '即将上线：\n  · 字号 / 行高 / 圆角 / 间距参数\n  · 自定义 CSS 变量覆盖（--bg / --bubble-ai 等）\n  · 用户主题 JSON 导入（社区共享）\n  · 实时预览 + 一键还原\n\n存储：LS key `cfw_ui_overrides_v1` → 跨设备同步。'
    }
  ];

  var currentTab = 'preset';
  var mask = null;

  function buildDom(){
    if (document.getElementById(MASK_ID)) return;
    ensureStyles();
    mask = document.createElement('div');
    mask.id = MASK_ID;
    mask.innerHTML = [
      '<div id="unlimitedEditor" role="dialog" aria-label="解限编辑器" aria-modal="true">',
        '<div class="ue-header">',
          '<div class="ue-title">🛠 解限编辑器 <span class="ue-badge">v0 骨架</span></div>',
          '<button class="ue-close" id="ueCloseBtn" aria-label="关闭" title="关闭(ESC)">✕</button>',
        '</div>',
        '<div class="ue-tabs" id="ueTabs" role="tablist">',
          TABS.map(function(t){
            return '<button class="ue-tab" role="tab" data-tab="' + t.id + '" title="' + escapeAttr(t.label) + '"><span class="ue-tab-icon">' + t.icon + '</span><span class="ue-tab-label">' + escapeHtml(t.label) + '</span></button>';
          }).join(''),
        '</div>',
        '<div class="ue-body" id="ueBody" role="tabpanel"></div>',
        '<div class="ue-footer">',
          '<span class="ue-footer-hint">此处编辑的是 JSON 资产，不会触发聊天。Esc 退出。</span>',
          '<button class="ue-btn-ghost" id="ueFooterClose">关闭</button>',
        '</div>',
      '</div>'
    ].join('');
    document.body.appendChild(mask);

    // 点遮罩外侧关闭（点内容区不关）
    mask.addEventListener('click', function(e){
      if (e.target === mask) close();
    });
    document.getElementById('ueCloseBtn').addEventListener('click', close);
    document.getElementById('ueFooterClose').addEventListener('click', close);

    document.getElementById('ueTabs').addEventListener('click', function(e){
      var btn = e.target.closest && e.target.closest('.ue-tab');
      if (!btn) return;
      switchTab(btn.getAttribute('data-tab'));
    });

    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && mask && mask.classList.contains('open')) close();
    });
  }

  function renderBody(){
    if (currentTab === 'preset') return renderPresetTab();
    var t = findTab(currentTab) || TABS[0];
    var body = document.getElementById('ueBody');
    if (!body) return;
    body.innerHTML = [
      '<div class="ue-panel">',
        '<div class="ue-panel-head">',
          '<span class="ue-panel-icon">' + t.icon + '</span>',
          '<span class="ue-panel-name">' + escapeHtml(t.label) + '</span>',
        '</div>',
        '<p class="ue-panel-desc">' + escapeHtml(t.desc) + '</p>',
        '<div class="ue-placeholder">',
          '<div class="ue-placeholder-title">⌛ 即将上线</div>',
          '<pre class="ue-placeholder-plan">' + escapeHtml(t.plan) + '</pre>',
        '</div>',
      '</div>'
    ].join('');
  }

  function refreshTabs(){
    var btns = document.querySelectorAll('#ueTabs .ue-tab');
    btns.forEach(function(b){
      var on = b.getAttribute('data-tab') === currentTab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function findTab(id){
    for (var i = 0; i < TABS.length; i++) if (TABS[i].id === id) return TABS[i];
    return null;
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }
  function escapeAttr(s){ return escapeHtml(s); }

  function open(tabId){
    buildDom();
    if (tabId && findTab(tabId)) currentTab = tabId;
    refreshTabs();
    renderBody();
    mask.classList.add('open');
    document.body.classList.add('ue-open');
  }

  function close(){
    if (!mask) return;
    mask.classList.remove('open');
    document.body.classList.remove('ue-open');
  }

  function switchTab(tabId){
    if (!findTab(tabId)) return;
    currentTab = tabId;
    refreshTabs();
    renderBody();
  }

  function bindEntry(){
    var btn = document.getElementById('unlimitedEditorBtn');
    if (btn && !btn.__ueBound) {
      btn.__ueBound = true;
      btn.addEventListener('click', function(e){
        e.preventDefault();
        open();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindEntry);
  } else {
    bindEntry();
  }

  // ============== Preset Tab 实质化（4.7 v1）==============
  // 与 presets-ui.js 共用 LS key `cfw_prompt_presets_v1`，对左侧栏「提示词预设」面板完全兼容。
  // 4 tab 中只有 Preset 实质化；character / world / ui 仍走 renderBody() 占位逻辑。

  var PRESETS_KEY = 'cfw_prompt_presets_v1';

  function uePresetsLoad(){
    try {
      var raw = localStorage.getItem(PRESETS_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function uePresetsSave(arr){
    try { localStorage.setItem(PRESETS_KEY, JSON.stringify(arr)); } catch (e) {}
  }
  function uePresetUid(){
    return 'preset-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  }
  async function ueFetchStarter(){
    try {
      var resp = await fetch('/starter-presets.json', { cache: 'no-store' });
      if (!resp.ok) return null;
      var data = await resp.json();
      var arr = Array.isArray(data) ? data : (data && Array.isArray(data.presets) ? data.presets : null);
      return (arr && arr.length) ? arr : null;
    } catch (e) { return null; }
  }

  function renderPresetTab(){
    var t = findTab('preset');
    var body = document.getElementById('ueBody');
    if (!body) return;
    var arr = uePresetsLoad();
    arr.sort(function(a,b){ return (a.order||0) - (b.order||0); });

    body.innerHTML = [
      '<div class="ue-panel">',
        '<div class="ue-panel-head">',
          '<span class="ue-panel-icon">' + t.icon + '</span>',
          '<span class="ue-panel-name">' + escapeHtml(t.label) + '</span>',
        '</div>',
        '<p class="ue-panel-desc">' + escapeHtml(t.desc) + '</p>',
        '<div class="ue-toolbar">',
          '<button class="ue-btn ue-btn-primary" id="uePresetNew">＋ 新建</button>',
          '<button class="ue-btn" id="uePresetReloadStarter" title="从 /starter-presets.json 覆盖（会替换所有现有 preset）">↻ 重载默认包</button>',
          '<button class="ue-btn" id="uePresetJsonMode">📋 JSON 源码</button>',
          '<button class="ue-btn" id="uePresetExport">📤 导出</button>',
          '<span class="ue-toolbar-spacer"></span>',
          '<span class="ue-count">共 ' + arr.length + ' 个 preset</span>',
        '</div>',
        '<div class="ue-preset-list" id="uePresetList">',
          arr.length === 0
            ? '<div class="ue-empty">尚无 preset。点击「↻ 重载默认包」从 /starter-presets.json 载入，或「＋ 新建」自定义。</div>'
            : arr.map(function(p, i){ return uePresetRowHtml(p, i, arr.length); }).join(''),
        '</div>',
        '<div class="ue-editor-slot" id="uePresetEditor"></div>',
      '</div>'
    ].join('');

    document.getElementById('uePresetNew').addEventListener('click', function(){
      var cur = uePresetsLoad();
      var maxOrder = cur.reduce(function(m, x){ return Math.max(m, x.order||0); }, -1);
      var p = { id: uePresetUid(), name: '新预设', content: '', enabled: false, order: maxOrder + 1 };
      cur.push(p);
      uePresetsSave(cur);
      renderPresetTab();
      uePresetEdit(p.id);
    });
    document.getElementById('uePresetReloadStarter').addEventListener('click', async function(){
      var pack = await ueFetchStarter();
      if (!pack) { alert('从 /starter-presets.json 加载失败（可能尚未部署或网络异常）'); return; }
      if (!confirm('将用 ' + pack.length + ' 个 starter 覆盖当前所有 preset（共 ' + uePresetsLoad().length + ' 个）。继续？')) return;
      uePresetsSave(pack);
      renderPresetTab();
    });
    document.getElementById('uePresetJsonMode').addEventListener('click', uePresetJsonEditor);
    document.getElementById('uePresetExport').addEventListener('click', function(){
      var json = JSON.stringify(uePresetsLoad(), null, 2);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json).then(
          function(){ alert('已导出 ' + uePresetsLoad().length + ' 个 preset 到剪贴板'); },
          function(){ prompt('复制 JSON：', json); }
        );
      } else { prompt('复制 JSON：', json); }
    });

    var listEl = document.getElementById('uePresetList');
    listEl.addEventListener('click', function(e){
      var row = e.target.closest && e.target.closest('.ue-preset-row');
      if (!row) return;
      var pid = row.getAttribute('data-id');
      if (e.target.classList.contains('ue-preset-edit')) uePresetEdit(pid);
      else if (e.target.classList.contains('ue-preset-del')) uePresetDel(pid);
      else if (e.target.classList.contains('ue-preset-up')) uePresetMove(pid, -1);
      else if (e.target.classList.contains('ue-preset-down')) uePresetMove(pid, +1);
    });
    listEl.addEventListener('change', function(e){
      if (!e.target.classList.contains('ue-preset-chk')) return;
      var row = e.target.closest('.ue-preset-row');
      var pid = row.getAttribute('data-id');
      var cur = uePresetsLoad();
      var p = cur.find(function(x){ return x.id === pid; });
      if (p) { p.enabled = !!e.target.checked; uePresetsSave(cur); row.classList.toggle('enabled', p.enabled); }
    });
  }

  function uePresetRowHtml(p, idx, total){
    var preview = (p.content || '').slice(0, 80).replace(/\n/g, ' ');
    if ((p.content || '').length > 80) preview += '…';
    return [
      '<div class="ue-preset-row' + (p.enabled ? ' enabled' : '') + '" data-id="' + escapeAttr(p.id) + '">',
        '<label class="ue-preset-tog">',
          '<input type="checkbox" class="ue-preset-chk"' + (p.enabled ? ' checked' : '') + '>',
          '<span class="ue-preset-name">' + escapeHtml(p.name || '(未命名)') + '</span>',
        '</label>',
        '<div class="ue-preset-preview">' + (escapeHtml(preview) || '<em>（空内容）</em>') + '</div>',
        '<div class="ue-preset-ops">',
          idx > 0 ? '<button class="ue-mini ue-preset-up" title="上移">↑</button>' : '<span class="ue-mini-placeholder"></span>',
          idx < total - 1 ? '<button class="ue-mini ue-preset-down" title="下移">↓</button>' : '<span class="ue-mini-placeholder"></span>',
          '<button class="ue-mini ue-preset-edit" title="编辑">✎</button>',
          '<button class="ue-mini danger ue-preset-del" title="删除">✕</button>',
        '</div>',
      '</div>'
    ].join('');
  }

  function uePresetEdit(pid){
    var cur = uePresetsLoad();
    var p = cur.find(function(x){ return x.id === pid; });
    if (!p) return;
    var slot = document.getElementById('uePresetEditor');
    if (!slot) return;
    slot.innerHTML = [
      '<div class="ue-editor-card">',
        '<div class="ue-editor-head">✎ 编辑 preset</div>',
        '<label class="ue-field"><span>名称</span><input class="ue-input" id="uePEName" value="' + escapeAttr(p.name || '') + '"></label>',
        '<label class="ue-field"><span>内容（追加到 system prompt 末层）</span><textarea class="ue-textarea" id="uePEContent" rows="10">' + escapeHtml(p.content || '') + '</textarea></label>',
        '<div class="ue-editor-foot">',
          '<button class="ue-btn ue-btn-primary" id="uePESave">保存</button>',
          '<button class="ue-btn" id="uePECancel">取消</button>',
        '</div>',
      '</div>'
    ].join('');
    slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    document.getElementById('uePESave').addEventListener('click', function(){
      var nm = (document.getElementById('uePEName').value || '').trim();
      if (!nm) { alert('名称不能为空'); return; }
      var ct = document.getElementById('uePEContent').value || '';
      p.name = nm; p.content = ct;
      uePresetsSave(cur);
      renderPresetTab();
    });
    document.getElementById('uePECancel').addEventListener('click', function(){ slot.innerHTML = ''; });
  }

  function uePresetDel(pid){
    var cur = uePresetsLoad();
    var p = cur.find(function(x){ return x.id === pid; });
    if (!p) return;
    if (!confirm('删除 preset「' + p.name + '」？')) return;
    cur = cur.filter(function(x){ return x.id !== pid; });
    uePresetsSave(cur);
    renderPresetTab();
  }

  function uePresetMove(pid, dir){
    var cur = uePresetsLoad();
    cur.sort(function(a,b){ return (a.order||0) - (b.order||0); });
    var i = cur.findIndex(function(x){ return x.id === pid; });
    if (i < 0) return;
    var j = i + dir;
    if (j < 0 || j >= cur.length) return;
    var tmp = cur[j].order; cur[j].order = cur[i].order; cur[i].order = tmp;
    uePresetsSave(cur);
    renderPresetTab();
  }

  function uePresetJsonEditor(){
    var slot = document.getElementById('uePresetEditor');
    if (!slot) return;
    var json = JSON.stringify(uePresetsLoad(), null, 2);
    slot.innerHTML = [
      '<div class="ue-editor-card">',
        '<div class="ue-editor-head">📋 JSON 源码模式（保存会覆盖全部 preset）</div>',
        '<textarea class="ue-textarea ue-mono" id="uePresetJsonText" rows="16">' + escapeHtml(json) + '</textarea>',
        '<div class="ue-editor-foot">',
          '<button class="ue-btn ue-btn-primary" id="uePJSave">保存 JSON</button>',
          '<button class="ue-btn" id="uePJCancel">取消</button>',
        '</div>',
      '</div>'
    ].join('');
    slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    document.getElementById('uePJSave').addEventListener('click', function(){
      var s = document.getElementById('uePresetJsonText').value || '';
      try {
        var arr = JSON.parse(s);
        if (!Array.isArray(arr)) throw new Error('JSON 顶层必须是数组');
        var clean = arr.filter(function(x){ return x && typeof x.name === 'string' && typeof x.content === 'string'; })
          .map(function(x, i){
            return {
              id: x.id || ('preset-' + Date.now() + '-' + i),
              name: x.name, content: x.content,
              enabled: !!x.enabled,
              order: typeof x.order === 'number' ? x.order : i
            };
          });
        if (!clean.length) { alert('没有有效 preset（需 name + content 字段）'); return; }
        if (!confirm('将用 ' + clean.length + ' 个 preset 覆盖当前 ' + uePresetsLoad().length + ' 个。继续？')) return;
        uePresetsSave(clean);
        renderPresetTab();
      } catch (e) {
        alert('JSON 解析失败：' + e.message);
      }
    });
    document.getElementById('uePJCancel').addEventListener('click', function(){ slot.innerHTML = ''; });
  }

  // ============== Runtime CSS（避免污染全局 styles.css，自我注入）==============
  function ensureStyles(){
    if (document.getElementById('ueRuntimeStyles')) return;
    var s = document.createElement('style');
    s.id = 'ueRuntimeStyles';
    s.textContent = [
      '.ue-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 12px 0 8px; }',
      '.ue-toolbar-spacer { flex: 1; }',
      '.ue-count { font-size: 12px; opacity: .65; }',
      '.ue-btn { padding: 6px 12px; border-radius: 8px; border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer; font-size: 13px; line-height: 1.3; opacity: .85; }',
      '.ue-btn:hover { opacity: 1; background: rgba(127,127,127,.12); }',
      '.ue-btn-primary { border-width: 1.5px; opacity: 1; }',
      '.ue-preset-list { display: flex; flex-direction: column; gap: 6px; margin: 6px 0 14px; }',
      '.ue-preset-row { display: grid; grid-template-columns: minmax(120px, 220px) 1fr auto; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 8px; background: rgba(127,127,127,.06); border: 1px solid rgba(127,127,127,.18); transition: border-color .15s; }',
      '.ue-preset-row.enabled { border-color: currentColor; box-shadow: inset 3px 0 0 currentColor; }',
      '.ue-preset-tog { display: flex; align-items: center; gap: 8px; cursor: pointer; min-width: 0; }',
      '.ue-preset-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }',
      '.ue-preset-preview { font-size: 12px; opacity: .65; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }',
      '.ue-preset-ops { display: flex; gap: 4px; }',
      '.ue-mini { padding: 2px 8px; font-size: 13px; line-height: 1.2; border-radius: 6px; border: 1px solid rgba(127,127,127,.3); background: transparent; color: inherit; cursor: pointer; }',
      '.ue-mini:hover { background: rgba(127,127,127,.18); }',
      '.ue-mini.danger:hover { background: rgba(255, 80, 80, .15); color: #ff7777; border-color: #ff7777; }',
      '.ue-mini-placeholder { display: inline-block; width: 28px; }',
      '.ue-empty { padding: 28px 16px; text-align: center; opacity: .55; font-size: 13px; border: 1px dashed rgba(127,127,127,.3); border-radius: 10px; }',
      '.ue-editor-slot:empty { display: none; }',
      '.ue-editor-card { margin-top: 10px; padding: 14px; border-radius: 10px; background: rgba(127,127,127,.08); border: 1px solid currentColor; }',
      '.ue-editor-head { font-weight: 600; margin-bottom: 10px; font-size: 14px; }',
      '.ue-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }',
      '.ue-field > span { font-size: 12px; opacity: .7; }',
      '.ue-input, .ue-textarea { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(127,127,127,.35); background: rgba(0,0,0,.15); color: inherit; font: inherit; box-sizing: border-box; }',
      '.ue-input:focus, .ue-textarea:focus { outline: none; border-color: currentColor; }',
      '.ue-textarea { resize: vertical; min-height: 100px; }',
      '.ue-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.55; }',
      '.ue-editor-foot { display: flex; gap: 8px; margin-top: 8px; }',
      '@media (max-width: 640px) {',
        '  .ue-preset-row { grid-template-columns: 1fr; gap: 6px; }',
        '  .ue-preset-preview { white-space: normal; -webkit-line-clamp: 2; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }',
        '  .ue-preset-ops { justify-content: flex-end; }',
      '}'
    ].join('\n');
    document.head.appendChild(s);
  }

  window.__unlimitedEditor = {
    open: open, close: close, switchTab: switchTab,
    // 外部强制刷新当前 tab（如 settings 改了 LS 后调用）
    refresh: function(){ if (mask && mask.classList.contains('open')) renderBody(); }
  };
})();