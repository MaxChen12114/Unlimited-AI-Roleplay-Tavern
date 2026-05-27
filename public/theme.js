// public/theme.js — 主题系统（多维度、事件驱动、未来扩展友好）
//
// 设计原则：
//   1. 多维度正交：style / scheme / accent 三个独立维度，未来还可加 font/density 等
//   2. 事件订阅：所有消费者通过 'theme:changed' 事件统一接收变更，不直接读 LS
//   3. 单一收口：set(patch) 是唯一写入路径，保证 LS / DOM / Settings UI / 订阅者同步
//   4. 可扩展：加新风格只需在 STYLES 加一项 + 写对应 [data-theme="xxx"] CSS
//
// 维度（v1 实现 + 占位）：
//   style:  "minimal" | "glass"   — v1 完整实现（写 [data-theme]）
//   scheme: "dark"    | "light"   — v1 只读 API（消费者读 my-theme）；写入路径将来收口
//   accent: 字符串               — v1 占位（保留 LS）
//
// API：
//   __theme.get()                     → { style, scheme, accent }
//   __theme.set(patch)                → 增量更新（任意子集），触发 'theme:changed'
//   __theme.is("light" | "dark")      → 给散落消费者一个稳定快捷判断
//   __theme.styles()                  → ["minimal", "glass", ...] 未来扩展只改 STYLES
//   __theme.subscribe(fn)             → 返回 unsubscribe；fn(detail) 收到 { style, scheme, accent }
//
// 事件：window 'theme:changed' detail = { style, scheme, accent }
//
// LS keys：
//   cfw_theme_v1          ← style
//   my-theme              ← scheme（legacy 名称保留，避免散落消费者炸）
//   cfw_theme_accent_v1   ← accent（占位）
//
// 注意：minimal/glass 的 FOUC 防闪烁仍由 index.html <head> 内联 inline script 完成；
// 本文件加载后会幂等再应用一次。
(function () {
"use strict";

// 未来扩展只改这里：加新风格 ID + 在 styles.css 加 [data-theme="xxx"] 规则即可
const STYLES = ["minimal", "glass"];

const LS_STYLE  = "cfw_theme_v1";
const LS_SCHEME = "my-theme";
const LS_ACCENT = "cfw_theme_accent_v1";

const getStyle  = () => {
  const v = localStorage.getItem(LS_STYLE);
  return STYLES.includes(v) ? v : "minimal";
};
const getScheme = () => localStorage.getItem(LS_SCHEME) === "light" ? "light" : "dark";
const getAccent = () => localStorage.getItem(LS_ACCENT) || "default";
const getAll    = () => ({ style: getStyle(), scheme: getScheme(), accent: getAccent() });

function applyStyle(s) {
  if (s === "minimal" || !STYLES.includes(s)) {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", s);
  }
}

function set(patch) {
  patch = patch || {};
  if (patch.style && STYLES.includes(patch.style)) {
    try { localStorage.setItem(LS_STYLE, patch.style); } catch (e) {}
    applyStyle(patch.style);
  }
  if (patch.scheme === "light" || patch.scheme === "dark") {
    try { localStorage.setItem(LS_SCHEME, patch.scheme); } catch (e) {}
  }
  if (patch.accent) {
    try { localStorage.setItem(LS_ACCENT, patch.accent); } catch (e) {}
  }
  // 同步 Settings 面板里 radio 的选中态
  document.querySelectorAll('input[name="cfwTheme"]').forEach(r => {
    r.checked = (r.value === getStyle());
  });
  window.dispatchEvent(new CustomEvent("theme:changed", { detail: getAll() }));
}

const is = (scheme) => getScheme() === scheme;
const styles = () => STYLES.slice();
function subscribe(fn) {
  const h = (e) => fn(e.detail || getAll());
  window.addEventListener("theme:changed", h);
  return () => window.removeEventListener("theme:changed", h);
}

window.__theme = { get: getAll, set, is, styles, subscribe };

// 启动：幂等应用 + wire Settings radio
window.addEventListener("load", () => {
  applyStyle(getStyle());
  document.querySelectorAll('input[name="cfwTheme"]').forEach(r => {
    r.checked = (r.value === getStyle());
    r.addEventListener("change", () => {
      if (!r.checked) return;
      const next = r.value === "glass" ? "glass" : "minimal";
      set({ style: next });
    });
  });
});
})();