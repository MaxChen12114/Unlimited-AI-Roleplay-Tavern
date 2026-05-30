// image-chat.js —— 微信发图 · 图像侧契约实现
// 暴露 window.__chatImage = { sendPhoto, setBaseImage, getBaseImage }
// 文本侧(chat-image.js / window.__chatImageText)检测到本对象后自动从 mock 切真图。
// 流程:基准图(z-image-turbo 首次造并锁定)× Qwen-Image-Edit-2511(保持同一人)→ 转存 R2 → 同源直链。
(function () {
  if (window.__chatImage) return;

  // ── key / 鉴权(对齐 image-quickgen 约定)──
  function getKey() {
    try { return localStorage.getItem('cfw_image_key_v1') || localStorage.getItem('moark_api_key') || ''; }
    catch (e) { return ''; }
  }
  function authHeaders(extra) {
    var h = extra || {};
    var k = getKey();
    if (k) h['Authorization'] = 'Bearer ' + k;
    return h;
  }
  // R2 写入带云同步 token(= CHAT_PASSWORD),复用画廊那套
  function syncToken() { try { return (window.__auth && window.__auth.getToken && window.__auth.getToken()) || ''; } catch (e) { return ''; } }
  function syncHeaders(extra) { var h = extra || {}; var t = syncToken(); if (t) h['Authorization'] = 'Bearer ' + t; return h; }
  function dlFetch(u) { return fetch('/img/dl?url=' + encodeURIComponent(u)); }

  // ── 基准图存储:characterId -> 同源持久链 ──
  var LS_BASE = 'cfw_chat_base_v1';
  function loadBaseMap() { try { return JSON.parse(localStorage.getItem(LS_BASE) || '{}') || {}; } catch (e) { return {}; } }
  function saveBaseMap(m) { try { localStorage.setItem(LS_BASE, JSON.stringify(m)); } catch (e) {} }
  function readCharId(args) {
    if (typeof args === 'string') return args || 'default';
    return (args && args.characterId) || 'default';
  }

  // 把任意图转存 R2 拿同源直链;未绑 R2(501)或失败 → 原链兜底
  async function persistToR2(srcUrl) {
    if (!srcUrl) return srcUrl;
    if (srcUrl.indexOf('/img/r2/get') === 0) return srcUrl;
    if (srcUrl.indexOf('data:') === 0) return srcUrl;
    try {
      var r = await fetch('/img/r2/save?url=' + encodeURIComponent(srcUrl), { method: 'POST', headers: syncHeaders() });
      if (r.ok) { var j = await r.json(); return j.url || srcUrl; }
    } catch (e) {}
    return srcUrl;
  }

  // ── 出图原语(对齐 image-quickgen 真实调用)──
  async function genZImage(prompt) {
    var r = await fetch('/img/v1/images/generations', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prompt: withStyle(prompt), model: 'z-image-turbo', n: 1, size: '1024x1024' })
    });
    if (!r.ok) throw new Error('基准图生成失败 ' + r.status);
    var j = await r.json();
    var arr = (j.data || []).map(function (d) { return d.url || (d.b64_json ? 'data:image/png;base64,' + d.b64_json : ''); }).filter(Boolean);
    if (!arr.length) throw new Error('基准图无返回');
    return arr[0];
  }
  async function pollTask(taskId) {
    var start = Date.now();
    var TIMEOUT = 30 * 60 * 1000;
    while (true) {
      if (Date.now() - start > TIMEOUT) throw new Error('出图超时');
      await new Promise(function (rs) { setTimeout(rs, 6000); });
      var pr = await fetch('/img/v1/task/' + encodeURIComponent(taskId), { headers: authHeaders({}) });
      if (!pr.ok) throw new Error('轮询失败 ' + pr.status);
      var pj = await pr.json();
      var status = pj.status || pj.state || (pj.output ? 'success' : '');
      var fileUrl = (pj.output && pj.output.file_url) ||
        (pj.raw && pj.raw.output && pj.raw.output.file_url) ||
        (pj.data && pj.data[0] && pj.data[0].url);
      if (fileUrl) return fileUrl;
      if (status && /fail|error|cancel/i.test(status)) throw new Error('任务失败:' + status);
    }
  }
  async function genEdit(prompt, srcUrl) {
    var blob = await (await dlFetch(srcUrl)).blob();
    var fd = new FormData();
    fd.append('prompt', withStyle(prompt));
    fd.append('model', 'Qwen-Image-Edit-2511');
    fd.append('num_inference_steps', '4');
    fd.append('guidance_scale', '1.0');
    fd.append('image', blob, 'base.png');
    var r = await fetch('/img/v1/async/images/edits', { method: 'POST', headers: authHeaders({}), body: fd });
    if (!r.ok) throw new Error('改图提交失败 ' + r.status);
    var j = await r.json();
    var taskId = j.id || j.task_id || (j.data && (j.data.id || j.data.task_id));
    if (!taskId) throw new Error('未取到任务 id');
    var fileUrl = await pollTask(taskId);
    return { fileUrl: fileUrl, taskId: taskId };
  }

  // ── 首次造基准图的角色 prompt(尽量取角色卡)──
  // 4.26 fix「不对应角色」: 按 characterId 精确取卡(多角色场景不再误用 active card);
  // 性别从自由文本(女/男/female...)或角色名映射;prompt 带上角色名/身份/性格,避免退化成通用路人。
  function findCardById(id) {
    var ch = window.__character;
    try {
      if (id && id !== 'default' && id !== '__none__' && ch) {
        var list = (ch.listAllCards ? ch.listAllCards() : []) || [];
        var hit = list.filter(function (c) { return c && c.id === id; })[0];
        if (hit) return hit;
        var arch = ch.archetypes || [];
        var ah = arch.filter(function (c) { return c && c.id === id; })[0];
        if (ah) return ah;
      }
      return (ch && ch.getActiveCard) ? ch.getActiveCard() : null;
    } catch (e) { return null; }
  }
  function mapWho(card) {
    var s = (((card && card.gender) || '') + ' ' + ((card && card.name) || '')).toLowerCase();
    if (/女|girl|female|woman/.test(s)) return '1girl';
    if (/男|boy|male|man/.test(s)) return '1boy';
    return '1person';
  }
  function characterPrompt(card) {
    var c = card || null;
    var t = ['masterpiece', 'best quality', 'highly detailed', mapWho(c), 'solo', 'portrait', 'looking at viewer', 'detailed face', 'soft natural lighting'];
    if (c) {
      if (c.name) t.push('character: ' + c.name);
      if (c.identity) t.push(c.identity);
      if (c.personality) t.push(c.personality + ' vibe');
    }
    return t.filter(Boolean).join(', ');
  }
  // 场景 → 「保持同一人」的编辑指令
  // 按场景词智能选机位:全身/远景/特写/默认自拍
  function pickFraming(s) {
    var t = (s || '').toLowerCase();
    if (/full body|full-body|head to toe|whole body|全身|站姿|全身照/.test(t))
      return 'full-body shot, head to toe visible, natural standing or action pose';
    if (/wide shot|landscape|scenery|far away|street|远景|风景|环境|街道|城市|海边|广角/.test(t))
      return 'wide environmental shot, subject placed within a detailed scene, cinematic framing';
    if (/close[- ]?up|特写|脸部|大头|面部/.test(t))
      return 'close-up portrait, face and shoulders, shallow depth of field';
    return 'natural casual phone-selfie framing, upper body';
  }
  // 全局画风:读 image-portrait 托管的 cfw_image_style_v1,追加到出图/改图提示词末尾
  function styleSuffix() { try { var t = window.__portrait && window.__portrait.getStyleTags && window.__portrait.getStyleTags(); return (t || '').trim(); } catch (e) { return ''; } }
  function withStyle(p) { var st = styleSuffix(); return st ? ((p || '') + ', ' + st) : (p || ''); }
  function editInstruction(scenePrompt) {
    var s = (scenePrompt || '').trim() || 'taking a casual selfie';
    return 'Keep the SAME person (face, hairstyle, outfit colors, identity) from the source image. Place them in this scene: ' + s + '. ' + pickFraming(s) + ', consistent character.';
  }

  // ── 契约 ──
  async function getBaseImage(args) {
    var id = readCharId(args);
    var m = loadBaseMap();
    return m[id] || null;
  }
  async function setBaseImage(args) {
    var id = readCharId(args);
    var imageUrl = args && args.imageUrl;
    if (!imageUrl) return;
    var persisted = await persistToR2(imageUrl);
    var m = loadBaseMap(); m[id] = persisted; saveBaseMap(m);
  }
  async function ensureBase(id, baseImageUrl, card) {
    if (baseImageUrl) {
      var p0 = await persistToR2(baseImageUrl);
      var m0 = loadBaseMap(); m0[id] = p0; saveBaseMap(m0);
      return p0;
    }
    var existing = await getBaseImage(id);
    if (existing) return existing;
    var raw = await genZImage(characterPrompt(card));
    var persisted = await persistToR2(raw);
    var m = loadBaseMap(); m[id] = persisted; saveBaseMap(m);
    return persisted;
  }
  async function editImage(args) {
    args = args || {};
    var id = args.characterId || 'default';
    var card = findCardById(id);
    var instruction = args.instruction || editInstruction(args.scenePrompt);
    var base = await ensureBase(id, args.baseImageUrl, card);
    var res = await genEdit(instruction, base);
    var imageUrl = await persistToR2(res.fileUrl);
    return { imageUrl: imageUrl, taskId: res.taskId };
  }
  async function sendPhoto(args) {
    args = args || {};
    return editImage({ characterId: args.characterId || 'default', baseImageUrl: args.baseImageUrl, instruction: editInstruction(args.scenePrompt) });
  }

  window.__chatImage = { sendPhoto: sendPhoto, editImage: editImage, setBaseImage: setBaseImage, getBaseImage: getBaseImage };
})();