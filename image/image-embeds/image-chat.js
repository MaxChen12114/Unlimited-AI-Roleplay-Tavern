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
      body: JSON.stringify({ prompt: prompt, model: 'z-image-turbo', n: 1, size: '1024x1024' })
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
    fd.append('prompt', prompt);
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
  function characterPrompt() {
    var c = null;
    try { c = (window.__character && window.__character.getActiveCard) ? window.__character.getActiveCard() : null; } catch (e) {}
    var who = '1person';
    if (c && c.gender === 'female') who = '1girl';
    else if (c && c.gender === 'male') who = '1boy';
    var t = ['masterpiece', 'best quality', who, 'portrait', 'looking at viewer', 'detailed face', 'soft lighting'];
    if (c && c.identity) t.push(c.identity);
    if (c && c.personality) t.push(c.personality);
    return t.filter(Boolean).join(', ');
  }
  // 场景 → 「保持同一人」的编辑指令
  function editInstruction(scenePrompt) {
    var s = (scenePrompt || '').trim() || 'taking a casual selfie';
    return 'Keep the SAME person (face, hairstyle, outfit colors, identity) from the source image. Place them in this scene: ' + s + '. Natural casual phone-selfie framing, consistent character, photorealistic.';
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
  async function ensureBase(id, baseImageUrl) {
    if (baseImageUrl) {
      var p0 = await persistToR2(baseImageUrl);
      var m0 = loadBaseMap(); m0[id] = p0; saveBaseMap(m0);
      return p0;
    }
    var existing = await getBaseImage(id);
    if (existing) return existing;
    var raw = await genZImage(characterPrompt());
    var persisted = await persistToR2(raw);
    var m = loadBaseMap(); m[id] = persisted; saveBaseMap(m);
    return persisted;
  }
  async function sendPhoto(args) {
    args = args || {};
    var id = args.characterId || 'default';
    var base = await ensureBase(id, args.baseImageUrl);
    var res = await genEdit(editInstruction(args.scenePrompt), base);
    var imageUrl = await persistToR2(res.fileUrl);
    return { imageUrl: imageUrl, taskId: res.taskId };
  }

  window.__chatImage = { sendPhoto: sendPhoto, setBaseImage: setBaseImage, getBaseImage: getBaseImage };
})();