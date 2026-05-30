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
    if (currentTab === 'ui') return renderUITab();
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

  // 4.22: 启动即应用 UI 配置覆盖层（即使从未打开过编辑器）
  function ueInitOverrides(){ try { applyUIOverrides(); } catch (e) {} }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ueInitOverrides);
  } else {
    ueInitOverrides();
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
          '<button class="ue-btn" id="uePresetUpload" title="上传 .json（追加；兼容 SillyTavern 预设）">📁 上传</button>',
          '<input type="file" id="uePresetFile" accept=".json,application/json" style="display:none">',
          '<button class="ue-btn" id="uePresetExport">📤 导出</button>',
          '<span class="ue-toolbar-spacer"></span>',
          '<span class="ue-count">共 ' + arr.length + ' 个 preset</span>',
        '</div>',
        '<div class="ue-preset-list" id="uePresetList">',
          ueRenderPresetListHtml(arr),
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

    var fileEl = document.getElementById('uePresetFile');
    var upBtn = document.getElementById('uePresetUpload');
    if (upBtn) upBtn.addEventListener('click', function(){ if (fileEl) { fileEl.value = ''; fileEl.click(); } });
    if (fileEl) fileEl.addEventListener('change', function(){
      var f = fileEl.files && fileEl.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function(){ ueImportPresetFile(String(rd.result || ''), f.name); };
      rd.readAsText(f);
    });

    var listEl = document.getElementById('uePresetList');
    listEl.addEventListener('click', function(e){
      var head = e.target.closest && e.target.closest('.ue-pgroup-head');
      if (head) {
        if (e.target.classList.contains('ue-pgroup-del')) { ueGroupDelete(head.getAttribute('data-group')); return; }
        var g = head.getAttribute('data-group');
        uePresetCollapsed[g] = !uePresetCollapsed[g];
        renderPresetTab();
        return;
      }
      var row = e.target.closest && e.target.closest('.ue-preset-row');
      if (!row) return;
      var pid = row.getAttribute('data-id');
      if (e.target.classList.contains('ue-preset-edit')) uePresetEdit(pid);
      else if (e.target.classList.contains('ue-preset-del')) uePresetDel(pid);
      else if (e.target.classList.contains('ue-preset-up')) uePresetMove(pid, -1);
      else if (e.target.classList.contains('ue-preset-down')) uePresetMove(pid, +1);
    });
    listEl.addEventListener('dragstart', function(e){
      var row = e.target.closest && e.target.closest('.ue-preset-row');
      if (!row) return;
      ueDragId = row.getAttribute('data-id');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', ueDragId); } catch (x) {}
      row.classList.add('dragging');
    });
    listEl.addEventListener('dragend', function(e){
      var row = e.target.closest && e.target.closest('.ue-preset-row');
      if (row) row.classList.remove('dragging');
      listEl.querySelectorAll('.dragover').forEach(function(r){ r.classList.remove('dragover'); });
      ueDragId = null;
    });
    listEl.addEventListener('dragover', function(e){
      if (!ueDragId) return;
      e.preventDefault();
      var row = e.target.closest && e.target.closest('.ue-preset-row');
      listEl.querySelectorAll('.dragover').forEach(function(r){ if (r !== row) r.classList.remove('dragover'); });
      if (row && row.getAttribute('data-id') !== ueDragId) row.classList.add('dragover');
    });
    listEl.addEventListener('drop', function(e){
      e.preventDefault();
      var row = e.target.closest && e.target.closest('.ue-preset-row');
      if (!row || !ueDragId) return;
      var targetId = row.getAttribute('data-id');
      if (targetId !== ueDragId) uePresetDrop(ueDragId, targetId);
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

  function uePresetRowHtml(p){
    var preview = (p.content || '').slice(0, 80).replace(/\n/g, ' ');
    if ((p.content || '').length > 80) preview += '…';
    return [
      '<div class="ue-preset-row' + (p.enabled ? ' enabled' : '') + '" data-id="' + escapeAttr(p.id) + '" draggable="true">',
        '<span class="ue-preset-drag" title="拖拽排序">⠹</span>',
        '<label class="ue-preset-tog">',
          '<input type="checkbox" class="ue-preset-chk"' + (p.enabled ? ' checked' : '') + '>',
          '<span class="ue-preset-name">' + escapeHtml(p.name || '(未命名)') + '</span>',
        '</label>',
        '<div class="ue-preset-preview">' + (escapeHtml(preview) || '<em>（空内容）</em>') + '</div>',
        '<div class="ue-preset-ops">',
          '<button class="ue-mini ue-preset-up" title="上移">↑</button>',
          '<button class="ue-mini ue-preset-down" title="下移">↓</button>',
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
              order: typeof x.order === 'number' ? x.order : i,
              group: typeof x.group === 'string' ? x.group : ''
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

  // ============== 4.23: Preset 增强（分组收纳 / 拖拽 / .json 上传）==============
  // group 为可选字段（不填=未分组，老数据完全兼容）。SillyTavern 预设按文件名收进同名分组。
  var uePresetCollapsed = {};
  var ueDragId = null;

  function ueRenderPresetListHtml(arr){
    if (!arr.length) return '<div class="ue-empty">尚无 preset。点击「↻ 重载默认包」载入，或「＋ 新建」/「📁 上传」自定义。</div>';
    var order = [], map = {};
    arr.forEach(function(p){ var g = p.group || ''; if (!(g in map)) { map[g] = []; order.push(g); } map[g].push(p); });
    var html = '';
    order.forEach(function(g){
      var items = map[g];
      if (g === '') { html += items.map(uePresetRowHtml).join(''); return; }
      var collapsed = !!uePresetCollapsed[g];
      html += '<div class="ue-pgroup-head" data-group="' + escapeAttr(g) + '">'
        + '<span class="ue-pgroup-arrow">' + (collapsed ? '▸' : '▾') + '</span>'
        + '<span class="ue-pgroup-name">' + escapeHtml(g) + '</span>'
        + '<span class="ue-pgroup-count">' + items.length + '</span>'
        + '<button class="ue-mini danger ue-pgroup-del" data-group="' + escapeAttr(g) + '" title="删除整组">✕</button></div>';
      if (!collapsed) html += '<div class="ue-pgroup-body">' + items.map(uePresetRowHtml).join('') + '</div>';
    });
    return html;
  }

  function uePresetDrop(dragId, targetId){
    var cur = uePresetsLoad();
    cur.sort(function(a,b){ return (a.order||0) - (b.order||0); });
    var di = cur.findIndex(function(x){ return x.id === dragId; });
    if (di < 0) return;
    var item = cur.splice(di, 1)[0];
    var ti = cur.findIndex(function(x){ return x.id === targetId; });
    if (ti < 0) { cur.push(item); } else { item.group = cur[ti].group || ''; cur.splice(ti, 0, item); }
    cur.forEach(function(x, i){ x.order = i; });
    uePresetsSave(cur);
    renderPresetTab();
  }

  function ueGroupDelete(g){
    var cur = uePresetsLoad();
    var n = cur.filter(function(x){ return (x.group||'') === g; }).length;
    if (!confirm('删除分组「' + g + '」下的全部 ' + n + ' 个 preset？')) return;
    cur = cur.filter(function(x){ return (x.group||'') !== g; });
    uePresetsSave(cur);
    renderPresetTab();
  }

  function ueImportPresetFile(text, fname){
    var data;
    try { data = JSON.parse(text); } catch (e) { alert('JSON 解析失败：' + e.message); return; }
    var groupName = String(fname || '').replace(/\.json$/i, '') || '导入';
    var add = [];
    if (Array.isArray(data)) {
      add = data.filter(function(x){ return x && typeof x.name === 'string' && typeof x.content === 'string'; })
        .map(function(x){ return { name: x.name, content: x.content, enabled: !!x.enabled, group: (typeof x.group === 'string' ? x.group : '') }; });
    } else if (data && Array.isArray(data.prompts)) {
      add = ueParseSillyTavern(data, groupName);
    } else if (data && typeof data.name === 'string' && typeof data.content === 'string') {
      add = [{ name: data.name, content: data.content, enabled: !!data.enabled, group: '' }];
    } else {
      alert('无法识别的预设格式（支持本应用数组 / SillyTavern 预设 / 单条 {name,content}）');
      return;
    }
    if (!add.length) { alert('文件里没有可导入的有效条目'); return; }
    var cur = uePresetsLoad();
    var maxOrder = cur.reduce(function(m, x){ return Math.max(m, x.order||0); }, -1);
    add.forEach(function(p, i){
      cur.push({ id: uePresetUid() + '-' + i, name: p.name, content: p.content, enabled: !!p.enabled, order: maxOrder + 1 + i, group: p.group || '' });
    });
    uePresetsSave(cur);
    if (add[0] && add[0].group) uePresetCollapsed[add[0].group] = false;
    renderPresetTab();
    alert('已追加 ' + add.length + ' 个 preset' + (add[0] && add[0].group ? ('（分组「' + add[0].group + '」）') : ''));
  }

  function ueParseSillyTavern(data, groupName){
    var enabledMap = {};
    if (Array.isArray(data.prompt_order) && data.prompt_order.length) {
      var ord = data.prompt_order[data.prompt_order.length - 1];
      if (ord && Array.isArray(ord.order)) ord.order.forEach(function(o){ if (o && o.identifier) enabledMap[o.identifier] = (o.enabled !== false); });
    }
    var out = [];
    data.prompts.forEach(function(pr){
      if (!pr || pr.marker === true) return;
      var content = (typeof pr.content === 'string') ? pr.content : '';
      if (!content.trim()) return;
      var name = pr.name || pr.identifier || '(未命名)';
      var en = (pr.identifier && (pr.identifier in enabledMap)) ? enabledMap[pr.identifier] : false;
      out.push({ name: name, content: content, enabled: !!en, group: groupName });
    });
    return out;
  }

  // ============== UI 配置 Tab 实质化（4.22 · 全局覆盖层）==============
  // 在 4 主题之上叠加用户偏好：颜色/布局/圆角/背景图/背景音/高级 CSS。
  // CSS 变量走 documentElement 行内样式（优先级最高，盖过 [data-theme]）。
  // 存储：cfw_ui_overrides_v1（小文本，跨设备同步）+ cfw_ui_assets_v1（base64 上传，仅本机）。
  var UI_KEY = 'cfw_ui_overrides_v1';
  var UI_ASSETS_KEY = 'cfw_ui_assets_v1';
  var UI_COLOR_FIELDS = [
    { k: '--bg', label: '背景' },
    { k: '--bubble-ai', label: 'AI 气泡' },
    { k: '--bubble-user', label: '用户气泡' },
    { k: '--border', label: '边框' },
    { k: '--btn-bg', label: '主色 / 按钮' },
    { k: '--input-bg', label: '输入框' }
  ];
  var UI_LAYOUT_FIELDS = [
    { k: '--content-max', label: '内容宽度', min: 560, max: 1280 },
    { k: '--content-side', label: '左右边距', min: 0, max: 48 },
    { k: '--composer-gap', label: '输入区底距', min: 0, max: 80 }
  ];

  function ueUiLoad(){ try { var o = JSON.parse(localStorage.getItem(UI_KEY) || '{}'); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; } }
  function ueUiSave(o){ try { localStorage.setItem(UI_KEY, JSON.stringify(o || {})); } catch (e) {} applyUIOverrides(); }
  function ueAssetsLoad(){ try { var o = JSON.parse(localStorage.getItem(UI_ASSETS_KEY) || '{}'); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; } }
  function ueAssetsSave(o){ try { localStorage.setItem(UI_ASSETS_KEY, JSON.stringify(o || {})); } catch (e) {} }

  function ueParseRawVars(raw){
    var out = [];
    String(raw || '').split(/[;\n]/).forEach(function(line){
      var i = line.indexOf(':'); if (i < 0) return;
      var name = line.slice(0, i).trim(), val = line.slice(i + 1).trim();
      if (/^--[\w-]+$/.test(name) && val) out.push([name, val]);
    });
    return out;
  }

  function applyUIOverrides(){
    var o = ueUiLoad(), root = document.documentElement;
    (root.getAttribute('data-ue-vars') || '').split(',').filter(Boolean).forEach(function(n){ root.style.removeProperty(n); });
    var applied = [], vars = o.vars || {};
    Object.keys(vars).forEach(function(n){ if (vars[n]) { root.style.setProperty(n, vars[n]); applied.push(n); } });
    ueParseRawVars(o.raw).forEach(function(p){ root.style.setProperty(p[0], p[1]); applied.push(p[0]); });
    root.setAttribute('data-ue-vars', applied.join(','));
    var st = document.getElementById('ueOverrideStyle');
    if (!st) { st = document.createElement('style'); st.id = 'ueOverrideStyle'; document.head.appendChild(st); }
    st.textContent = (o.radius != null && o.radius !== '') ? ('.bubble{border-radius:' + parseInt(o.radius, 10) + 'px !important;}') : '';
    applyUIBg(o);
  }

  function applyUIBg(o){
    var bg = o.bg || {}, src = '';
    if (bg.src === '__local__') { src = ueAssetsLoad().bgData || ''; }
    else if (bg.src) { src = bg.src; }
    var layer = document.getElementById('ue-bg-layer');
    if (!src) { if (layer && layer.parentNode) layer.parentNode.removeChild(layer); return; }
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'ue-bg-layer';
      layer.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;background-size:cover;background-position:center;background-repeat:no-repeat;';
      document.body.appendChild(layer);
    }
    layer.style.backgroundImage = 'url("' + String(src) + '")';
    var op = (bg.opacity != null && bg.opacity !== '') ? (parseInt(bg.opacity, 10) / 100) : 1;
    layer.style.opacity = String(isFinite(op) ? op : 1);
    var blur = (bg.blur != null && bg.blur !== '') ? parseInt(bg.blur, 10) : 0;
    layer.style.filter = blur ? ('blur(' + blur + 'px)') : '';
  }

  function ueColorRow(f, vars){
    var v = vars[f.k] || '';
    var hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v) ? v : '#000000';
    return '<div class="ue-ui-row"><span class="ue-ui-label">' + escapeHtml(f.label) + '</span>'
      + '<input type="color" class="ue-ui-color" data-var="' + f.k + '" value="' + hex + '">'
      + '<input type="text" class="ue-ui-hex" data-var="' + f.k + '" value="' + escapeAttr(v) + '" placeholder="' + f.k + '">'
      + '<button class="ue-mini ue-ui-clear" data-var="' + f.k + '" title="清除">✕</button></div>';
  }
  function ueLayoutRow(f, vars){
    var raw = (vars[f.k] || '').replace('px', '');
    var num = raw === '' ? '' : parseInt(raw, 10);
    var mid = Math.round((f.min + f.max) / 2);
    return '<div class="ue-ui-row"><span class="ue-ui-label">' + escapeHtml(f.label) + '</span>'
      + '<input type="range" class="ue-ui-range" data-var="' + f.k + '" min="' + f.min + '" max="' + f.max + '" value="' + (num === '' ? mid : num) + '">'
      + '<input type="number" class="ue-ui-num" data-var="' + f.k + '" min="' + f.min + '" max="' + f.max + '" value="' + num + '" placeholder="默认"><span class="ue-ui-unit">px</span>'
      + '<button class="ue-mini ue-ui-clear" data-var="' + f.k + '" title="清除">✕</button></div>';
  }

  function renderUITab(){
    var t = findTab('ui');
    var body = document.getElementById('ueBody');
    if (!body) return;
    ensureUiTabStyles();
    var o = ueUiLoad(), vars = o.vars || {}, bg = o.bg || {}, au = o.audio || {};
    var h = [];
    h.push('<div class="ue-panel">');
    h.push('<div class="ue-panel-head"><span class="ue-panel-icon">' + t.icon + '</span><span class="ue-panel-name">' + escapeHtml(t.label) + '</span></div>');
    h.push('<p class="ue-panel-desc">全局覆盖（盖在所有主题之上），自动跨设备同步；上传的图片/音频仅存本机。</p>');
    h.push('<div class="ue-ui-sec"><div class="ue-ui-sec-h">🎨 颜色</div>');
    UI_COLOR_FIELDS.forEach(function(f){ h.push(ueColorRow(f, vars)); });
    h.push('</div>');
    h.push('<div class="ue-ui-sec"><div class="ue-ui-sec-h">📐 布局</div>');
    UI_LAYOUT_FIELDS.forEach(function(f){ h.push(ueLayoutRow(f, vars)); });
    h.push('<div class="ue-ui-row"><span class="ue-ui-label">气泡圆角</span>'
      + '<input type="range" class="ue-ui-range" id="ueRadiusRange" min="0" max="32" value="' + (o.radius != null && o.radius !== '' ? parseInt(o.radius, 10) : 16) + '">'
      + '<input type="number" class="ue-ui-num" id="ueRadiusNum" min="0" max="32" value="' + (o.radius != null ? o.radius : '') + '" placeholder="默认"><span class="ue-ui-unit">px</span>'
      + '<button class="ue-mini" id="ueRadiusClear" title="清除">✕</button></div>');
    h.push('</div>');
    h.push('<div class="ue-ui-sec"><div class="ue-ui-sec-h">🖼 背景图</div>');
    h.push('<div class="ue-ui-row"><span class="ue-ui-label">图片 URL</span><input type="text" class="ue-input ue-ui-grow" id="ueBgUrl" placeholder="https://… 或上传本地文件" value="' + escapeAttr(bg.src && bg.src !== '__local__' ? bg.src : '') + '"></div>');
    h.push('<div class="ue-ui-row"><span class="ue-ui-label">上传本地</span><input type="file" id="ueBgFile" accept="image/*"><span class="ue-ui-hint">' + (bg.src === '__local__' ? '已存本机图片' : '仅本机，不上云') + '</span></div>');
    h.push('<div class="ue-ui-row"><span class="ue-ui-label">不透明度</span><input type="range" id="ueBgOpacity" min="0" max="100" value="' + (bg.opacity != null && bg.opacity !== '' ? parseInt(bg.opacity, 10) : 100) + '"><span class="ue-ui-unit" id="ueBgOpacityLbl">' + (bg.opacity != null && bg.opacity !== '' ? bg.opacity : '100') + '%</span></div>');
    h.push('<div class="ue-ui-row"><span class="ue-ui-label">模糊</span><input type="range" id="ueBgBlur" min="0" max="20" value="' + (bg.blur != null && bg.blur !== '' ? parseInt(bg.blur, 10) : 0) + '"><span class="ue-ui-unit" id="ueBgBlurLbl">' + (bg.blur != null && bg.blur !== '' ? bg.blur : '0') + 'px</span></div>');
    h.push('<div class="ue-ui-row"><button class="ue-btn" id="ueBgClear">清除背景图</button></div>');
    h.push('</div>');
    h.push('<div class="ue-ui-sec"><div class="ue-ui-sec-h">🔊 背景声音</div>');
    h.push('<div class="ue-ui-row"><span class="ue-ui-label">音频 URL</span><input type="text" class="ue-input ue-ui-grow" id="ueAudioUrl" placeholder="https://… (需 CORS) 或上传本地" value="' + escapeAttr(au.src && au.src !== '__local__' ? au.src : '') + '"></div>');
    h.push('<div class="ue-ui-row"><span class="ue-ui-label">上传本地</span><input type="file" id="ueAudioFile" accept="audio/*"><span class="ue-ui-hint">' + (au.src === '__local__' ? '已存本机音频' : '仅本机') + '</span></div>');
    h.push('<div class="ue-ui-row"><button class="ue-btn" id="ueAudioClear">清除音源</button></div>');
    h.push('<p class="ue-ui-note">⚠️ 背景声音复用现有「氛围音」系统：仅在 <b>蜜桃/玩偶 (lewd) 主题</b> + 设置里开启音频时播放，音量也在设置面板调；换音源后需<b>刷新页面</b>生效；外链音频须支持 CORS，否则会静音（建议上传本地）。</p>');
    h.push('</div>');
    h.push('<div class="ue-ui-sec"><div class="ue-ui-sec-h">⚙️ 高级：CSS 变量直填</div>');
    h.push('<textarea class="ue-textarea ue-mono" id="ueRawVars" rows="5" placeholder="--bubble-ai: #202030;\n--muted: #aaa;">' + escapeHtml(o.raw || '') + '</textarea>');
    h.push('<div class="ue-ui-row"><button class="ue-btn ue-btn-primary" id="ueRawApply">应用高级变量</button><span class="ue-ui-hint">每行一个 --变量: 值;（行内注入，优先级最高）</span></div>');
    h.push('</div>');
    h.push('<div class="ue-ui-sec"><div class="ue-ui-sec-h">📦 主题 JSON · 还原</div>');
    h.push('<div class="ue-toolbar"><button class="ue-btn" id="ueThemeExport">📤 导出主题</button><button class="ue-btn" id="ueThemeImport">📥 导入主题</button><button class="ue-btn ue-mini danger" id="ueResetAll">↺ 一键还原全部</button></div>');
    h.push('<div class="ue-ui-hint">导出/导入仅含颜色·布局·圆角·高级变量·背景/音源 URL（不含本机上传的大文件）。</div>');
    h.push('<div class="ue-editor-slot" id="ueThemeSlot"></div>');
    h.push('</div>');
    h.push('</div>');
    body.innerHTML = h.join('');
    bindUITab();
  }

  function bindUITab(){
    var body = document.getElementById('ueBody');
    if (!body) return;
    function setVar(k, val){
      var o = ueUiLoad(); o.vars = o.vars || {};
      if (val === '' || val == null) delete o.vars[k]; else o.vars[k] = val;
      ueUiSave(o);
    }
    body.querySelectorAll('.ue-ui-color').forEach(function(el){
      el.addEventListener('input', function(){
        var k = el.getAttribute('data-var'); setVar(k, el.value);
        var hx = body.querySelector('.ue-ui-hex[data-var="' + k + '"]'); if (hx) hx.value = el.value;
      });
    });
    body.querySelectorAll('.ue-ui-hex').forEach(function(el){
      el.addEventListener('change', function(){ setVar(el.getAttribute('data-var'), el.value.trim()); });
    });
    body.querySelectorAll('.ue-ui-range[data-var]').forEach(function(el){
      el.addEventListener('input', function(){
        var k = el.getAttribute('data-var'); setVar(k, el.value + 'px');
        var nm = body.querySelector('.ue-ui-num[data-var="' + k + '"]'); if (nm) nm.value = el.value;
      });
    });
    body.querySelectorAll('.ue-ui-num[data-var]').forEach(function(el){
      el.addEventListener('change', function(){
        var k = el.getAttribute('data-var');
        setVar(k, el.value === '' ? '' : (parseInt(el.value, 10) + 'px'));
      });
    });
    body.querySelectorAll('.ue-ui-clear[data-var]').forEach(function(el){
      el.addEventListener('click', function(){ setVar(el.getAttribute('data-var'), ''); renderUITab(); });
    });
    var rRange = document.getElementById('ueRadiusRange'), rNum = document.getElementById('ueRadiusNum');
    function setRadius(v){ var o = ueUiLoad(); if (v === '' || v == null) delete o.radius; else o.radius = String(parseInt(v, 10)); ueUiSave(o); }
    if (rRange) rRange.addEventListener('input', function(){ if (rNum) rNum.value = rRange.value; setRadius(rRange.value); });
    if (rNum) rNum.addEventListener('change', function(){ setRadius(rNum.value); });
    var rClear = document.getElementById('ueRadiusClear'); if (rClear) rClear.addEventListener('click', function(){ setRadius(''); renderUITab(); });
    var bgUrl = document.getElementById('ueBgUrl');
    if (bgUrl) bgUrl.addEventListener('change', function(){
      var o = ueUiLoad(); o.bg = o.bg || {}; var v = bgUrl.value.trim();
      if (v) { o.bg.src = v; } else if (o.bg.src !== '__local__') { delete o.bg.src; }
      ueUiSave(o);
    });
    var bgFile = document.getElementById('ueBgFile');
    if (bgFile) bgFile.addEventListener('change', function(){
      var f = bgFile.files && bgFile.files[0]; if (!f) return;
      if (f.size > 4 * 1024 * 1024 && !confirm('图片约 ' + Math.round(f.size / 1024) + 'KB，仅存本机不上云，确定？')) { bgFile.value = ''; return; }
      var rd = new FileReader();
      rd.onload = function(){ var as = ueAssetsLoad(); as.bgData = rd.result; ueAssetsSave(as); var o = ueUiLoad(); o.bg = o.bg || {}; o.bg.src = '__local__'; ueUiSave(o); renderUITab(); };
      rd.readAsDataURL(f);
    });
    var bgOp = document.getElementById('ueBgOpacity');
    if (bgOp) bgOp.addEventListener('input', function(){ var o = ueUiLoad(); o.bg = o.bg || {}; o.bg.opacity = bgOp.value; ueUiSave(o); var l = document.getElementById('ueBgOpacityLbl'); if (l) l.textContent = bgOp.value + '%'; });
    var bgBlur = document.getElementById('ueBgBlur');
    if (bgBlur) bgBlur.addEventListener('input', function(){ var o = ueUiLoad(); o.bg = o.bg || {}; o.bg.blur = bgBlur.value; ueUiSave(o); var l = document.getElementById('ueBgBlurLbl'); if (l) l.textContent = bgBlur.value + 'px'; });
    var bgClr = document.getElementById('ueBgClear');
    if (bgClr) bgClr.addEventListener('click', function(){ var o = ueUiLoad(); delete o.bg; ueUiSave(o); var as = ueAssetsLoad(); delete as.bgData; ueAssetsSave(as); renderUITab(); });
    var auUrl = document.getElementById('ueAudioUrl');
    if (auUrl) auUrl.addEventListener('change', function(){ var o = ueUiLoad(); o.audio = o.audio || {}; var v = auUrl.value.trim(); if (v) o.audio.src = v; else if (o.audio.src !== '__local__') delete o.audio.src; ueUiSave(o); });
    var auFile = document.getElementById('ueAudioFile');
    if (auFile) auFile.addEventListener('change', function(){
      var f = auFile.files && auFile.files[0]; if (!f) return;
      if (f.size > 8 * 1024 * 1024 && !confirm('音频约 ' + Math.round(f.size / 1024) + 'KB，仅存本机不上云，确定？')) { auFile.value = ''; return; }
      var rd = new FileReader();
      rd.onload = function(){ var as = ueAssetsLoad(); as.audioData = rd.result; ueAssetsSave(as); var o = ueUiLoad(); o.audio = o.audio || {}; o.audio.src = '__local__'; ueUiSave(o); renderUITab(); alert('已保存本机音频，刷新页面后在 lewd 主题生效'); };
      rd.readAsDataURL(f);
    });
    var auClr = document.getElementById('ueAudioClear');
    if (auClr) auClr.addEventListener('click', function(){ var o = ueUiLoad(); delete o.audio; ueUiSave(o); var as = ueAssetsLoad(); delete as.audioData; ueAssetsSave(as); renderUITab(); });
    var rawApply = document.getElementById('ueRawApply');
    if (rawApply) rawApply.addEventListener('click', function(){ var o = ueUiLoad(); o.raw = (document.getElementById('ueRawVars').value || ''); ueUiSave(o); });
    var exp = document.getElementById('ueThemeExport'); if (exp) exp.addEventListener('click', ueThemeExport);
    var imp = document.getElementById('ueThemeImport'); if (imp) imp.addEventListener('click', ueThemeImport);
    var rst = document.getElementById('ueResetAll');
    if (rst) rst.addEventListener('click', function(){
      if (!confirm('清除所有 UI 覆盖（颜色/布局/圆角/背景/音源/高级变量），恢复主题默认？')) return;
      try { localStorage.removeItem(UI_KEY); localStorage.removeItem(UI_ASSETS_KEY); } catch (e) {}
      applyUIOverrides(); renderUITab();
    });
  }

  function ueThemePortable(){
    var o = ueUiLoad();
    var out = { vars: o.vars || {}, raw: o.raw || '' };
    if (o.radius != null && o.radius !== '') out.radius = o.radius;
    if (o.bg && o.bg.src && o.bg.src !== '__local__') out.bg = { src: o.bg.src, opacity: o.bg.opacity, blur: o.bg.blur };
    if (o.audio && o.audio.src && o.audio.src !== '__local__') out.audio = { src: o.audio.src };
    return out;
  }
  function ueThemeExport(){
    var json = JSON.stringify(ueThemePortable(), null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(function(){ alert('主题 JSON 已复制到剪贴板'); }, function(){ prompt('复制主题 JSON：', json); });
    } else { prompt('复制主题 JSON：', json); }
  }
  function ueThemeImport(){
    var slot = document.getElementById('ueThemeSlot'); if (!slot) return;
    slot.innerHTML = '<div class="ue-editor-card"><div class="ue-editor-head">📥 粘贴主题 JSON（覆盖颜色/布局/圆角/高级/URL 背景音源，不动本机大文件）</div><textarea class="ue-textarea ue-mono" id="ueThemeJson" rows="10"></textarea><div class="ue-editor-foot"><button class="ue-btn ue-btn-primary" id="ueThemeJsonSave">导入</button><button class="ue-btn" id="ueThemeJsonCancel">取消</button></div></div>';
    slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    document.getElementById('ueThemeJsonSave').addEventListener('click', function(){
      var s = document.getElementById('ueThemeJson').value || '';
      try {
        var p = JSON.parse(s);
        if (!p || typeof p !== 'object') throw new Error('顶层必须是对象');
        var o = ueUiLoad();
        o.vars = (p.vars && typeof p.vars === 'object') ? p.vars : {};
        o.raw = typeof p.raw === 'string' ? p.raw : '';
        if (p.radius != null && p.radius !== '') o.radius = String(parseInt(p.radius, 10)); else delete o.radius;
        if (p.bg && p.bg.src) o.bg = { src: p.bg.src, opacity: p.bg.opacity, blur: p.bg.blur };
        else if (!(o.bg && o.bg.src === '__local__')) delete o.bg;
        if (p.audio && p.audio.src) { o.audio = o.audio || {}; o.audio.src = p.audio.src; }
        ueUiSave(o); renderUITab(); alert('主题已导入');
      } catch (e) { alert('JSON 解析失败：' + e.message); }
    });
    document.getElementById('ueThemeJsonCancel').addEventListener('click', function(){ slot.innerHTML = ''; });
  }

  function ensureUiTabStyles(){
    if (document.getElementById('ueUiTabStyles')) return;
    var s = document.createElement('style');
    s.id = 'ueUiTabStyles';
    s.textContent = [
      '.ue-ui-sec { margin: 14px 0; padding: 12px 14px; border: 1px solid rgba(127,127,127,.18); border-radius: 10px; background: rgba(127,127,127,.05); }',
      '.ue-ui-sec-h { font-size: 13px; font-weight: 600; margin-bottom: 8px; opacity: .9; }',
      '.ue-ui-row { display: flex; align-items: center; gap: 10px; margin: 7px 0; flex-wrap: wrap; }',
      '.ue-ui-label { font-size: 12px; opacity: .75; width: 88px; flex: 0 0 88px; }',
      '.ue-ui-color { width: 36px; height: 28px; padding: 0; border: 1px solid rgba(127,127,127,.4); border-radius: 6px; background: transparent; cursor: pointer; }',
      '.ue-ui-hex { width: 120px; padding: 5px 8px; border-radius: 7px; border: 1px solid rgba(127,127,127,.35); background: rgba(0,0,0,.15); color: inherit; font: inherit; font-size: 12px; }',
      '.ue-ui-range { flex: 1; min-width: 120px; }',
      '.ue-ui-num { width: 74px; padding: 5px 8px; border-radius: 7px; border: 1px solid rgba(127,127,127,.35); background: rgba(0,0,0,.15); color: inherit; font: inherit; font-size: 12px; }',
      '.ue-ui-unit { font-size: 12px; opacity: .6; min-width: 36px; }',
      '.ue-ui-grow { flex: 1; min-width: 160px; width: auto; }',
      '.ue-ui-hint { font-size: 11px; opacity: .6; }',
      '.ue-ui-note { font-size: 11.5px; line-height: 1.6; opacity: .8; margin: 8px 0 2px; padding: 8px 10px; border-radius: 8px; background: rgba(255,180,60,.08); border: 1px solid rgba(255,180,60,.25); }'
    ].join('\n');
    document.head.appendChild(s);
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
      '.ue-preset-row { display: grid; grid-template-columns: auto minmax(110px, 200px) 1fr auto; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 8px; background: rgba(127,127,127,.06); border: 1px solid rgba(127,127,127,.18); transition: border-color .15s; }',
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
      '.ue-preset-drag { cursor: grab; opacity: .4; font-size: 15px; user-select: none; }',
      '.ue-preset-row.dragging { opacity: .4; }',
      '.ue-preset-row.dragover { border-color: currentColor; box-shadow: 0 -2px 0 currentColor inset; }',
      '.ue-pgroup-head { display: flex; align-items: center; gap: 8px; margin: 10px 0 4px; padding: 6px 8px; border-radius: 8px; background: rgba(127,127,127,.1); cursor: pointer; user-select: none; }',
      '.ue-pgroup-arrow { width: 14px; opacity: .7; }',
      '.ue-pgroup-name { font-weight: 600; font-size: 13px; }',
      '.ue-pgroup-count { font-size: 11px; opacity: .6; background: rgba(127,127,127,.2); border-radius: 10px; padding: 1px 7px; }',
      '.ue-pgroup-del { margin-left: auto; }',
      '.ue-pgroup-body { display: flex; flex-direction: column; gap: 6px; padding-left: 6px; border-left: 2px solid rgba(127,127,127,.18); margin-bottom: 6px; }',
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
    // 4.22: 外部可调用重新应用 UI 覆盖层
    applyUIOverrides: function(){ try { applyUIOverrides(); } catch (e) {} },
    // 外部强制刷新当前 tab（如 settings 改了 LS 后调用）
    refresh: function(){ if (mask && mask.classList.contains('open')) renderBody(); }
  };
})();