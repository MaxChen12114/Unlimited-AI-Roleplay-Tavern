// public/multi-agent.js — 多智能体场景模块
// 拆自 character.js（场景成员+模式开关）+ app.js（scene-strip 渲染）+ topbar-controls.js（顶栏按钮）
// 单一职责：管「谁在场景里 / 当前是不是多人模式 / scene-strip UI / 顶栏切换按钮」
// 依赖：window.__character.listAllCards() 拿全部卡 + window.__character.archetypes 兜底
// 事件：
//   window 'multi-agent:changed' detail = { isMulti, sceneIds }
//   同时向后兼容派发 'character:changed' 让 character.js UI 自动 rerender
(function () {
"use strict";
const LSMM = "tavern_multi_agent_mode_v1"; // "single" | "multi"，默认 single
const LSAS = "tavern_active_scene_v1";     // 场景成员 cardId 数组
const LSHINT = "cfw_multi_agent_hint_seen";
const LSA = "tavern_active_char_id";

function emit() {
  const detail = { isMulti: isMulti(), sceneIds: getSceneIds() };
  window.dispatchEvent(new CustomEvent("multi-agent:changed", { detail }));
  // 向后兼容：character.js UI 仍在监听 character:changed
  window.dispatchEvent(new CustomEvent("character:changed"));
}

// ── 模式开关 ──
function isMulti() { return localStorage.getItem(LSMM) === "multi"; }
function setMulti(b) {
  localStorage.setItem(LSMM, b ? "multi" : "single");
  emit();
}

// ── 场景成员管理 ──
function getSceneIds() {
  try {
    const r = JSON.parse(localStorage.getItem(LSAS) || "[]");
    return Array.isArray(r) ? r.filter(x => typeof x === "string" && x) : [];
  } catch { return []; }
}
function setSceneIds(ids) {
  localStorage.setItem(LSAS, JSON.stringify(Array.isArray(ids) ? ids : []));
  emit();
}
function isInScene(id) { return getSceneIds().includes(id); }
function addToScene(id) {
  if (!id) return;
  const a = getSceneIds();
  if (!a.includes(id)) { a.push(id); setSceneIds(a); }
}
function removeFromScene(id) {
  if (!id) return;
  const a = getSceneIds().filter(x => x !== id);
  setSceneIds(a);
  const cur = localStorage.getItem(LSA) || "";
  if (cur === id && window.__character && window.__character.setActiveId) {
    window.__character.setActiveId(a[0] || "");
  }
}
function getSceneCards() {
  const ids = getSceneIds();
  if (!ids.length) return [];
  const ch = window.__character;
  const all = (ch && ch.listAllCards) ? ch.listAllCards() : [];
  const archs = (ch && ch.archetypes) ? ch.archetypes : [];
  const map = new Map(all.map(c => [c.id, c]));
  return ids.map(id => map.get(id) || archs.find(x => x.id === id)).filter(Boolean);
}
function getSceneOtherNames() {
  if (!isMulti()) return [];
  const ids = getSceneIds();
  if (ids.length < 2) return [];
  const cur = localStorage.getItem(LSA) || "";
  const cards = getSceneCards();
  const map = new Map(cards.map(c => [c.id, c]));
  return ids.filter(id => id !== cur).map(id => (map.get(id) || {}).name || "").filter(Boolean);
}

window.__multi = {
  isMulti, setMulti,
  getSceneIds, isInScene, addToScene, removeFromScene,
  getSceneCards, getSceneOtherNames,
};

// ── scene-strip 渲染（输入框上方的「下一句由谁说」选择条）──
// 4.18 (v5): 用户要求删除——改用智能编排(AI 喊名字自动接力发言),strip 多余
// 函数保留为兜底:若 DOM 里已存在 strip(老 session 残留)就清理,后续永远不再渲染
function renderSceneStrip() {
  const oldStrip = document.getElementById("sceneStrip");
  if (oldStrip && oldStrip.parentNode) oldStrip.parentNode.removeChild(oldStrip);
  if (window.__app && window.__app.updateSpacer) window.__app.updateSpacer();
  return;
  /* dead code 保留备查
  const float = document.querySelector(".input-floating");
  if (!float) return;
  let strip = document.getElementById("sceneStrip");
  const cards = getSceneCards();
  if (!cards || cards.length < 2) {
    if (strip) strip.style.display = "none";
    if (window.__app && window.__app.updateSpacer) window.__app.updateSpacer();
    return;
  }
  const _fb = window.__fishbowl;
  const _fbMode = _fb ? _fb.getMode() : "orchestrate";
  if (_fbMode === "relay" || _fbMode === "discuss") {
    if (strip) strip.style.display = "none";
    if (window.__app && window.__app.updateSpacer) window.__app.updateSpacer();
    return;
  }
  if (!strip) {
    strip = document.createElement("div");
    strip.id = "sceneStrip";
    strip.className = "scene-strip";
    float.insertBefore(strip, float.firstChild);
  }
  strip.style.display = "";
  const ch = window.__character;
  const activeId = ((ch && ch.getActiveCard && ch.getActiveCard()) || {}).id || "";
  const isLight = localStorage.getItem("my-theme") === "light";
  strip.style.cssText = "display:flex;gap:6px;padding:4px 8px;overflow-x:auto;background:" + (isLight ? "#fff" : "#0f0f0f") + ";border:1px solid " + (isLight ? "#e0e0e0" : "#2a2a2a") + ";border-radius:8px;margin-bottom:6px;align-items:center;font-size:12px;";
  const safe = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  strip.innerHTML = `<span style="color:#888;font-size:11px;white-space:nowrap;">下一句由：</span>` + cards.map(c => {
    const act = c.id === activeId;
    const border = isLight ? (act ? "#7d4fcc" : "#ddd") : (act ? "#a06fff" : "#333");
    const bg = isLight ? (act ? "#f0e6ff" : "#fafafa") : (act ? "#2a1a3a" : "#141414");
    const fg = isLight ? "#111" : "#eaeaea";
    return `<button class="scene-member${act ? " active" : ""}" data-sid="${safe(c.id)}" style="display:flex;align-items:center;gap:4px;padding:3px 8px;border-radius:14px;border:1px solid ${border};background:${bg};color:${fg};cursor:pointer;white-space:nowrap;font-size:12px;${act ? "font-weight:600;" : ""}"><span>${safe(c.icon || "\u{1F642}")}</span><span>${safe(c.name)}</span></button>`;
  }).join("");
  strip.querySelectorAll("[data-sid]").forEach(el => {
    el.addEventListener("click", () => {
      const sid = el.dataset.sid;
      if (ch && ch.setActiveId) ch.setActiveId(sid);
      // 鱼缸 V3:群聊 mode(orchestrate) 下点击角色 chip = 立即让该角色发言
      // 不再需要发空消息跳发 + 消灭空 User 气泡污染观感
      const fb = window.__fishbowl;
      const isGroupMode = !fb || fb.getMode() === "orchestrate";
      const card = cards.find(c => c.id === sid);
      if (isGroupMode && card && window.__app && window.__app.sendOne) {
        window.__app.sendOne({ allowEmptyText: true, asCard: card });
      }
      setTimeout(renderSceneStrip, 30);
    });
  });
  if (window.__app && window.__app.updateSpacer) window.__app.updateSpacer();
  */
}

// ── 顶栏 #multiAgentToggle 按钮 ──
function wireTopbarToggle() {
  const btn = document.getElementById("multiAgentToggle");
  if (!btn) return;
  function refresh() {
    const on = isMulti();
    // 4.3:兼容 sidebar-btn 结构(优先更新 .sidebar-btn-icon span,否则退回 textContent)
    const iconEl = btn.querySelector(".sidebar-btn-icon");
    if (iconEl) iconEl.textContent = on ? "👥" : "🧑";
    else btn.textContent = on ? "👥" : "🧑";
    // 4.18 (v5): label 同步切换——未启用时显示「单智能体」更直觉
    const labelEl = btn.querySelector(".sidebar-btn-label");
    if (labelEl) labelEl.textContent = on ? "多智能体" : "单智能体";
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  refresh();
  btn.addEventListener("click", () => {
    const next = !isMulti();
    setMulti(next);
    refresh();
    if (next && !localStorage.getItem(LSHINT)) {
      try { localStorage.setItem(LSHINT, "1"); } catch (e) {}
      setTimeout(() => {
        alert("已切换为多人场景模式。\n\n玩法：\n① 点 🎭 打开角色面板 →「我的」标签 → 点多张卡的「+场景」加成员\n② 输入框上方会出现发言者选择条（≥2 人时），点头像切换「下一句谁说」\n③ AI 能看见历史里其他角色的发言但只代表当前选中者回复\n④ 道具卡 / 好感度 / 提示词预设都按当前发言者处理");
      }, 100);
    }
  });
  window.addEventListener("multi-agent:changed", refresh);
  window.addEventListener("character:changed", refresh);
}

// ─── 鱼缸 V3:右侧悬浮控制台 + body[data-chat-mode] 二分视觉 + ended 态保留 ───
// 群聊 mode(orchestrate)→ data-chat-mode="group",AI 全左/用户右
// 吐槽姬 mode(relay|discuss)→ data-chat-mode="roast",AI 偶左奇右交替,用户位隐藏
// 结束后 ended 状态卡保留至用户点「✨ 新一轮」/「× 关闭」
function getFishbowl() { return window.__fishbowl || null; }

function endReasonLabel(r) {
  return ({
    max: "达到最大轮数",
    "end-tag": "AI 触发 [end] 标签",
    stop: "手动终止",
    error: "运行出错",
  })[r] || (r || "—");
}

function syncChatMode(mode) {
  const isRoast = (mode === "relay" || mode === "discuss");
  document.body.setAttribute("data-chat-mode", isRoast ? "roast" : "group");
  const inputEl = document.getElementById("msg");
  if (inputEl) {
    inputEl.placeholder = isRoast
      ? "💬 主持人/旁白介入(可选)"
      : "Message...";
  }
}

function handleFbModeChip(next) {
  const fb = getFishbowl();
  if (!fb) { alert("鱼缸引擎未加载(fishbowl-engine.js)"); return; }
  const cur = fb.getMode();
  if (next === cur) return;
  const st = fb.getState();
  if (st.state === "running" || st.state === "paused") fb.stop();
  if (st.state === "ended" && fb.resetEnded) fb.resetEnded();
  fb.setMode(next);
  if (next === "discuss") {
    const topic = prompt("请输入议题(必填):", fb.getTopic() || "");
    if (!topic || !topic.trim()) { fb.setMode(cur); renderAll(); return; }
    fb.setTopic(topic.trim());
  }
  if (next === "relay" || next === "discuss") {
    const curRounds = fb.getMaxRounds();
    const ans = prompt("最大轮数(1-1000，默认 8。实质取消限制，仅防意外离开爆资金；随时点 ⏹ 手动终止):", String(curRounds));
    // 4.35 修复:点「取消」(prompt 返回 null) 时不应自动开跑——回退到原模式并 return,
    // 只有点「确定」才 setMaxRounds + start。修复"接龙不管确定还是取消都会开始"。
    if (ans === null) { fb.setMode(cur); renderAll(); return; }
    const n = Math.max(1, Math.min(1000, parseInt(ans || curRounds, 10) || curRounds));
    fb.setMaxRounds(n);
    fb.start();
  }
  renderAll();
}

function handleFbCmd(cmd) {
  const fb = getFishbowl();
  if (!fb) return;
  if (cmd === "start") fb.start();
  else if (cmd === "pause") fb.pause();
  else if (cmd === "resume") fb.resume();
  else if (cmd === "stop") fb.stop();
  else if (cmd === "topic") {
    const t = prompt("新议题:", fb.getTopic() || "");
    if (t && t.trim()) fb.setTopic(t.trim());
  } else if (cmd === "restart") {
    if (fb.resetEnded) fb.resetEnded();
    fb.start();
  } else if (cmd === "close") {
    if (fb.resetEnded) fb.resetEnded();
    fb.setMode("orchestrate");
  }
  setTimeout(renderAll, 50);
}

function renderFishbowlSidePanel() {
  // 清理旧版底部条形(鱼缸 V2)元素,V3 统一用 .fishbowl-side-panel
  ["fishbowlModeRow", "fishbowlBar"].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  });

  let panel = document.getElementById("fishbowlSidePanel");
  const fb = getFishbowl();
  const showPanel = !!fb && isMulti() && getSceneIds().length >= 2;

  if (!showPanel) {
    if (panel) panel.style.display = "none";
    document.body.removeAttribute("data-chat-mode");
    const inputEl = document.getElementById("msg");
    if (inputEl) inputEl.placeholder = "Message...";
    if (window.__app && window.__app.updateSpacer) window.__app.updateSpacer();
    return;
  }

  // 4.3:桌面端挂到 #fishbowlSlot(右侧栏);手机端退回 document.body(底部条形 V3)
  const slot = document.getElementById("fishbowlSlot");
  const isDesktop = window.matchMedia("(min-width: 1024px)").matches;
  const target = (isDesktop && slot) ? slot : document.body;
  if (!panel) {
    panel = document.createElement("aside");
    panel.id = "fishbowlSidePanel";
    panel.className = "fishbowl-side-panel";
    target.appendChild(panel);
  } else if (panel.parentNode !== target) {
    if (panel.parentNode) panel.parentNode.removeChild(panel);
    target.appendChild(panel);
  }
  // in-slot class:桌面时取消 fixed 定位(与 CSS .fishbowl-side-panel.in-slot 配合)
  panel.classList.toggle("in-slot", target === slot);
  panel.style.display = "";

  const s = fb.getState();
  const mode = s.mode || "orchestrate";
  syncChatMode(mode);

  const safe = (x) => String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const stateLabel = ({
    idle: "⏸ 待启动",
    running: "▶ 进行中",
    paused: "⏸ 已暂停",
    ended: "🏁 已结束",
  })[s.state] || s.state;

  const modes = [
    { id: "orchestrate", label: "✏️ 编排", title: "你手选下一句由谁说(群聊视觉)" },
    { id: "relay", label: "🔁 接龙", title: "AI 轮流自动接龙(吐槽姬视觉)" },
    { id: "discuss", label: "🎙️ 讨论", title: "围绕议题自由讨论(吐槽姬视觉)" },
  ];
  const chipsHtml = modes.map(m =>
    `<button class="chip-btn fishbowl-chip${m.id === mode ? " active" : ""}" data-fbmode="${m.id}" title="${safe(m.title)}">${m.label}</button>`
  ).join("");

  let statusHtml = "";
  if (mode === "relay" || mode === "discuss") {
    if (s.state === "ended" && s.endStats) {
      const e = s.endStats;
      statusHtml = `<div class="fb-side-ended"><div class="fb-ended-title">🏁 已结束</div><div class="fb-ended-line">共 <b>${e.totalRounds}</b> 轮 · 用时 <b>${e.durationSec}</b> 秒</div>${mode === "discuss" && e.topic ? `<div class="fb-ended-line">议题:${safe(e.topic)}</div>` : ""}<div class="fb-ended-reason">${endReasonLabel(e.endReason)}</div></div>`;
    } else {
      const round = `${s.round || 0}/${fb.getMaxRounds()}`;
      const topic = mode === "discuss" ? (fb.getTopic() || "(未设置)") : "";
      const speaker = s.speakerName || "—";
      // v4.9 累计花费提示(替代轮数硬限，让用户自行决定何时 stop)
      let costLine = "";
      try {
        if (window.__cost && window.__cost.getCostStats) {
          const cs = window.__cost.getCostStats();
          if (cs && cs.total > 0) {
            costLine = `<div class="fb-info-line" style="color:#c9a0ff;">💰 今日 <b>¥${cs.today.toFixed(4)}</b> · 累计 <b>¥${cs.total.toFixed(4)}</b></div>`;
          }
        }
      } catch (e) {}
      statusHtml = `<div class="fb-side-status"><div class="fb-state-line">${stateLabel}</div><div class="fb-info-line">轮次 <b>${round}</b></div>${topic ? `<div class="fb-info-line">议题:${safe(topic)}</div>` : ""}<div class="fb-info-line">当前:<b>${safe(speaker)}</b></div>${costLine}</div>`;
    }
  }

  const btns = [];
  if (mode === "relay" || mode === "discuss") {
    if (s.state === "idle") btns.push(`<button class="chip-btn fb-cmd-btn fb-primary" data-fbcmd="start">▶ 启动</button>`);
    if (s.state === "running") btns.push(`<button class="chip-btn fb-cmd-btn" data-fbcmd="pause">⏸ 暂停</button>`);
    if (s.state === "paused") btns.push(`<button class="chip-btn fb-cmd-btn" data-fbcmd="resume">▶ 继续</button>`);
    if (s.state === "running" || s.state === "paused") btns.push(`<button class="chip-btn fb-cmd-btn" data-fbcmd="stop">⏹ 终止</button>`);
    if (mode === "discuss" && s.state !== "ended") btns.push(`<button class="chip-btn fb-cmd-btn" data-fbcmd="topic">📝 改议题</button>`);
    if (s.state === "ended") {
      btns.push(`<button class="chip-btn fb-cmd-btn fb-primary" data-fbcmd="restart">✨ 新一轮</button>`);
      btns.push(`<button class="chip-btn fb-cmd-btn" data-fbcmd="close">× 关闭</button>`);
    }
  }

  panel.innerHTML = `<div class="fb-side-header">🎭 群聊控制台</div><div class="fb-side-modes">${chipsHtml}</div>${statusHtml}${btns.length ? `<div class="fb-side-actions">${btns.join("")}</div>` : ""}`;

  panel.querySelectorAll("[data-fbmode]").forEach(el => {
    el.addEventListener("click", () => handleFbModeChip(el.dataset.fbmode));
  });
  panel.querySelectorAll("[data-fbcmd]").forEach(el => {
    el.addEventListener("click", () => handleFbCmd(el.dataset.fbcmd));
  });

  if (window.__app && window.__app.updateSpacer) window.__app.updateSpacer();
}

// 鱼缸 V2 遗留函数(保留但不再使用,避免其他模块可能调用崩溃)
function renderModeChipRow() {
  const float = document.querySelector(".input-floating");
  if (!float) return;
  let row = document.getElementById("fishbowlModeRow");
  if (!isMulti() || getSceneIds().length < 2) {
    if (row) row.style.display = "none";
    if (window.__app && window.__app.updateSpacer) window.__app.updateSpacer();
    return;
  }
  if (!row) {
    row = document.createElement("div");
    row.id = "fishbowlModeRow";
    row.className = "fishbowl-mode-row";
    const sceneStrip = document.getElementById("sceneStrip");
    if (sceneStrip) float.insertBefore(row, sceneStrip);
    else float.insertBefore(row, float.firstChild);
  }
  row.style.display = "";
  const fb = getFishbowl();
  const mode = fb ? fb.getMode() : "orchestrate";
  const modes = [
    { id: "orchestrate", label: "✏️ 编排", title: "你手动选下一句由谁说(默认,V1 现状)" },
    { id: "relay", label: "🔁 接龙", title: "AI 轮流自动接龙,无议题" },
    { id: "discuss", label: "🎙️ 讨论", title: "围绕议题自由讨论,AI 自荐发言" },
  ];
  row.innerHTML = modes.map(m =>
    `<button class="chip-btn fishbowl-chip${m.id === mode ? " active" : ""}" data-fbmode="${m.id}" title="${m.title}">${m.label}</button>`
  ).join("");
  row.querySelectorAll("[data-fbmode]").forEach(el => {
    el.addEventListener("click", () => {
      const next = el.dataset.fbmode;
      if (!fb) { alert("鱼缸引擎未加载(fishbowl-engine.js)"); return; }
      const cur = fb.getMode();
      if (next === cur) return;
      const st = fb.getState && fb.getState();
      if (st && st.state !== "idle" && st.state !== "stopped") fb.stop();
      fb.setMode(next);
      if (next === "discuss") {
        const topic = prompt("请输入议题(必填):", fb.getTopic() || "");
        if (!topic || !topic.trim()) {
          fb.setMode(cur);
          renderAll();
          return;
        }
        fb.setTopic(topic.trim());
      }
      if (next === "relay" || next === "discuss") {
        const curRounds = fb.getMaxRounds();
        const ans = prompt("最大轮数(1-1000，默认 8。实质取消限制，仅防意外离开爆资金；随时点 ⏹ 手动终止):", String(curRounds));
        const n = Math.max(1, Math.min(1000, parseInt(ans || curRounds, 10) || curRounds));
        fb.setMaxRounds(n);
        fb.start();
      }
      renderAll();
    });
  });
  if (window.__app && window.__app.updateSpacer) window.__app.updateSpacer();
}

function renderFishbowlBar() {
  const float = document.querySelector(".input-floating");
  if (!float) return;
  let bar = document.getElementById("fishbowlBar");
  const fb = getFishbowl();
  const mode = fb ? fb.getMode() : "orchestrate";
  const showBar = !!fb && (mode === "relay" || mode === "discuss") && isMulti() && getSceneIds().length >= 2;
  if (!showBar) {
    if (bar) bar.style.display = "none";
    if (window.__app && window.__app.updateSpacer) window.__app.updateSpacer();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "fishbowlBar";
    bar.className = "fishbowl-bar";
    const modeRow = document.getElementById("fishbowlModeRow");
    if (modeRow && modeRow.nextSibling) float.insertBefore(bar, modeRow.nextSibling);
    else if (modeRow) float.appendChild(bar);
    else float.insertBefore(bar, float.firstChild);
  }
  bar.style.display = "";
  const s = fb.getState();
  const stateLabel = ({ idle: "⏸ 待启动", running: "▶ 进行中", paused: "⏸ 已暂停", stopped: "⏹ 已停止" })[s.state] || s.state;
  const topicTxt = mode === "discuss" ? (fb.getTopic() || "(未设置)") : "(无议题)";
  const roundTxt = `${s.currentRound || 0}/${fb.getMaxRounds()}`;
  const speakerName = (s.currentSpeaker && s.currentSpeaker.name) || "—";
  const safe = (x) => String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let btns = "";
  if (s.state === "running") btns += `<button class="chip-btn" data-fbcmd="pause">\u23F8 暂停</button>`;
  if (s.state === "paused") btns += `<button class="chip-btn" data-fbcmd="resume">\u25B6 继续</button>`;
  if (s.state === "idle" || s.state === "stopped") btns += `<button class="chip-btn" data-fbcmd="start">\u25B6 启动</button>`;
  btns += `<button class="chip-btn" data-fbcmd="stop">\u23F9 终止</button>`;
  if (mode === "discuss") btns += `<button class="chip-btn" data-fbcmd="topic">\u{1F4DD} 改议题</button>`;
  bar.innerHTML = `<span class="fishbowl-status">${stateLabel}</span><span class="fishbowl-info">轮次 ${roundTxt} · 议题:${safe(topicTxt)} · 当前:<b>${safe(speakerName)}</b></span><span class="fishbowl-btns">${btns}</span>`;
  bar.querySelectorAll("[data-fbcmd]").forEach(el => {
    el.addEventListener("click", () => {
      const cmd = el.dataset.fbcmd;
      if (cmd === "start") fb.start();
      else if (cmd === "pause") fb.pause();
      else if (cmd === "resume") fb.resume();
      else if (cmd === "stop") fb.stop();
      else if (cmd === "topic") {
        const t = prompt("新议题:", fb.getTopic() || "");
        if (t && t.trim()) fb.setTopic(t.trim());
      }
      setTimeout(renderAll, 50);
    });
  });
  if (window.__app && window.__app.updateSpacer) window.__app.updateSpacer();
}

function renderAll() {
  renderSceneStrip();
  renderFishbowlSidePanel();
}

document.addEventListener("DOMContentLoaded", () => {
  wireTopbarToggle();
  // scene-strip + 鱼缸 UI 首次渲染延迟一点,等 app.js init() 把 .input-floating 准备好
  setTimeout(renderAll, 80);
  window.addEventListener("character:changed", renderAll);
  window.addEventListener("multi-agent:changed", renderAll);
  // 鱼缸引擎驱动事件:每条 AI 回复完 + 状态切换都刷新 UI
  window.addEventListener("fishbowl:tick", renderAll);
  window.addEventListener("fishbowl:state", renderAll);
  // 4.3:窗口尺寸变化重新挂载 fishbowl(桌面 slot ↔ 手机 body)
  let _resizeT = 0;
  window.addEventListener("resize", () => {
    if (_resizeT) clearTimeout(_resizeT);
    _resizeT = setTimeout(renderAll, 200);
  });
});
})();