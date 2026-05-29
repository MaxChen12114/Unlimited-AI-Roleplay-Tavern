// public/sync.js
// 云同步引擎：
// - dumpAll()      → 打包全部 localStorage + IndexedDB 为 JSON blob
// - restoreAll()   → 从 JSON blob 还原本地数据
// - pullFromKV()   → GET /sync
// - pushToKV(blob) → PUT /sync
// - markDirty()    → debounce 3s 后 push
// - pullOnStartup()→ 启动时拉一次，远端 newer 则 restore + reload
// - exportJSON / importJSON → 本地文件备份
//
// localStorage 一变动 (storage 事件) 或 app.js 调 __sync.markDirty() 都会触发 push
(() => {
  const SYNC_ENABLED_KEY = "cfw_sync_enabled_v1";
  const LAST_PUSH_KEY    = "cfw_sync_last_push_v1";
  const LAST_PULL_KEY    = "cfw_sync_last_pull_v1";
  // 4.17 新增: 同步聊天历史 toggle(默认 OFF) / 暂停同步 / push 计数(KV 配额监控)
  const INCLUDE_CHAT_KEY   = "cfw_sync_include_chat_v1";
  const PAUSE_KEY          = "cfw_sync_paused_v1";
  const PUSH_COUNT_KEY     = "cfw_sync_push_count_v1";
  const PUSH_COUNT_DAY_KEY = "cfw_sync_push_count_day_v1";
  const PUSH_DAILY_WARN    = 800; // Cloudflare KV 免费层 1000 writes/day,到 800 触发告警

  // 需同步的精确 LS key【示例，代码里以 fallback全量法为准】
  const LS_EXPLICIT = [
    "cfw_theme_v1", "cfw_theme_accent_v1", "cfw_thinking",
    "cfw_prior_summary_v1", "cfw_summary_enabled", "cfw_summary_trigger", "cfw_summary_keep",
    "tavern_active_props_v1", "tavern_active_scene_v1", "tavern_aff_pending_v1",
    "cfw_prompt_presets_v1", "tavern_multi_agent_mode_v1",
    // 4.20: cfw_cost_log_v1 移出 main blob → 独立 /sync/cost KV (per-day per-field max merge),跨设备不丢数据
    "cfw_mode", "cfw_model", "cfw_use_builtin", "cfw_history_enabled",
    "cfw_prompt_enabled", "cfw_custom_prompt_v1",
    // 4.17: cfw_chat_session_v1 已移出默认白名单,改由 includeChat() toggle 控制(默认 OFF 避免跨设备覆盖)
  ];
  // 前缀匹配（多实例）
  const LS_PREFIXES = [
    "tavern_aff_triggered_",
    "cfw_summary_",  // 领域预留
  ];
  // 受保护不同步的 LS key（同步状态本身 + auth token）
  const PROTECTED = [
    "cfw_auth_token_v1",
    "cfw_chat_protect_v1",
    SYNC_ENABLED_KEY, LAST_PUSH_KEY, LAST_PULL_KEY,
    INCLUDE_CHAT_KEY, PAUSE_KEY, PUSH_COUNT_KEY, PUSH_COUNT_DAY_KEY, // 4.17 同步控制开关本身不进同步
    // 4.20: 费用独立同步 - 不进 main blob;monkey-patch setItem 看到这些 key 跳过 main markDirty
    "cfw_cost_log_v1",
    "cfw_sync_last_cost_push_v1",
    "cfw_sync_last_cost_pull_v1",
  ];
  // IndexedDB 数据库名列表
  const IDB_NAMES = ["tavern_chars_v2", "tavern_props_v1"];

  function token() { return (window.__auth && window.__auth.getToken && window.__auth.getToken()) || ""; }
  function syncEnabled() { return localStorage.getItem(SYNC_ENABLED_KEY) === "1"; }
  function setSyncEnabled(on) { localStorage.setItem(SYNC_ENABLED_KEY, on ? "1" : "0"); }

  // ─── localStorage dump/restore ───
  function collectLS() {
    const out = {};
    const seen = new Set();
    for (const k of LS_EXPLICIT) {
      const v = localStorage.getItem(k);
      if (v !== null) { out[k] = v; seen.add(k); }
    }
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || seen.has(k) || PROTECTED.includes(k)) continue;
      if (LS_PREFIXES.some(p => k.startsWith(p))) out[k] = localStorage.getItem(k);
    }
    // 4.17: 聊天历史按 includeChat toggle 控制 - 默认 OFF(避免跨设备覆盖)
    if (includeChat()) {
      const v = localStorage.getItem("cfw_chat_session_v1");
      if (v !== null) out["cfw_chat_session_v1"] = v;
    }
    return out;
  }
  function restoreLS(ls) {
    if (!ls || typeof ls !== "object") return;
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || PROTECTED.includes(k)) continue;
      const explicit = LS_EXPLICIT.includes(k);
      const prefix = LS_PREFIXES.some(p => k.startsWith(p));
      if (explicit || prefix) toRemove.push(k);
    }
    for (const k of toRemove) localStorage.removeItem(k);
    for (const k in ls) {
      if (PROTECTED.includes(k)) continue;
      // 4.17: 远端有聊天 session 但本地未开 includeChat,跳过(避免另一台设备的聊天覆盖本地)
      if (k === "cfw_chat_session_v1" && !includeChat()) continue;
      if (typeof ls[k] === "string") localStorage.setItem(k, ls[k]);
    }
  }

  // ─── IndexedDB dump/restore（按 store 全量）───
  function openDB(name) {
    return new Promise((res) => {
      let upgrading = false;
      const req = indexedDB.open(name);
      req.onsuccess = () => res(upgrading ? null : req.result);
      req.onerror = () => res(null);
      req.onupgradeneeded = (e) => {
        upgrading = true;
        try { e.target.transaction.abort(); } catch {}
      };
      req.onblocked = () => res(null);
    });
  }
  async function dumpDB(name) {
    const db = await openDB(name);
    if (!db) return null;
    const out = {};
    try {
      const stores = Array.from(db.objectStoreNames);
      for (const sn of stores) {
        out[sn] = await new Promise((res) => {
          const tx = db.transaction(sn, "readonly");
          const store = tx.objectStore(sn);
          const r = store.getAll();
          r.onsuccess = () => res(r.result || []);
          r.onerror = () => res([]);
        });
      }
    } finally { try { db.close(); } catch {} }
    return out;
  }
  async function restoreDB(name, data) {
    if (!data || typeof data !== "object") return;
    const db = await openDB(name);
    if (!db) return;
    try {
      const stores = Array.from(db.objectStoreNames);
      for (const sn of stores) {
        const items = data[sn];
        if (!Array.isArray(items)) continue;
        await new Promise((res) => {
          const tx = db.transaction(sn, "readwrite");
          const store = tx.objectStore(sn);
          store.clear();
          for (const it of items) { try { store.put(it); } catch {} }
          tx.oncomplete = () => res();
          tx.onerror = () => res();
          tx.onabort = () => res();
        });
      }
    } finally { try { db.close(); } catch {} }
  }

  // ─── 打包 / 还原 全量 ───
  async function dumpAll() {
    const ls = collectLS();
    const idb = {};
    for (const n of IDB_NAMES) idb[n] = await dumpDB(n);
    return { version: 1, savedAt: Date.now(), localStorage: ls, indexedDB: idb };
  }
  async function restoreAll(blob) {
    if (!blob || typeof blob !== "object") return false;
    if (blob.localStorage) restoreLS(blob.localStorage);
    if (blob.indexedDB) {
      for (const n in blob.indexedDB) await restoreDB(n, blob.indexedDB[n]);
    }
    return true;
  }

  // ─── 网络 ───
  async function pullFromKV() {
    if (!token()) throw new Error("\u672a\u542f\u7528\u4e91\u540c\u6b65\uff08\u7f3a token\uff09");
    const r = await fetch("/sync");
    if (r.status === 401) throw new Error("\u5bc6\u7801\u9519\u8bef");
    if (!r.ok) throw new Error("\u62c9\u53d6\u5931\u8d25: " + r.status);
    const text = await r.text();
    if (!text || text === "null") return null;
    try { return JSON.parse(text); } catch { return null; }
  }
  async function pushToKV(blob) {
    if (!token()) throw new Error("\u672a\u542f\u7528\u4e91\u540c\u6b65\uff08\u7f3a token\uff09");
    const r = await fetch("/sync", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(blob),
    });
    if (r.status === 401) throw new Error("\u5bc6\u7801\u9519\u8bef");
    if (!r.ok) throw new Error("\u63a8\u9001\u5931\u8d25: " + r.status);
    return r.json();
  }

  // ─── 状态 + 事件 ───
  const listeners = new Set();
  function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function emit(status, detail) { for (const fn of listeners) { try { fn(status, detail); } catch {} } }

  // 4.17: 同步聊天历史 toggle - 默认 OFF。配置类资产(角色卡/preset/费用)总是同步,聊天单独控制
  function includeChat() { return localStorage.getItem(INCLUDE_CHAT_KEY) === "1"; }
  function setIncludeChat(on) { localStorage.setItem(INCLUDE_CHAT_KEY, on ? "1" : "0"); }
  // 4.17: 临时暂停 - markDirty 静默丢弃(已 schedule 的 timer 不取消,跑完即止)
  function isPaused() { return localStorage.getItem(PAUSE_KEY) === "1"; }
  function pause() { localStorage.setItem(PAUSE_KEY, "1"); emit("paused"); }
  function resume() { localStorage.removeItem(PAUSE_KEY); emit("resumed"); }
  // 4.17: KV 配额监控 - 当日累计到 800 次触发 warn 事件
  function incrPushCount() {
    const today = new Date().toISOString().slice(0, 10);
    const prevDay = localStorage.getItem(PUSH_COUNT_DAY_KEY);
    let n = parseInt(localStorage.getItem(PUSH_COUNT_KEY) || "0", 10);
    if (prevDay !== today) { n = 0; localStorage.setItem(PUSH_COUNT_DAY_KEY, today); }
    n += 1;
    localStorage.setItem(PUSH_COUNT_KEY, String(n));
    if (n === PUSH_DAILY_WARN) emit("warn", { reason: "kv-quota", today, count: n });
    return n;
  }

  // ─── debounce push ───
  let pushTimer = null;
  let pushing = false;
  let pendingPush = false;

  async function doPush() {
    if (pushing) { pendingPush = true; return; }
    pushing = true;
    emit("syncing");
    try {
      const blob = await dumpAll();
      const res = await pushToKV(blob);
      localStorage.setItem(LAST_PUSH_KEY, String(res.savedAt || Date.now()));
      // 拉取时间也同步推进，避免下次启动倒拽自己刚 push 的数据
      localStorage.setItem(LAST_PULL_KEY, String(res.savedAt || Date.now()));
      const pushN = incrPushCount(); // 4.17: KV 配额监控
      emit("synced", Object.assign({}, res, { pushCount: pushN }));
    } catch (e) {
      emit("error", e);
    } finally {
      pushing = false;
      if (pendingPush) { pendingPush = false; setTimeout(doPush, 1500); }
    }
  }
  function markDirty() {
    if (!syncEnabled() || !token()) return;
    if (isPaused()) return; // 4.17: 暂停中静默丢弃,不开计时器
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pushTimer = null; doPush(); }, 30000); // 4.17: 3s → 30s 节省 KV 配额
  }
  async function pushNow() {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    await doPush();
  }

  // ─── 4.20: 费用独立同步通道 (/sync/cost) ───
  // 设计:cfw_cost_log_v1 独立于 main blob,任何设备发完一条消息排队 push (10s debounce,比 main 的 30s 短)
  // 合并策略:per-day per-field max (本地 vs 云端 vs 服务端 prev) - 简单稳定,设备并发也不丢
  // 服务端 /sync/cost PUT 内部再做一次 max merge,即使两台设备同秒 PUT 也不会覆盖
  const LAST_COST_PUSH_KEY = "cfw_sync_last_cost_push_v1";
  const LAST_COST_PULL_KEY = "cfw_sync_last_cost_pull_v1";
  function getLocalCostLog() {
    try {
      const raw = localStorage.getItem("cfw_cost_log_v1");
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return (obj && typeof obj === "object" && !Array.isArray(obj)) ? obj : {};
    } catch { return {}; }
  }
  function setLocalCostLog(log) {
    try { localStorage.setItem("cfw_cost_log_v1", JSON.stringify(log)); } catch {}
  }
  function mergeCostLogs(a, b) {
    const out = {};
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const day of keys) {
      const ea = (a && a[day]) || {};
      const eb = (b && b[day]) || {};
      out[day] = {
        cost: Math.max(ea.cost || 0, eb.cost || 0),
        prompt: Math.max(ea.prompt || 0, eb.prompt || 0),
        completion: Math.max(ea.completion || 0, eb.completion || 0),
        requests: Math.max(ea.requests || 0, eb.requests || 0),
      };
    }
    return out;
  }
  async function pullCostFromKV() {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const r = await fetch("/sync/cost");
    if (r.status === 401) throw new Error("密码错误");
    if (!r.ok) throw new Error("拉取费用失败: " + r.status);
    const text = await r.text();
    if (!text || text === "null") return null;
    try { return JSON.parse(text); } catch { return null; }
  }
  async function pushCostToKV(log) {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const r = await fetch("/sync/cost", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(log),
    });
    if (r.status === 401) throw new Error("密码错误");
    if (!r.ok) throw new Error("推送费用失败: " + r.status);
    return r.json();
  }
  async function pullCostOnStartup() {
    if (!syncEnabled() || !token()) return;
    try {
      const remote = await pullCostFromKV();
      if (!remote) return;
      const local = getLocalCostLog();
      const merged = mergeCostLogs(local, remote);
      setLocalCostLog(merged);
      localStorage.setItem(LAST_COST_PULL_KEY, String(Date.now()));
      // 通知 cost UI 刷新 (顶栏 + Settings 面板)
      try {
        if (window.__cost && window.__cost.refreshTopbar) window.__cost.refreshTopbar();
        if (window.__cost && window.__cost.refreshSettings) window.__cost.refreshSettings();
      } catch {}
      emit("cost-synced", { source: "pull" });
    } catch (e) {
      emit("cost-error", e);
    }
  }
  let costPushTimer = null;
  let costPushing = false;
  let pendingCostPush = false;
  async function doCostPush() {
    if (costPushing) { pendingCostPush = true; return; }
    costPushing = true;
    try {
      const local = getLocalCostLog();
      const res = await pushCostToKV(local);
      localStorage.setItem(LAST_COST_PUSH_KEY, String(res.savedAt || Date.now()));
      // 服务端返回 merged 全量 (含其他设备先 push 过的更高数字),本地再次 merge 落地
      if (res && res.merged && typeof res.merged === "object") {
        const merged = mergeCostLogs(local, res.merged);
        setLocalCostLog(merged);
        try {
          if (window.__cost && window.__cost.refreshTopbar) window.__cost.refreshTopbar();
          if (window.__cost && window.__cost.refreshSettings) window.__cost.refreshSettings();
        } catch {}
      }
      incrPushCount();
      emit("cost-synced", Object.assign({}, res, { source: "push" }));
    } catch (e) {
      emit("cost-error", e);
    } finally {
      costPushing = false;
      if (pendingCostPush) { pendingCostPush = false; setTimeout(doCostPush, 1500); }
    }
  }
  function markCostDirty() {
    if (!syncEnabled() || !token()) return;
    if (isPaused()) return;
    if (costPushTimer) clearTimeout(costPushTimer);
    costPushTimer = setTimeout(() => { costPushTimer = null; doCostPush(); }, 10000);
  }
  async function pushCostNow() {
    if (costPushTimer) { clearTimeout(costPushTimer); costPushTimer = null; }
    await doCostPush();
  }

  // ─── 启动时拉取 ───
  async function pullOnStartup() {
    if (!syncEnabled() || !token()) return;
    emit("syncing");
    try {
      const remote = await pullFromKV();
      if (!remote) {
        // KV 为空（首次启用）→ 把本地作为初始现有数据推上去
        emit("synced", { firstPush: true });
        await pushNow();
        return;
      }
      const lastPull = parseInt(localStorage.getItem(LAST_PULL_KEY) || "0", 10);
      const remoteAt = remote.savedAt || 0;
      if (remoteAt > lastPull) {
        await restoreAll(remote);
        localStorage.setItem(LAST_PULL_KEY, String(remoteAt));
        emit("restored", { savedAt: remoteAt });
        // 让 app.js 重新初始化：刷新页面最可靠
        setTimeout(() => location.reload(), 600);
      } else {
        emit("synced");
      }
    } catch (e) {
      emit("error", e);
    }
  }

  // ─── 本地文件备份 ───
  async function exportJSON() {
    const blob = await dumpAll();
    const text = JSON.stringify(blob, null, 2);
    const file = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tavern-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function importJSON(file) {
    return new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const blob = JSON.parse(reader.result);
          await restoreAll(blob);
          res(blob);
        } catch (e) { rej(e); }
      };
      reader.onerror = () => rej(reader.error);
      reader.readAsText(file);
    });
  }

  // ─── 暴露 ───
  window.__sync = {
    markDirty, pushNow, pullFromKV, pullOnStartup,
    // 4.20: 费用独立同步通道 (app.js addCostToToday 调 markCostDirty)
    markCostDirty, pushCostNow, pullCostOnStartup,
    exportJSON, importJSON,
    syncEnabled, setSyncEnabled,
    includeChat, setIncludeChat, // 4.17: 同步聊天历史 toggle
    isPaused, pause, resume,     // 4.17: 暂停/恢复
    dumpAll, restoreAll,
    onStatus,
    getStatus: () => ({
      enabled: syncEnabled(),
      hasToken: !!token(),
      paused: isPaused(),
      includeChat: includeChat(),
      lastPush: parseInt(localStorage.getItem(LAST_PUSH_KEY) || "0", 10),
      lastPull: parseInt(localStorage.getItem(LAST_PULL_KEY) || "0", 10),
      pushCount: parseInt(localStorage.getItem(PUSH_COUNT_KEY) || "0", 10),
      pushCountDay: localStorage.getItem(PUSH_COUNT_DAY_KEY) || "",
    }),
  };

  // 启动自动拉 (main blob + 4.20 独立 cost log,两个通道并发)
  if (syncEnabled() && token()) {
    pullOnStartup();
    pullCostOnStartup(); // 4.20: 即使 main blob 没变也单独 merge 云端最高 cost
  }

  // 多 tab 互同：另一个 tab 改了 LS 也触发 push
  window.addEventListener("storage", (e) => {
    if (!e.key || PROTECTED.includes(e.key)) return;
    markDirty();
  });

  // 同 tab 内 LS 改动 monkey-patch（storage 事件只跨 tab 触发，本 tab 改自身收不到）
  // 这样角色卡/道具/preset/历史/费用 任何 setItem 都会自动触发同步，无需改其他文件
  const realSetItem = Storage.prototype.setItem;
  const realRemoveItem = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (k, v) {
    realSetItem.call(this, k, v);
    if (this === localStorage && !PROTECTED.includes(k)) markDirty();
  };
  Storage.prototype.removeItem = function (k) {
    realRemoveItem.call(this, k);
    if (this === localStorage && !PROTECTED.includes(k)) markDirty();
  };
})();