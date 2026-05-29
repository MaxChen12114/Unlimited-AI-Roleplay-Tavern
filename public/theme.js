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

// v2：多维度 + lewd 子风格 + Pulse 单例 + 音频控制
// 未来扩展只改这里：加新风格 ID + 在 styles.css 加 [data-theme="xxx"] 规则即可
const STYLES = ["minimal", "glass", "lewd-peach", "lewd-doll"];
const LEWD_STYLES = ["lewd-peach", "lewd-doll"];
const AUDIO_URL = "/assets/lewd-ambient.mp3";

const LS_STYLE     = "cfw_theme_v1";
const LS_SCHEME    = "my-theme";
const LS_ACCENT    = "cfw_theme_accent_v1";
const LS_AUDIO_ON  = "cfw_audio_enabled_v1";
const LS_AUDIO_VOL = "cfw_audio_volume_v1";

const getStyle  = () => {
  const v = localStorage.getItem(LS_STYLE);
  return STYLES.includes(v) ? v : "minimal";
};
const getScheme = () => localStorage.getItem(LS_SCHEME) === "light" ? "light" : "dark";
const getAccent = () => localStorage.getItem(LS_ACCENT) || "default";
const getAll    = () => ({ style: getStyle(), scheme: getScheme(), accent: getAccent() });

const getAudioEnabled = () => {
  const v = localStorage.getItem(LS_AUDIO_ON);
  return v === null ? true : v === "1";  // 默认开
};
const getVolume = () => {
  const v = parseFloat(localStorage.getItem(LS_AUDIO_VOL));
  return isFinite(v) && v >= 0 && v <= 1 ? v : 0.7;
};
const isLewd = (s) => LEWD_STYLES.includes(s || getStyle());

function applyStyle(s) {
  if (s === "minimal" || !STYLES.includes(s)) {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", s);
  }
  if (document.body) document.body.dataset.audioDisabled = String(!getAudioEnabled());
}

// ═══ Pulse 单例：Web Audio API 驱动 --pulse 0~1 ═══
const Pulse = (() => {
  let ctx = null;
  let audioEl = null;
  let source = null;
  let analyser = null;
  let gainNode = null;
  let rafId = null;
  let unlocked = false;
  let running = false;
  let fallbackTimer = null;
  let fallbackPhase = 0;

  function setPulseVar(v) {
    document.documentElement.style.setProperty("--pulse", v.toFixed(3));
  }
  function setPulseClass(on) {
    document.documentElement.classList.toggle("pulse-on", !!on);
  }

  function tick() {
    if (!analyser) { rafId = requestAnimationFrame(tick); return; }
    const buf = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i];
    const avg = sum / buf.length / 255;
    const eased = Math.min(1, Math.max(0, avg * 1.8));
    setPulseVar(eased);
    rafId = requestAnimationFrame(tick);
  }

  // 无音频时的 CSS-only 慢摆，让 --pulse 仍有节奏
  function startFallback() {
    if (fallbackTimer) return;
    fallbackTimer = setInterval(() => {
      fallbackPhase += 0.05;
      const v = 0.4 * (Math.sin(fallbackPhase * 1.4) * 0.5 + 0.5);
      setPulseVar(v);
    }, 50);
  }
  function stopFallback() {
    if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
  }

  async function start() {
    if (!isLewd() || !getAudioEnabled()) return;
    if (running) return;
    if (!unlocked) { startFallback(); return; }
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") await ctx.resume();

      if (!audioEl) {
        audioEl = new Audio(AUDIO_URL);
        audioEl.loop = true;
        audioEl.crossOrigin = "anonymous";
        audioEl.preload = "auto";
        audioEl.addEventListener("error", () => {
          console.warn("[theme] audio load failed, fallback only");
          startFallback();
        });
      }

      if (!source) {
        try {
          source = ctx.createMediaElementSource(audioEl);
          analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          gainNode = ctx.createGain();
          source.connect(analyser);
          analyser.connect(gainNode);
          gainNode.connect(ctx.destination);
        } catch (e) {
          console.warn("[theme] audio graph reuse:", e);
        }
      }

      if (gainNode) gainNode.gain.value = getVolume();

      try {
        await audioEl.play();
      } catch (e) {
        console.warn("[theme] audio play blocked, fallback only:", e);
        startFallback();
        return;
      }

      stopFallback();
      running = true;
      setPulseClass(true);
      if (!rafId) tick();
    } catch (e) {
      console.warn("[theme] Pulse start failed:", e);
      startFallback();
    }
  }

  function stop({ fade = true } = {}) {
    running = false;
    setPulseClass(false);
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    stopFallback();
    setPulseVar(0);
    if (audioEl && !audioEl.paused) {
      if (fade && gainNode && ctx) {
        try {
          const now = ctx.currentTime;
          const startVol = gainNode.gain.value;
          gainNode.gain.cancelScheduledValues(now);
          gainNode.gain.setValueAtTime(startVol, now);
          gainNode.gain.linearRampToValueAtTime(0, now + 0.2);
          setTimeout(() => {
            try { audioEl.pause(); gainNode.gain.value = getVolume(); } catch (e) {}
          }, 220);
        } catch (e) {
          try { audioEl.pause(); } catch (_) {}
        }
      } else {
        try { audioEl.pause(); } catch (e) {}
      }
    }
  }

  function setVolume(v) {
    if (gainNode) gainNode.gain.value = v;
    if (audioEl)  audioEl.volume = v;
  }

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    if (isLewd() && getAudioEnabled()) {
      running = false;
      start();
    }
  }

  function sync() {
    if (isLewd() && getAudioEnabled()) start();
    else stop({ fade: true });
  }

  return { start, stop, setVolume, unlock, sync };
})();

