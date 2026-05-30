// public/chat-image.js — 微信发图 · 文本侧编排 (raw / 可独立测试版)
// 配合图像侧 window.__chatImage 契约 (sendPhoto/setBaseImage/getBaseImage)。
// 契约未上线时走内置 mock(SVG 占位图),整条链路可独立测。
// 红线:不碰图像侧文件;不动核心人格 prompt —— 发图指令仅走独立注入层(追加在 extraSystemPrompts 末尾)。
(function () {
  "use strict";

  // ─── LS keys(全部 cfw_ 前缀 _v1 后缀;仅本机,不进云同步)───
  var LS_ENABLED  = "cfw_chat_image_enabled_v1";   // 功能总开关(默认关)
  var LS_COOLDOWN = "cfw_chat_image_cooldown_v1";  // 软冷却秒(默认60)
  var LS_CAP      = "cfw_chat_image_cap_v1";       // 每会话上限(默认6,0=不限)
  var LS_BASE     = "cfw_chat_image_base_v1";      // 本地基准图兜底 {charId:dataURL}
  var LS_LASTAT   = "cfw_chat_image_lastat_v1";    // 上次发图时间戳
  var LS_COUNT    = "cfw_chat_image_count_v1";     // {slotKey:count} 每会话计数

  var SIGNAL_RE = /\[{1,2}发图[:：]([^\]]*)\]{1,2}/g;        // [[发图:场景]] 双括号(中英文冒号都吃)

  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function isEnabled() { return lsGet(LS_ENABLED, "0") === "1"; }
  function cooldownSec() { var n = parseInt(lsGet(LS_COOLDOWN, "20"), 10); return isNaN(n) ? 20 : Math.max(0, n); }
  function capPerChat() { var n = parseInt(lsGet(LS_CAP, "6"), 10); return isNaN(n) ? 6 : Math.max(0, n); }

  function slotKey() {
    try { var c = window.__character && window.__character.getActiveCard && window.__character.getActiveCard(); return c && c.id ? c.id : "__none__"; } catch (e) { return "__none__"; }
  }
  function getCounts() { try { var o = JSON.parse(lsGet(LS_COUNT, "{}")); return (o && typeof o === "object") ? o : {}; } catch (e) { return {}; } }
  function chatCount() { return getCounts()[slotKey()] || 0; }
  function bumpCount() { var o = getCounts(); o[slotKey()] = (o[slotKey()] || 0) + 1; lsSet(LS_COUNT, JSON.stringify(o)); }
  function resetCount() { var o = getCounts(); o[slotKey()] = 0; lsSet(LS_COUNT, JSON.stringify(o)); }

  // ─── 独立注入层:发图能力指令,追加到核心 prompt 之后(经 extraSystemPrompts)───
  function getInjection() {
    if (!isEnabled()) return "";
    return "\n\n【发图能力】当对话情景适合「发一张自拍/照片」时(对方想看照片、你想分享当下场景、气氛合适),你可以在整条回复的最末尾追加一个发图信号:[发图:简短场景描述]。场景用一句话写清画面(人物姿态/表情/穿着/环境/光线),只描述这一张照片,不写其他内容。信号用方括号包裹且放在消息最后(单双括号都可识别,单括号即可)。不需要发图时完全不要输出此信号;不要每条都发,每隔几轮最多一次。";
  }

  // ─── 从 AI 完整回复抠出发图信号 + 返回清理后的正文(取最后一个信号)───
  function extractSignal(text) {
    if (!text || typeof text !== "string") return { scene: null, clean: text };
    SIGNAL_RE.lastIndex = 0;
    var scene = null, m;
    while ((m = SIGNAL_RE.exec(text)) !== null) { scene = (m[1] || "").trim(); }
    if (scene == null) return { scene: null, clean: text };
    var clean = text.replace(SIGNAL_RE, "").replace(/[\s\r\n|]+$/, "");
    return { scene: scene, clean: clean };
  }

  // ─── 基准图存取(优先图像侧契约,缺省走本地兜底)───
  function getBaseImage(charId) {
    if (window.__chatImage && window.__chatImage.getBaseImage) {
      try { return Promise.resolve(window.__chatImage.getBaseImage({ characterId: charId })); } catch (e) {}
    }
    try { var o = JSON.parse(lsGet(LS_BASE, "{}")); return Promise.resolve((o && o[charId]) || null); } catch (e) { return Promise.resolve(null); }
  }
  function setBaseImage(charId, imageUrl) {
    if (window.__chatImage && window.__chatImage.setBaseImage) {
      try { return Promise.resolve(window.__chatImage.setBaseImage({ characterId: charId, imageUrl: imageUrl })); } catch (e) {}
    }
    try { var o = JSON.parse(lsGet(LS_BASE, "{}")); if (!o || typeof o !== "object") o = {}; o[charId] = imageUrl; lsSet(LS_BASE, JSON.stringify(o)); } catch (e) {}
    return Promise.resolve();
  }

  // ─── 扩写编排(raw:本地模板;TODO 接图像侧 gpt-oss-120b 免费扩写链路)───
  function pickFreeModel() {
    try { var list = window.APP_MODELS_FREE || []; for (var i = 0; i < list.length; i++) { if ((list[i].id || '').indexOf('gpt-oss') >= 0) return list[i].id; } } catch (e) {}
    return 'openai/gpt-oss-120b';
  }
  var EXPAND_SYS = 'You are an image-prompt engineer for an instruction-based image-edit model that keeps the SAME person from a base selfie. Given a short Chinese scene note, output ONE single-line English description of pose, facial expression, outfit, location/background, lighting, mood, and a camera framing that fits the scene (close selfie, full-body, or wide environmental shot as appropriate). Do NOT describe face or identity (the base photo fixes those). Output ONLY the description, no quotes.';
  function localExpand(scene, card) {
    var name = (card && card.name) ? card.name : "角色";
    var look = (card && (card.identity || card.personality)) ? ("," + (card.identity || card.personality)) : "";
    return Promise.resolve("一张" + name + "的自拍照" + look + "。画面:" + scene + "。写实、自然光、手机自拍视角、清晰。");
  }

  // ─── 出图(优先契约,缺省 mock)───
  // expander: free gpt-oss-120b expands the Chinese 发图 signal into an English selfie-scene description; falls back to local template on failure / standalone.
  async function expandScene(scene, card) {
    var fallback = localExpand(scene, card);
    try {
      var note = scene;
      if (card) { var cap = function (x) { x = String(x || ''); return x.length > 200 ? x.slice(0, 200) : x; }; var c = []; if (card.name) c.push('role:' + cap(card.name)); if (card.identity) c.push('identity:' + cap(card.identity)); if (card.personality) c.push('persona:' + cap(card.personality)); if (c.length) note = c.join(', ') + ' / scene:' + scene; }
      var res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'free', model: pickFreeModel(), use_builtin_persona: false, custom_system_prompt: EXPAND_SYS, replyStyle: 'default', messages: [{ role: 'user', content: note }] }) });
      if (!res.ok) return fallback;
      var reader = res.body.getReader(), dec = new TextDecoder(), out = '';
      while (true) { var stp = await reader.read(); if (stp.done) break; var lines = dec.decode(stp.value, { stream: true }).split('\n'); for (var i = 0; i < lines.length; i++) { var ln = lines[i]; if (ln.indexOf('data: ') !== 0) continue; var ss = ln.slice(6).trim(); if (!ss || ss === '[DONE]') continue; try { var pj = JSON.parse(ss); var d = pj.choices && pj.choices[0] && pj.choices[0].delta && pj.choices[0].delta.content; if (d) out += d; } catch (e) {} } }
      out = out.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
      return out || fallback;
    } catch (e) { return fallback; }
  }
  function callSendPhoto(charId, scenePrompt, baseImageUrl) {
    if (window.__chatImage && window.__chatImage.sendPhoto) {
      return Promise.resolve(window.__chatImage.sendPhoto({ characterId: charId, scenePrompt: scenePrompt, baseImageUrl: baseImageUrl }));
    }
    return new Promise(function (resolve) {
      setTimeout(function () { resolve({ imageUrl: mockImage(scenePrompt), taskId: "mock-" + Date.now() }); }, 1500);
    });
  }
  function mockImage(text) {
    var t = String(text || "");
    var lines = [], i = 0;
    while (i < t.length && lines.length < 7) { lines.push(t.slice(i, i + 16)); i += 16; }
    var esc = function (s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
    var tspans = lines.map(function (ln, k) { return '<tspan x="160" dy="' + (k === 0 ? 0 : 22) + '">' + esc(ln) + '</tspan>'; }).join("");
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="400">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7d4fcc"/><stop offset="1" stop-color="#cc4f7d"/></linearGradient></defs>' +
      '<rect width="320" height="400" fill="url(#g)"/>' +
      '<text x="160" y="46" fill="#fff" font-size="15" text-anchor="middle" opacity="0.9">📷 模拟出图 (mock)</text>' +
      '<text x="160" y="150" fill="#fff" font-size="13" text-anchor="middle" opacity="0.95">' + tspans + '</text>' +
      '</svg>';
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  }

  // ─── 图片气泡(占位 → 替换),挂在触发的 AI row 之后 ───
  function loadingHtml() {
    return '<div style="display:flex;align-items:center;gap:8px;opacity:.75;font-size:13px;"><span style="width:14px;height:14px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;display:inline-block;animation:ci-spin .8s linear infinite;"></span><span>正在发送图片…</span></div>';
  }
  function renderPhotoBubble(afterRow, card) {
    var chat = document.getElementById("chat");
    var spacer = document.getElementById("bottom-spacer");
    if (!chat) return null;
    ensureSpinCss();
    var row = document.createElement("div");
    row.className = "row ai chat-image-row";
    var avatar = document.createElement("div");
    avatar.className = "avatar bot";
    avatar.textContent = (card && card.icon) ? card.icon : "🙂";
    if (card && card.name) avatar.title = card.name;
    var content = document.createElement("div");
    content.className = "content";
    var bubble = document.createElement("div");
    bubble.className = "bubble ai chat-image-bubble";
    bubble.style.minWidth = "140px";
    bubble.innerHTML = loadingHtml();
    content.appendChild(bubble);
    row.appendChild(avatar);
    row.appendChild(content);
    if (afterRow && afterRow.parentNode === chat && afterRow.nextSibling) chat.insertBefore(row, afterRow.nextSibling);
    else if (spacer) chat.insertBefore(row, spacer);
    else chat.appendChild(row);
    scrollChat();
    return bubble;
  }
  function setBubbleImage(bubble, imageUrl) {
    if (!bubble) return;
    bubble.innerHTML = "";
    var img = document.createElement("img");
    img.src = imageUrl;
    img.alt = "AI 发来的照片";
    img.style.cssText = "max-width:220px;max-height:300px;border-radius:10px;display:block;cursor:zoom-in;";
    img.addEventListener("click", function () { window.open(imageUrl, "_blank"); });
    bubble.appendChild(img);
    scrollChat();
  }
  function setBubbleError(bubble, retryFn) {
    if (!bubble) return;
    bubble.innerHTML = "";
    var box = document.createElement("div");
    box.style.cssText = "display:flex;align-items:center;gap:8px;font-size:13px;color:#c66;";
    var txt = document.createElement("span"); txt.textContent = "发送失败";
    var btn = document.createElement("button"); btn.textContent = "点重试"; btn.className = "smallbtn"; btn.style.cssText = "font-size:12px;padding:2px 8px;";
    btn.addEventListener("click", function () { if (retryFn) retryFn(); });
    box.appendChild(txt); box.appendChild(btn); bubble.appendChild(box);
  }
  function ensureSpinCss() {
    if (document.getElementById("ci-spin-css")) return;
    var s = document.createElement("style"); s.id = "ci-spin-css";
    s.textContent = "@keyframes ci-spin{to{transform:rotate(360deg)}}";
    document.head.appendChild(s);
  }
  function scrollChat() {
    var hw = document.getElementById("history");
    if (hw) { try { hw.scrollTo({ top: hw.scrollHeight, behavior: "auto" }); } catch (e) { hw.scrollTop = hw.scrollHeight; } }
  }

  // ─── 主流程:收到发图信号后编排出图。manual=true 绕过冷却/上限(用户手动叫)───
  function handleSignal(opts) {
    opts = opts || {};
    var scene = opts.scene;
    var card = opts.card || (window.__character && window.__character.getActiveCard && window.__character.getActiveCard()) || null;
    var afterRow = opts.afterRow || null;
    var manual = !!opts.manual;
    if (!scene) return;
    if (!isEnabled() && !manual) return;
    if (!manual) {
      var now = Date.now();
      var last = parseInt(lsGet(LS_LASTAT, "0"), 10) || 0;
      if (cooldownSec() > 0 && now - last < cooldownSec() * 1000) return;     // 软冷却内,丢弃本次主动发图
      if (capPerChat() > 0 && chatCount() >= capPerChat()) return;            // 本会话已达上限
    }
    var charId = card && card.id ? card.id : "__none__";
    lsSet(LS_LASTAT, String(Date.now()));
    if (!manual) bumpCount();

    var bubble = renderPhotoBubble(afterRow, card);
    var done = false, timer = null, timeoutMs = 30000, baseImg = null;

    function arm() { done = false; clearTimeout(timer); timer = setTimeout(function () { if (done) return; done = true; setBubbleError(bubble, retry); }, timeoutMs); }
    function retry() { if (bubble) bubble.innerHTML = loadingHtml(); arm(); runSend(); }
    function runSend() {
      Promise.resolve(callSendPhoto(charId, opts.scenePrompt || scene, baseImg || undefined)).then(function (res) {
        if (done) return; done = true; clearTimeout(timer);
        var url = res && res.imageUrl;
        if (url) setBubbleImage(bubble, url); else setBubbleError(bubble, retry);
      }).catch(function () {
        if (done) return; done = true; clearTimeout(timer); setBubbleError(bubble, retry);
      });
    }
    // 先探基准图:无基准图(首次需先造图,图像侧称可能 30-45s)→ 占位超时放宽到 45s,否则 30s
    Promise.resolve(getBaseImage(charId)).then(function (base) {
      baseImg = base; timeoutMs = base ? 30000 : 45000;
    }).catch(function () {}).then(function () {
      arm();
      return expandScene(scene, card);
    }).then(function (p) { opts.scenePrompt = p; runSend(); })
      .catch(function () { opts.scenePrompt = scene; runSend(); });
  }

  // 手动叫一张图(给 Settings 按钮用)
  function requestManual(sceneText) {
    var scene = (sceneText && String(sceneText).trim()) || "随手自拍,自然表情";
    var rows = document.querySelectorAll("#chat .row.ai");
    var last = rows.length ? rows[rows.length - 1] : null;
    handleSignal({ scene: scene, afterRow: last, manual: true });
  }

  // ─── Settings 卡 wiring(index.html 新增 #chatImageCard 内的控件)───
  function wireSettings() {
    var en = document.getElementById("ciEnableToggle");
    if (en) { en.checked = isEnabled(); en.addEventListener("change", function () { lsSet(LS_ENABLED, en.checked ? "1" : "0"); }); }
    var cd = document.getElementById("ciCooldown");
    if (cd) { cd.value = cooldownSec(); cd.addEventListener("change", function () { lsSet(LS_COOLDOWN, String(parseInt(cd.value, 10) || 60)); }); }
    var cap = document.getElementById("ciCap");
    if (cap) { cap.value = capPerChat(); cap.addEventListener("change", function () { lsSet(LS_CAP, String(parseInt(cap.value, 10) || 0)); }); }
    var up = document.getElementById("ciBaseUpload");
    if (up) up.addEventListener("change", function () {
      var f = up.files && up.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        var charId = slotKey();
        setBaseImage(charId, rd.result);
        var st = document.getElementById("ciBaseStatus");
        if (st) st.textContent = "✅ 已为当前角色(" + charId + ")设置基准图";
      };
      rd.readAsDataURL(f);
      up.value = "";
    });
    var mq = document.getElementById("ciManualBtn");
    if (mq) mq.addEventListener("click", function () { requestManual(""); });
  }

  window.__chatImageText = {
    getInjection: getInjection,
    extractSignal: extractSignal,
    handleSignal: handleSignal,
    requestManual: requestManual,
    getBaseImage: getBaseImage,
    setBaseImage: setBaseImage,
    isEnabled: isEnabled,
    resetChatCount: resetCount,
    _mock: mockImage,
  };

  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", wireSettings);
  else wireSettings();
})();