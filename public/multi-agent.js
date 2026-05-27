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
function renderSceneStrip() {
  const float = document.querySelector(".input-floating");
  if (!float) return;
  let strip = document.getElementById("sceneStrip");
  const cards = getSceneCards();
  if (!cards || cards.length < 2) {
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
      if (ch && ch.setActiveId) ch.setActiveId(el.dataset.sid);
      setTimeout(renderSceneStrip, 30);
    });
  });
  if (window.__app && window.__app.updateSpacer) window.__app.updateSpacer();
}

// ── 顶栏 #multiAgentToggle 按钮 ──
function wireTopbarToggle() {
  const btn = document.getElementById("multiAgentToggle");
  if (!btn) return;
  function refresh() {
    const on = isMulti();
    btn.textContent = on ? "👥" : "🧑";
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

document.addEventListener("DOMContentLoaded", () => {
  wireTopbarToggle();
  // scene-strip 首次渲染延迟一点，等 app.js init() 把 .input-floating 准备好
  setTimeout(renderSceneStrip, 80);
  window.addEventListener("character:changed", renderSceneStrip);
  window.addEventListener("multi-agent:changed", renderSceneStrip);
});
})();