// ═══ set / panic / audio 收口 ═══
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
  document.querySelectorAll('input[name="cfwTheme"]').forEach(r => {
    r.checked = (r.value === getStyle());
  });
  Pulse.sync();
  // 2026-05-29 lewd ↔ nsfwLevel 联动: lewd-* 主题 = NSFW L2 露骨, minimal/glass = L0 关闭
  // worker.js 接收到 nsfwLevel >= 1 时跳过 META_IDENTITY,改注入 buildNsfwInstruction(L)
  try { localStorage.setItem("cfw_nsfw_mode_v1", isLewd() ? "2" : "0"); } catch (e) {}
  window.dispatchEvent(new CustomEvent("theme:changed", { detail: getAll() }));
}

function panic() {
  Pulse.stop({ fade: false });
  set({ style: "minimal" });
}

const audio = {
  get: () => ({ enabled: getAudioEnabled(), volume: getVolume() }),
  set: ({ enabled, volume } = {}) => {
    if (typeof enabled === "boolean") {
      try { localStorage.setItem(LS_AUDIO_ON, enabled ? "1" : "0"); } catch (e) {}
      if (document.body) document.body.dataset.audioDisabled = String(!enabled);
    }
    if (typeof volume === "number" && volume >= 0 && volume <= 1) {
      try { localStorage.setItem(LS_AUDIO_VOL, String(volume)); } catch (e) {}
      Pulse.setVolume(volume);
    }
    Pulse.sync();
    window.dispatchEvent(new CustomEvent("theme:audio-changed", { detail: audio.get() }));
  },
};

const is = (scheme) => getScheme() === scheme;
const styles = () => STYLES.slice();
function subscribe(fn) {
  const h = (e) => fn(e.detail || getAll());
  window.addEventListener("theme:changed", h);
  return () => window.removeEventListener("theme:changed", h);
}

window.__theme = { get: getAll, set, is, styles, subscribe, panic, audio };

// ═══ wire Settings DOM ═══
function wireSettings() {
  document.querySelectorAll('input[name="cfwTheme"]').forEach(r => {
    r.checked = (r.value === getStyle());
    r.addEventListener("change", () => {
      if (!r.checked) return;
      if (STYLES.includes(r.value)) set({ style: r.value });
    });
  });

  const toggleEl = document.getElementById("lewdAudioToggle");
  if (toggleEl) {
    toggleEl.checked = getAudioEnabled();
    toggleEl.addEventListener("change", () => {
      audio.set({ enabled: !!toggleEl.checked });
    });
  }

  const volEl  = document.getElementById("lewdAudioVolume");
  const volLbl = document.getElementById("lewdAudioVolumeLabel");
  const curVol = getVolume();
  if (volEl) {
    volEl.value = String(Math.round(curVol * 100));
    if (volLbl) volLbl.textContent = Math.round(curVol * 100) + "%";
    volEl.addEventListener("input", () => {
      const v = Math.max(0, Math.min(1, parseInt(volEl.value, 10) / 100));
      if (volLbl) volLbl.textContent = Math.round(v * 100) + "%";
      audio.set({ volume: v });
    });
  }

  const panicEl = document.getElementById("lewdAudioPanic");
  if (panicEl) panicEl.addEventListener("click", panic);
}

window.addEventListener("load", () => {
  applyStyle(getStyle());
  wireSettings();
  // 2026-05-29: 启动时同步一次 lewd ↔ nsfwLevel (避免首次进页不点设置时 LS 状态不同步)
  try { localStorage.setItem("cfw_nsfw_mode_v1", isLewd() ? "2" : "0"); } catch (e) {}

  // 首次任意交互解锁 AudioContext
  const unlockOnce = () => {
    Pulse.unlock();
    window.removeEventListener("pointerdown", unlockOnce);
    window.removeEventListener("keydown", unlockOnce);
    window.removeEventListener("touchstart", unlockOnce);
  };
  window.addEventListener("pointerdown", unlockOnce, { once: true });
  window.addEventListener("keydown",    unlockOnce, { once: true });
  window.addEventListener("touchstart", unlockOnce, { once: true });

  // Shift+Esc 全局紧急停止
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && e.shiftKey) {
      e.preventDefault();
      panic();
    }
  });

  Pulse.sync();
});
})();