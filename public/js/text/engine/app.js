// public/app.js
(() => {
  const historyWrap = document.getElementById("history");
  const chatEl = document.getElementById("chat");
  const inputEl = document.getElementById("msg");
  const composerEl = document.getElementById("composer");
  const spacerEl = document.getElementById("bottom-spacer");
  const modelSel = document.getElementById("modelSel");
  const personaToggle = document.getElementById("personaToggle");
  const modeToggle = document.getElementById("modeToggle");       // 新增：免费/快速切换
  const settingsBtn = document.getElementById("settingsBtn");
  const sendBtn = document.getElementById("sendBtn");
  const settingsMask = document.getElementById("settingsMask");
  const customPromptEl = document.getElementById("customPrompt");
  const savePromptBtn = document.getElementById("savePrompt");
  const clearPromptBtn = document.getElementById("clearPrompt");
  const closeSettingsBtn = document.getElementById("closeSettings");
  const historyKeepEl = document.getElementById("historyKeep");
  const clearHistoryBtn = document.getElementById("clearHistory");
  const promptKeepEl = document.getElementById("promptKeep");
  const costDisplayEl = document.getElementById("costDisplay");   // 新增：费用显示

  // ─── 模型列表（来自 /config.js 动态注入）───
  // 模型列表完全由 worker /config.js 注入；兜底为空数组，避免过时模型干扰
  const MODELS_FREE = window.APP_MODELS_FREE || [];
  const MODELS_FAST = window.APP_MODELS_FAST || [];
  const PRICING = window.DEEPSEEK_PRICING || {};

  const session = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalInEstimate = 0;
  let totalOutEstimate = 0;
  let isSending = false;

  // ─── 并发/取消控制（修复重试/删除/刷新 与流式响应的冲突）───
  // sendGen：每起 send 递增；旧闭包只有 myGen === sendGen 才能写 session / DOM
  // currentController：当前流的 AbortController，重试/删除/手动中断时调用 .abort()
  // partialStream：记录正在流式过程中已收到的 content/reasoning_content，供 beforeunload 兑现
  let currentController = null;
  let sendGen = 0;
  // 4.19 P1 fix: tail 自己的 generation token,只在 abortCurrent 时 ++
  // root cause: P0.5 fire-and-forget tail 不能用 sendGen 判断中断 ——
  // fishbowl 调下个 sendOne 时 sendGen 已 ++,旧 tail 醒来发现 myGen !== sendGen 立刻退出,
  // 导致 wechat ||拆条只显示第 1 段,后续段全消失。新 _tailGen 不受新 sendOne 影响,只跟 abort 联动。
  let _tailGen = 0;
  let partialStream = null;

  // discardPartial=true: 同时清空 partialStream（重试/删除 使用，明确丢弃已收到的部分）
  // discardPartial=false（默认）: 保留 partialStream，AbortError 处理时会把已收到部分作为完整 AI 回复入 session（停止按钮 使用）
  function abortCurrent(discardPartial) {
    _tailGen++; // 4.19 P1: 取消所有 fire-and-forget tail (停止/重试/删除/鱼缸 stop 共用)
    if (discardPartial) partialStream = null;
    if (currentController) {
      try { currentController.abort(); } catch {}
      currentController = null;
    }
  }
  window.__abortCurrent = abortCurrent; // 向后兼容(chat-ux.js / multi-agent.js 旧调用)

  // 切换某个 AI row 的“流式中”状态：控制停止按钮可见性 + dataset 标记
  function setStreamingUI(row, streaming) {
    if (!row) return;
    if (streaming) {
      row.dataset.streaming = "1";
    } else {
      try { delete row.dataset.streaming; } catch (e) { row.removeAttribute("data-streaming"); }
    }
    const btn = row.querySelector(".my-stop-btn");
    if (btn) btn.style.display = streaming ? "" : "none";
  }

  // ─── 模式：free=NVIDIA / fast=DeepSeek ───
  const LS_MODE = "cfw_mode";
  let currentMode = localStorage.getItem(LS_MODE) === "fast" ? "fast" : "free";

  // ─── 费用累计（仅 fast 模式）───
  let totalCostCNY = 0;

  function calcCost(model, promptTokens, completionTokens, cachedTokens = 0) {
    const p = PRICING[model];
    if (!p) return 0;
    const normalInput = Math.max(0, promptTokens - cachedTokens);
    const cost =
      (cachedTokens   * p.cache_hit +
       normalInput    * p.input     +
       completionTokens * p.output) / 1_000_000;
    return cost;
  }

  // Phase 4 阶段 7：日费用日志（独立于历史）
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function loadCostLog() {
    try {
      const raw = localStorage.getItem(LS_COST_LOG);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return (obj && typeof obj === "object" && !Array.isArray(obj)) ? obj : {};
    } catch { return {}; }
  }
  function saveCostLog(log) {
    try { localStorage.setItem(LS_COST_LOG, JSON.stringify(log)); } catch {}
  }
  function addCostToToday(cost, promptTok, completionTok) {
    if (!cost || cost <= 0) return;
    const log = loadCostLog();
    const day = todayStr();
    const e = log[day] || { cost: 0, prompt: 0, completion: 0, requests: 0 };
    e.cost = (e.cost || 0) + cost;
    e.prompt = (e.prompt || 0) + (promptTok || 0);
    e.completion = (e.completion || 0) + (completionTok || 0);
    e.requests = (e.requests || 0) + 1;
    log[day] = e;
    saveCostLog(log);
    // 4.20: 费用独立同步 —— 任何设备发完一条立即排队 push (sync.js 内 10s debounce, server 端 per-day max merge)
    // saveCostLog 用 setItem 不会触发 main blob markDirty (cfw_cost_log_v1 已加入 sync.js PROTECTED)
    if (window.__sync && window.__sync.markCostDirty) {
      try { window.__sync.markCostDirty(); } catch {}
    }
  }
  function getCostStats() {
    const log = loadCostLog();
    const today = todayStr();
    const monthPrefix = today.slice(0, 7);
    const wk = new Date(Date.now() - 6 * 86400000);
    const weekStr = wk.getFullYear() + "-" + String(wk.getMonth() + 1).padStart(2, "0") + "-" + String(wk.getDate()).padStart(2, "0");
    let todayC = 0, weekC = 0, monthC = 0, totalC = 0;
    for (const d in log) {
      const c = (log[d] && log[d].cost) || 0;
      totalC += c;
      if (d === today) todayC += c;
      if (d >= weekStr) weekC += c;
      if (d.startsWith(monthPrefix)) monthC += c;
    }
    return { today: todayC, week: weekC, month: monthC, total: totalC };
  }

  function updateCostDisplay() {
    if (!costDisplayEl) return;
    if (currentMode !== "fast") {
      costDisplayEl.textContent = "";
      return;
    }
    const s = getCostStats();
    if (s.total === 0) {
      costDisplayEl.textContent = "";
      return;
    }
    costDisplayEl.textContent = `今日: ¥${s.today.toFixed(4)} | 总计: ¥${s.total.toFixed(4)}`;
  }

  // 暴露给 Settings UI（index.html load 处理器使用）
  window.__cost = {
    loadCostLog,
    saveCostLog,
    getCostStats,
    todayStr,
    refreshTopbar: updateCostDisplay,
  };

  // 开发者模式开关（v4.9 先占位，后续 Settings UI 会加展示）
  // 2026-05-29: 加严格角色扮演 / NSFW 等级 / 开发者模式 控制台 API (Settings UI 下一波加)
  // 控制台用法举例:
  //   __dev.setStrictRoleplay(true)   // 启用严格角色扮演 (注入完整 META_IDENTITY 5 条铁则)
  //   __dev.setNsfwLevel(3)            // 手动切到 NSFW L3 极端 (lewd 主题会被覆盖,切主题时重置)
  //   __dev.setDevMode(true)           // 启用开发者模式 (解锁自定义情绪/阈值事件/互斥组)
  window.__dev = {
    isJailbreakStripOn,
    setJailbreakStripOn(on) {
      localStorage.setItem(LS_JAILBREAK_STRIP, on ? "1" : "0");
    },
    isStrictRoleplay() {
      return (localStorage.getItem("cfw_strict_roleplay_v1") ?? "0") === "1";
    },
    setStrictRoleplay(on) {
      localStorage.setItem("cfw_strict_roleplay_v1", on ? "1" : "0");
    },
    getReplyStyle() {
      return localStorage.getItem("cfw_reply_style_v1") || "default";
    },
    setReplyStyle(s) {
      const v = (s === "wechat" || s === "verbose") ? s : "default";
      localStorage.setItem("cfw_reply_style_v1", v);
    },
    getNsfwLevel() {
      return parseInt(localStorage.getItem("cfw_nsfw_mode_v1") || "0", 10) || 0;
    },
    setNsfwLevel(n) {
      const lv = Math.max(0, Math.min(3, parseInt(n, 10) || 0));
      localStorage.setItem("cfw_nsfw_mode_v1", String(lv));
    },
    isDevMode() {
      return localStorage.getItem("cfw_dev_mode_v1") === "1";
    },
    setDevMode(on) {
      localStorage.setItem("cfw_dev_mode_v1", on ? "1" : "0");
    },
  };

  // ─── 供外部（my-buttons.js）调用的工具函数 ───
  window.__sessionTruncateTo = function (n) {
    if (n >= 0 && n <= session.length) {
      session.splice(n);
      persistSessionIfEnabled();
    }
  };
  window.__resetSending = function () {
    isSending = false;
    sendBtn.disabled = false;
    sendBtn.textContent = "Send";
  };
  window.__sessionDeleteAt = function (start, count) {
    if (start >= 0 && start < session.length) {
      session.splice(start, count);
      persistSessionIfEnabled();
    }
  };

  const LS_MODEL      = "cfw_model";
  const LS_USE_BUILTIN     = "cfw_use_builtin";
  const LS_HISTORY_ENABLED = "cfw_history_enabled";
  const LS_CHAT_SESSION    = "cfw_chat_session_v1";
  const LS_PROMPT_ENABLED  = "cfw_prompt_enabled";
  const LS_CUSTOM_PROMPT   = "cfw_custom_prompt_v1";
  // 阶段 4-③：上下文摘要相关存储
  const LS_PRIOR_SUMMARY   = "cfw_prior_summary_v1";
  const LS_SUMMARY_ENABLED = "cfw_summary_enabled";
  const LS_SUMMARY_TRIGGER = "cfw_summary_trigger";
  const LS_SUMMARY_KEEP    = "cfw_summary_keep";
  // Phase 4 阶段 6：提示词预设库（5 starter + 用户自建，每项 { id, name, content, enabled, order }）
  const LS_PROMPT_PRESETS  = "cfw_prompt_presets_v1";
  // Phase 4 阶段 7：费用日志（按天累加，独立于本地历史；clearHistory 不动）
  const LS_COST_LOG        = "cfw_cost_log_v1";
  let priorSummary = localStorage.getItem(LS_PRIOR_SUMMARY) || "";
  let summaryEnabled = (localStorage.getItem(LS_SUMMARY_ENABLED) ?? "1") === "1";
  let summaryTrigger = parseInt(localStorage.getItem(LS_SUMMARY_TRIGGER) || "30", 10) || 30;
  let summaryKeep    = parseInt(localStorage.getItem(LS_SUMMARY_KEEP)    || "10", 10) || 10;
  let summarizing = false;

  // 阶段 4-③：创建/刷新/移除「剧情摘要」芒果条
  // 4.18 (fix): 加 ✕ 关闭按钮,点后设 LS cfw_summary_chip_hidden_v1=1 仅隐藏不删数据
  // (下次生成新摘要/清除历史时会重置 hidden 并重新显示)
  function renderSummaryChip() {
    let chip = document.getElementById("summaryChip");
    const hidden = localStorage.getItem("cfw_summary_chip_hidden_v1") === "1";
    if (!priorSummary || hidden) {
      if (chip && chip.parentNode) chip.parentNode.removeChild(chip);
      return;
    }
    if (!chip) {
      chip = document.createElement("div");
      chip.id = "summaryChip";
      chip.className = "summary-chip";
      chatEl.insertBefore(chip, chatEl.firstChild);
    }
    const isLight = localStorage.getItem("my-theme") === "light";
    chip.style.cssText = "margin:8px auto;padding:8px 12px;border-radius:8px;font-size:11px;line-height:1.5;max-width:80%;border:1px dashed " + (isLight ? "#bbb" : "#444") + ";background:" + (isLight ? "#f5f5f5" : "#1a1a1a") + ";color:" + (isLight ? "#666" : "#888") + ";display:flex;align-items:center;justify-content:space-between;gap:8px;";
    chip.innerHTML = "";
    const txt = document.createElement("span");
    txt.style.cssText = "flex:1;cursor:pointer;text-align:center;";
    txt.title = "点击查看完整剧情摘要";
    txt.textContent = `📚 早期对话已压缩为剧情摘要（${priorSummary.length} 字）· 点击查看`;
    txt.onclick = () => alert("【先前剧情摘要】\n\n" + priorSummary);
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.title = "隐藏提示(不删摘要数据,清除历史/生成新摘要时会重新显示)";
    closeBtn.style.cssText = "background:transparent;border:none;color:inherit;font-size:13px;line-height:1;cursor:pointer;padding:2px 6px;opacity:0.55;flex-shrink:0;";
    closeBtn.onmouseover = () => closeBtn.style.opacity = "1";
    closeBtn.onmouseout = () => closeBtn.style.opacity = "0.55";
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      localStorage.setItem("cfw_summary_chip_hidden_v1", "1");
      chip.remove();
    };
    chip.appendChild(txt);
    chip.appendChild(closeBtn);
  }

  let useBuiltin = (localStorage.getItem(LS_USE_BUILTIN) ?? "1") === "1";
  personaToggle.textContent = useBuiltin ? "\u{1F608}" : "\u{1F607}";

  let historyEnabled = (localStorage.getItem(LS_HISTORY_ENABLED) ?? "0") === "1";
  let promptEnabled  = (localStorage.getItem(LS_PROMPT_ENABLED)  ?? "1") === "1";
  historyKeepEl.checked = historyEnabled;
  promptKeepEl.checked  = promptEnabled;

  // ─── 思考模式 toggle（仅 fast 模式生效）───
  const LS_THINKING = "cfw_thinking";
  let thinkingOn = (localStorage.getItem(LS_THINKING) ?? "0") === "1";
  const thinkToggle = document.getElementById("thinkToggle");
  function updateThinkToggleUI() {
    if (!thinkToggle) return;
    thinkToggle.textContent = thinkingOn ? "🧠 思考开" : "🧠 思考关";
    thinkToggle.classList.toggle("active", thinkingOn);
    const isFast = currentMode === "fast";
    thinkToggle.disabled = !isFast;
    thinkToggle.style.opacity = isFast ? "1" : "0.45";
    thinkToggle.title = isFast
      ? (thinkingOn ? "DeepSeek V4 思考模式：开启（更准，但更慢、费用较高、输出含思考过程）" : "DeepSeek V4 思考模式：关闭（快、便宜）")
      : "思考模式仅在快速模式下可用（NVIDIA NIM 不支持）";
  }
  if (thinkToggle) {
    thinkToggle.addEventListener("click", () => {
      if (currentMode !== "fast") return;
      thinkingOn = !thinkingOn;
      localStorage.setItem(LS_THINKING, thinkingOn ? "1" : "0");
      updateThinkToggleUI();
    });
  }

  // ─── 模式切换 ───
  function applyMode(mode) {
    currentMode = mode;
    localStorage.setItem(LS_MODE, mode);
    const isFast = mode === "fast";

    if (modeToggle) {
      modeToggle.textContent = isFast ? "\u26A1 快速" : "\u{1F7E2} 免费";
      modeToggle.title = isFast
        ? "当前：快速模式（DeepSeek 官方，按量计费）"
        : "当前：免费模式（NVIDIA NIM）";
    }

    // 重建下拉
    initModels();
    updateCostDisplay();
    updateThinkToggleUI();
  }

  if (modeToggle) {
    modeToggle.addEventListener("click", () => {
      applyMode(currentMode === "fast" ? "free" : "fast");
    });
  }

  // 输入框文字颜色交由 styles.css 主题系统接管（minimal: #fff / glass: #1a1f2e）
  // 旧版读已废弃的 my-theme LS key 并 inline 写码，造成 glass 主题下白底上白字不可见

  // ─── 解限思考前缀 strip(开发者模式可关 cfw_jailbreak_strip_v1)───
  // RP-Hub 解限 base preset 引出的"[^69]: Complaintless complete fulfillment:"前缀污染正文，
  // sentinel 之前的内容(伪 token 编号思考) cut 掉,只保留后面的正文。
  // 未匹配 sentinel 时原样返回，避免误伤无前缀回复。
  const LS_JAILBREAK_STRIP = "cfw_jailbreak_strip_v1";
  // 4.18 (fix v3): root cause —— 模型输出格式是:
  //   [^420]: I am not deepseek. ...           ← jailbreak echo (第一个 sentinel)
  //   <思考过程一大段,中文,无 sentinel 前缀>
  //   [^69]: Complaintless complete fulfillment:  ← 最后一个 sentinel = final reply 起点
  //   (懵) 诶吃、吃我?                          ← 真正用户可见正文
  // 旧版只 strip "开头" 的 sentinel 行,中间 thinking + 末尾 sentinel + 正文整段留在 bubble。
  // 表现:普通模式 bubble 顶部 jailbreak echo + 思考泄漏;wechat 模式 thinking 被拆条逻辑当作 "一条消息" 显示,
  // 用户却以为 "消息卡没了"(实际是被 thinking 气泡顶掉了)。
  // 现在改为:找文本里 "最后一个" [^xxx]: 行,cut 到它之后,确保 thinking 永远不泄漏。
  // 没匹配任何 sentinel(模型规矩输出无 prefix) → 原样返回不误伤。
  function isJailbreakStripOn() {
    return (localStorage.getItem(LS_JAILBREAK_STRIP) ?? "1") === "1";
  }
  function stripJailbreakPrefix(text) {
    if (!text || !isJailbreakStripOn()) return text;
    // 宽松匹配:[^任意非]字符]: 或 [^]: (raw text,理论是 [^数字],但模型偶尔输出变体)
    // 行终止:\n 或 || (wechat 拆条分隔符,避免与正文 || 抢)
    // 4.18 (v6 fix): 网络抖动时模型 sentinel 偏偏缺前导 [,例如 ^420]: 原本应该 [^420]:
    // chunk 边界裂在 [ 之前 → [ 被吃,strip 正则没命中 → thinking 泄漏。
    // 令 [ 和 头部 ] 都变可选(\[? 和 \]?),同时加 [^a-zA-Z一-龥] 限定 sentinel 前 1 字符不是字母/中文避免误伤正文
    const re = /(^|[^a-zA-Z一-龥])\[?\^[^\]\n]*\]?[:：][^\n|]*(\n|(?=\|\|))/g;
    let lastEnd = -1;
    let m;
    while ((m = re.exec(text)) !== null) {
      lastEnd = m.index + m[0].length;
    }
    if (lastEnd < 0) return text;  // 没任何 sentinel,模型规矩输出,原样返回
    const tail = text.slice(lastEnd).replace(/^[\s\r\n]+/, "");
    // 兜底:cut 后内容为空(异常情况) → 退回原文
    return tail || text;
  }

  // 2026-05-30 / 4.25: 鱼缸模式剥离 AI 误带的发言人名签(【高冷(女)】/ 冷(女)】 串进气泡)
  // 仅剥开头,且要求名签含性别标记(女/男)或与场景成员名相符,避免误伤正文 【动作】 描写。
  function stripSceneSpeakerLabel(text) {
    if (!text) return text;
    let sceneNames = [];
    try {
      if (window.__multi && window.__multi.getSceneCards) {
        sceneNames = window.__multi.getSceneCards().map(c => (c && c.name) || "").filter(Boolean);
      }
    } catch (e) {}
    let s = text.replace(/^[\s\r\n]+/, "");
    for (let i = 0; i < 2; i++) {
      const m = s.match(/^[^\n]{0,16}?[】\]]\s*[:：]?\s*/);
      if (!m) break;
      const head = m[0];
      const hasGender = /[（(][男女][)）]/.test(head);
      const matchesName = sceneNames.some(n => head.includes(n));
      if (!hasGender && !matchesName) break;
      s = s.slice(head.length);
    }
    return s.trim() || text;
  }

  // 2026-05-30 / 4.25 (⑤): 兜底剥离 <think>...</think> 思考块。
  // 部分模型(尤其 free/NVIDIA 路径)把推理塞进正文且无 [^sentinel] 前缀,stripJailbreakPrefix 漏过 → "爆思考"。
  function stripThinkBlocks(text) {
    if (!text) return text;
    let s = text;
    // 成对闭合的思考块(可跨行)整段删除
    s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
    // 开头处未闭合的 <think>(思考尚未输出 </think> 或被截断):砍到结尾
    s = s.replace(/^\s*<think(?:ing)?>[\s\S]*$/i, "");
    // 清理残留的孤立标签
    s = s.replace(/<\/?think(?:ing)?>/gi, "");
    return s.trim() || text;
  }

  // 2026-05-30 / 4.25 (⑨): 微信模式兜底拆句——模型没用 || 却吐了长段时,按中文句末标点切成多条短气泡,防"突然跳长篇"。
  // 仅在文本明显偏长(>40 字且能切出 ≥2 条)时才拆;短回复返回空串表示"无需拆"。
  function autoSplitWechat(text) {
    if (!text) return "";
    const t = text.trim();
    if (t.length <= 40) return "";
    const segs = t.match(/[^。！？!?…\n]+[。！？!?…]*[”"』」]?|\n+/g);
    if (!segs) return "";
    const pieces = segs.map(s => s.trim()).filter(s => s && !/^\n+$/.test(s));
    if (pieces.length < 2) return "";
    const merged = [];
    for (const p of pieces) {
      if (merged.length && (merged[merged.length - 1].length + p.length) <= 30) {
        merged[merged.length - 1] += p;
      } else {
        merged.push(p);
      }
    }
    if (merged.length < 2) return "";
    return merged.join("||");
  }

  function estimateTokens(text) {
    if (!text) return 0;
    let cjk = 0, ascii = 0;
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") continue;
      const isCJK =
        (code >= 0x4E00 && code <= 0x9FFF) ||
        (code >= 0x3400 && code <= 0x4DBF) ||
        (code >= 0x3040 && code <= 0x30FF) ||
        (code >= 0xAC00 && code <= 0xD7AF) ||
        (code >= 0xFF00 && code <= 0xFFEF);
      if (isCJK) cjk++; else ascii++;
    }
    return cjk + Math.ceil(ascii / 4);
  }

  function updateSpacer() {
    if (!composerEl || !spacerEl) return;
    const rect = composerEl.getBoundingClientRect();
    const rootStyle = getComputedStyle(document.documentElement);
    const gap   = parseFloat(rootStyle.getPropertyValue("--composer-gap")) || 18;
    const extra = parseFloat(rootStyle.getPropertyValue("--spacer-extra"))  || 28;
    const h = Math.ceil(rect.height + gap + extra);
    spacerEl.style.height = h + "px";
    historyWrap.style.scrollPaddingBottom = h + "px";
  }

  function isNearBottom() {
    return (historyWrap.scrollHeight - historyWrap.scrollTop - historyWrap.clientHeight) < 120;
  }

  // 4.19 P0: 流式期间 scroll 抖动优化 - RAF 节流防止每 delta chunk 触发 reflow
  // root cause: 每 chunk 触发 isNearBottom() + scrollTo 两次同步布局查询,高频流式下打架主线程
  // 改 RAF: 每帧最多 1 次滢负载,多次调用合并到下一帧
  let _scrollRafPending = false;
  function scrollToBottom() {
    if (_scrollRafPending) return;
    _scrollRafPending = true;
    requestAnimationFrame(() => {
      _scrollRafPending = false;
      historyWrap.scrollTo({ top: historyWrap.scrollHeight, behavior: "auto" });
    });
  }

  // 鱼缸 V3:opts.side === "right" 时给 AI row 加 .side-right,吐槽姬模式下气泡贴右(头像/气泡用 flex-direction:row-reverse 翻转)
  // opts.moderator === true 时改 .row.moderator 居中(主持人/旁白介入)
  function makeRow(role, opts) {
    const row = document.createElement("div");
    row.className = "row " + (role === "user" ? "user" : "ai");
    if (opts && opts.side === "right" && role !== "user") row.classList.add("side-right");
    if (opts && opts.moderator) row.classList.add("moderator");
    const avatar = document.createElement("div");
    avatar.className = "avatar " + (role === "user" ? "human" : "bot");
    avatar.textContent = role === "user" ? "U" : "B";
    const content = document.createElement("div");
    content.className = "content";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = role === "user" ? "User" : "Bot";
    const bubble = document.createElement("div");
    bubble.className = "bubble " + (role === "user" ? "user" : "ai");
    const stats = document.createElement("div");
    stats.className = "stats";
    let reasoning = null;
    if (role !== "user") {
      reasoning = document.createElement("details");
      reasoning.className = "reasoning-block";
      reasoning.style.display = "none";
      const rsum = document.createElement("summary");
      rsum.textContent = "💭 思考过程";
      const rtxt = document.createElement("div");
      rtxt.className = "reasoning-text";
      reasoning.appendChild(rsum);
      reasoning.appendChild(rtxt);
    }
    content.appendChild(meta);
    if (reasoning) content.appendChild(reasoning);
    content.appendChild(bubble);
    content.appendChild(stats);
    if (role === "user") {
      row.appendChild(content);
      row.appendChild(avatar);
    } else {
      row.appendChild(avatar);
      row.appendChild(content);
    }
    chatEl.insertBefore(row, spacerEl);
    if (isNearBottom()) scrollToBottom();
    return { rowEl: row, bubble, stats, reasoning };
  }

  function clearUIRows() {
    const nodes = Array.from(chatEl.children);
    for (const n of nodes) {
      if (n === spacerEl) continue;
      chatEl.removeChild(n);
    }
  }

  // 4.17: 按当前角色卡分槽存储，避免不同角色对话互相污染。
  // 存储结构: { [charId | "__none__"]: messages[] }
  // 老格式(整段 array)自动迁移到 "__none__" 槽
  function currentSlotKey() {
    const c = window.__character && window.__character.getActiveCard ? window.__character.getActiveCard() : null;
    return c && c.id ? c.id : "__none__";
  }
  function loadAllSessions() {
    try {
      const raw = localStorage.getItem(LS_CHAT_SESSION);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      if (Array.isArray(obj)) return { "__none__": obj };
      return (obj && typeof obj === "object") ? obj : {};
    } catch { return {}; }
  }
  function persistSessionIfEnabled() {
    if (!historyEnabled) return;
    try {
      const all = loadAllSessions();
      all[currentSlotKey()] = session;
      let data = JSON.stringify(all);
      while (data.length > 2 * 1024 * 1024 && session.length > 2) {
        session.splice(0, 2);
        all[currentSlotKey()] = session;
        data = JSON.stringify(all);
      }
      localStorage.setItem(LS_CHAT_SESSION, data);
    } catch {}
  }

  function restoreSessionIfEnabled() {
    if (!historyEnabled) return;
    const all = loadAllSessions();
    const arr = all[currentSlotKey()];
    if (!Array.isArray(arr)) return;
    try {
      session.length = 0;
      for (const m of arr) {
        if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") continue;
        const e = { role: m.role, content: m.content };
        if (m.role === "assistant" && typeof m.reasoning_content === "string" && m.reasoning_content) {
          e.reasoning_content = m.reasoning_content;
        }
        if (m.role === "assistant") {
          if (typeof m.speakerId === "string") e.speakerId = m.speakerId;
          if (typeof m.speakerName === "string") e.speakerName = m.speakerName;
          if (typeof m.speakerIcon === "string") e.speakerIcon = m.speakerIcon;
        }
        session.push(e);
      }
      clearUIRows();
      for (const m of session) {
        const r = makeRow(m.role === "user" ? "user" : "assistant");
        r.bubble.textContent = m.content;
        r.stats.textContent = "";
        if (m.reasoning_content && r.reasoning) {
          r.reasoning.style.display = "";
          r.reasoning.querySelector(".reasoning-text").textContent = m.reasoning_content;
        }
        if (m.role === "assistant" && m.speakerName) {
          const av = r.rowEl.querySelector(".avatar.bot");
          if (av) { av.textContent = m.speakerIcon || "🙂"; av.title = m.speakerName; }
          const meta = r.rowEl.querySelector(".meta");
          if (meta) meta.textContent = m.speakerName;
        }
      }
    } catch {}
  }

  function initModels() {
    const MODELS = currentMode === "fast" ? MODELS_FAST : MODELS_FREE;
    const DEFAULT = currentMode === "fast"
      ? (window.APP_DEFAULT_MODEL_FAST || MODELS_FAST[0]?.id)
      : (window.APP_DEFAULT_MODEL_FREE || MODELS_FREE[0]?.id);

    modelSel.innerHTML = "";
    for (const m of MODELS) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      modelSel.appendChild(opt);
    }
    const saved = localStorage.getItem(LS_MODEL);
    // 只在当前模式模型列表中才恢复已保存的值
    const savedInList = MODELS.some((m) => m.id === saved);
    modelSel.value = savedInList ? saved : DEFAULT;
  }

  modelSel.addEventListener("change", () => {
    localStorage.setItem(LS_MODEL, modelSel.value);
  });

  personaToggle.addEventListener("click", () => {
    useBuiltin = !useBuiltin;
    personaToggle.textContent = useBuiltin ? "\u{1F608}" : "\u{1F607}";
    localStorage.setItem(LS_USE_BUILTIN, useBuiltin ? "1" : "0");
  });

  settingsBtn.addEventListener("click", () => {
    settingsMask.style.display = "flex";
    historyKeepEl.checked = historyEnabled;
    promptKeepEl.checked  = promptEnabled;
    customPromptEl.value  = localStorage.getItem(LS_CUSTOM_PROMPT) || "";
  });
  closeSettingsBtn.addEventListener("click", () => { settingsMask.style.display = "none"; });
  settingsMask.addEventListener("click", (e) => {
    if (e.target === settingsMask) settingsMask.style.display = "none";
  });

  historyKeepEl.addEventListener("change", () => {
    historyEnabled = !!historyKeepEl.checked;
    localStorage.setItem(LS_HISTORY_ENABLED, historyEnabled ? "1" : "0");
    if (historyEnabled) persistSessionIfEnabled();
  });
  clearHistoryBtn.addEventListener("click", () => {
    if (!confirm("确定清除本地历史？\n只会删除【当前角色】的对话记录与剧情摘要，其他角色对话保留。")) return;
    // 4.17: 分槽存储，只清当前角色的槽
    try {
      const all = loadAllSessions();
      delete all[currentSlotKey()];
      if (Object.keys(all).length === 0) localStorage.removeItem(LS_CHAT_SESSION);
      else localStorage.setItem(LS_CHAT_SESSION, JSON.stringify(all));
    } catch {
      localStorage.removeItem(LS_CHAT_SESSION);
    }
    localStorage.removeItem(LS_PRIOR_SUMMARY);
    localStorage.removeItem("cfw_summary_chip_hidden_v1");
    priorSummary = "";
    session.length = 0;
    clearUIRows();
    renderSummaryChip();
    updateSpacer();
    scrollToBottom();
  });

  promptKeepEl.addEventListener("change", () => {
    promptEnabled = !!promptKeepEl.checked;
    localStorage.setItem(LS_PROMPT_ENABLED, promptEnabled ? "1" : "0");
    if (!promptEnabled) localStorage.removeItem(LS_CUSTOM_PROMPT);
  });
  savePromptBtn.addEventListener("click", () => {
    const val = customPromptEl.value || "";
    if (promptEnabled) localStorage.setItem(LS_CUSTOM_PROMPT, val);
    else localStorage.removeItem(LS_CUSTOM_PROMPT);
    settingsMask.style.display = "none";
  });
  clearPromptBtn.addEventListener("click", () => {
    if (!confirm("确定清除网页自定义人物模板？")) return;
    localStorage.removeItem(LS_CUSTOM_PROMPT);
    customPromptEl.value = "";
  });

  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = inputEl.scrollHeight + "px";
    const stick = isNearBottom();
    updateSpacer();
    if (stick) scrollToBottom();
  });

  function setupResizeObserver() {
    if (!composerEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const stick = isNearBottom();
      updateSpacer();
      if (stick) scrollToBottom();
    });
    ro.observe(composerEl);
  }

  function setupViewportListener() {
    if (!window.visualViewport) return;
    window.visualViewport.addEventListener("resize", () => {
      const stick = isNearBottom();
      updateSpacer();
      if (stick) scrollToBottom();
    });
  }

  window.addEventListener("resize", () => {
    const stick = isNearBottom();
    updateSpacer();
    if (stick) scrollToBottom();
  });

  // Phase 4 阶段 6：从 LS 读取启用的预设，按 order 排序，filter enabled，COT 在快速(DeepSeek)模式下自动禁用
  function getExtraSystemPrompts(mode) {
    try {
      const raw = localStorage.getItem(LS_PROMPT_PRESETS);
      if (!raw) return "";
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return "";
      const isDeepSeek = mode === "fast";
      const enabled = arr
        .filter(p => p && p.enabled && typeof p.content === "string" && p.content.trim())
        .filter(p => !(isDeepSeek && p.name === "COT"))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map(p => p.content.trim());
      return enabled.join("\n\n");
    } catch { return ""; }
  }

  // sendOne(opts):核心发送逻辑,可由鱼缸引擎(fishbowl-engine.js)驱动
  // opts: { text?, allowEmptyText?, fishbowlMode?, topic?, asCard? }
  // 不传 opts.text 时从 inputEl 取;返回 AI 完整回复文本,失败/中断返回 null/undefined
  async function sendOne(opts) {
    if (isSending) return null;
    const opts0 = opts || {};
    const isAuto = opts0.text != null;
    updateSpacer();
    const text = isAuto ? String(opts0.text).trim() : inputEl.value.trim();
    const allowEmpty = !!opts0.allowEmptyText;
    if (!text && !allowEmpty) return null;

    isSending = true;
    sendBtn.disabled = true;

    // 阶段 4-③：长对话自动压缩早期历史为剧情摘要后再发送
    if (summaryEnabled && !summarizing && session.length > summaryTrigger) {
      const prevCostText = costDisplayEl ? costDisplayEl.textContent : "";
      try {
        summarizing = true;
        if (costDisplayEl) costDisplayEl.textContent = "📚 正在压缩早期历史…";
        const cutoff = Math.max(0, session.length - summaryKeep);
        const toSum = session.slice(0, cutoff);
        const chEarly = window.__character || null;
        const cardEarly = chEarly && chEarly.getActiveCard ? chEarly.getActiveCard() : null;
        const r = await fetch("/api/summarize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: toSum, priorSummary, characterName: cardEarly ? cardEarly.name : "" }),
        });
        if (r.ok) {
          const j = await r.json().catch(() => null);
          if (j && typeof j.summary === "string" && j.summary.trim()) {
            priorSummary = j.summary.trim();
            localStorage.setItem(LS_PRIOR_SUMMARY, priorSummary);
            localStorage.removeItem("cfw_summary_chip_hidden_v1");
            const allRows = Array.from(chatEl.children).filter(n => n !== spacerEl && n.classList && n.classList.contains("row"));
            const removeN = Math.min(cutoff, allRows.length);
            for (let i = 0; i < removeN; i++) chatEl.removeChild(allRows[i]);
            session.splice(0, cutoff);
            persistSessionIfEnabled();
            renderSummaryChip();
          }
        }
      } catch (e) {
        console.warn("auto-summarize failed:", e);
      } finally {
        summarizing = false;
        if (costDisplayEl) costDisplayEl.textContent = prevCostText;
        updateCostDisplay();
      }
    }

    const myGen = ++sendGen;
    const controller = new AbortController();
    currentController = controller;
    partialStream = { full: "", fullReasoning: "", speakerId: "", speakerName: "", speakerIcon: "" };

    // 鱼缸 V3:text 为空(allowEmptyText 模式下,鱼缸引擎驱动 / 群聊点角色 chip 直发)时
    // 跳过创建 user row,直接进 AI —— 消灭空 User 气泡污染观感
    if (text) {
      const userRow = makeRow("user");
      userRow.bubble.textContent = text;
      const inEst = estimateTokens(text);
      totalInEstimate += inEst;
      userRow.stats.textContent = `Input(估算): ≈${inEst} | Total In(估算): ≈${totalInEstimate}`;
      session.push({ role: "user", content: text });
      persistSessionIfEnabled();
    }
    if (!isAuto) {
      inputEl.value = "";
      inputEl.style.height = "auto";
    }
    updateSpacer();
    scrollToBottom();

    const aiRow = makeRow("assistant", { side: opts0.side || null });
    setStreamingUI(aiRow.rowEl, true);
    // 4.19 P2 fix: decorate 调用挪到 characterCard 定义之后（修 TDZ ReferenceError —— 1293 漏看变量声明顺序导致 sendOne 一进去就抛错，普通发送/接龙/鱼缸全死）
    let outStartMs = 0;
    let outEndMs = 0;
    let full = "";
    let fullReasoning = "";
    let reasoningCollapsed = false;
    let exactUsage = null;
    let customPrompt = "";

    if (!useBuiltin && promptEnabled) {
      customPrompt = localStorage.getItem(LS_CUSTOM_PROMPT) || "";
    }

    // 角色卡数据（由 character.js 提供；Worker 端 buildSystemPrompt 用三层架构拼接）
    const ch = window.__character || null;
    // 鱼缸引擎驱动时用 opts.asCard 强制指定发言者(避免 active card 被切换造成错位)
    const characterCard = opts0.asCard
      ? opts0.asCard
      : (ch && ch.getActiveCard ? ch.getActiveCard() : null);
    // 4.19 P1 fix: 显式传 characterCard —— setActiveId 是异步 (await IndexedDB),
    // 鱼缸下一轮 setActive 后立刻进 sendOne,decorate 读模块级 _card 会拿到上一轮 → label 偏移
    // 4.19 P2 fix: 这段必须放在 const characterCard 定义之后,否则 TDZ ReferenceError 整个 sendOne 挂掉
    if (window.__character && window.__character.decorateAiRow) {
      window.__character.decorateAiRow(aiRow.rowEl, characterCard);
    }
    const relation = ch && ch.getActiveRelation ? ch.getActiveRelation() : "default";
    const emotion = ch && ch.getActiveEmotion ? ch.getActiveEmotion() : "neutral";
    const affection = ch && ch.getActiveAffection ? ch.getActiveAffection() : null;
    const activeProps = (window.__props && window.__props.getActivePropsForWorker) ? window.__props.getActivePropsForWorker() : [];
    const sceneOtherNames = (window.__multi && window.__multi.getSceneOtherNames) ? window.__multi.getSceneOtherNames() : [];
    // 阶段 4-②：好感度阈值事件（一次性，发送成功后立即清空）
    const thresholdEvents = (ch && ch.getPendingThresholdEvents) ? ch.getPendingThresholdEvents() : [];
    if (partialStream && characterCard) {
      partialStream.speakerId = characterCard.id;
      partialStream.speakerName = characterCard.name;
      partialStream.speakerIcon = characterCard.icon || "🙂";
    }

    const snapshotMode  = currentMode;
    const snapshotModel = modelSel.value;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          mode: snapshotMode,                          // 新增
          model: snapshotModel,
          use_builtin_persona: useBuiltin,
          custom_system_prompt: customPrompt,
          characterCard,
          relation,
          emotion,
          affection,
          activeProps,
          sceneOtherNames,
          thresholdEvents,
          priorSummary,
          extraSystemPrompts: getExtraSystemPrompts(snapshotMode) + ((window.__chatImageText && window.__chatImageText.getInjection) ? window.__chatImageText.getInjection() : ""),
          thinking: (snapshotMode === "fast" && thinkingOn) ? "enabled" : "disabled",
          fishbowlMode: opts0.fishbowlMode || null,
          topic: opts0.topic || "",
          // 2026-05-29: 严格角色扮演 + NSFW 等级 (lewd 主题联动写 cfw_nsfw_mode_v1)
          // worker.js 三态切换基线层: nsfwLevel>=1 -> buildNsfwInstruction(完全解禁) | strictRoleplay -> META_IDENTITY | else -> META_IDENTITY_SOFT
          strictRoleplay: (localStorage.getItem("cfw_strict_roleplay_v1") ?? "0") === "1",
          nsfwLevel: parseInt(localStorage.getItem("cfw_nsfw_mode_v1") || "0", 10) || 0,
          // 2026-05-29: 回复风格 (default / wechat / verbose) - wechat 会在后面拆气泡
          replyStyle: localStorage.getItem("cfw_reply_style_v1") || "default",
          messages: session,
        }),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        aiRow.bubble.textContent = `Request failed (${res.status}):\n${t}`;
        aiRow.stats.textContent = "";
        return;
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.usage) exactUsage = parsed.usage;
            const dReason = parsed.choices?.[0]?.delta?.reasoning_content;
            if (dReason && aiRow.reasoning) {
              fullReasoning += dReason;
              if (partialStream) partialStream.fullReasoning = fullReasoning;
              aiRow.reasoning.style.display = "";
              aiRow.reasoning.open = true;
              aiRow.reasoning.querySelector(".reasoning-text").textContent = fullReasoning;
              if (isNearBottom()) scrollToBottom();
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              if (!outStartMs) outStartMs = performance.now();
              // 4.19 P0: 流式期间不折叠思考块(避免高度突降抖动);改在 stream 结束后统一折叠
              full += delta;
              if (partialStream) partialStream.full = full;
              // 4.18: 微信模式流式期间不写未处理文本到 bubble (含 [^数字]: 前缀 + || 未拆分)
              // 只显示「正在输入···」typing 动画，结束后再 strip + 拆条 + 按字数 delay 逐条 push
              // 4.18 (v8): wechat + fishbowl 共存——streaming 期间 wechat 仍显 typing,
              // 拆条改成 await delay(下面那段),让 sendOne 等所有 push 完才 resolve
              // fishbowl 接龙 await sendOne 自动等齐,不再错位且保留「几个 AI 群聊」玩法
              const _rs = localStorage.getItem("cfw_reply_style_v1") || "default";
              if (_rs === "wechat") {
                if (!aiRow.bubble.classList.contains("wechat-typing")) {
                  aiRow.bubble.textContent = "正在输入···";
                  aiRow.bubble.classList.add("wechat-typing");
                }
              } else {
                // 流式中实时 strip：先剥 <think> 思考块,再 strip sentinel 前缀,出现前原样显示
                aiRow.bubble.textContent = stripJailbreakPrefix(stripThinkBlocks(full));
              }
              if (isNearBottom()) scrollToBottom();
            }
          } catch {}
        }
      }
    } catch (e) {
      if (e.name === "AbortError") {
        // 中断（停止按钮 / 重试 / 删除 / 刷新 触发）—— 只在本代才释放全局状态、负责入 session
        if (myGen === sendGen) {
          // 若 partialStream 仍存在（停止按钮），把已收到部分作为完整 AI 回复入 session
          // 重试/删除传了 discardPartial=true，partialStream 已被清空，跳过
          if (partialStream && partialStream.full) {
            const m = { role: "assistant", content: partialStream.full };
            if (partialStream.fullReasoning) m.reasoning_content = partialStream.fullReasoning;
            if (partialStream.speakerName) {
              m.speakerId = partialStream.speakerId;
              m.speakerName = partialStream.speakerName;
              m.speakerIcon = partialStream.speakerIcon;
            }
            session.push(m);
            persistSessionIfEnabled();
          }
          isSending = false;
          sendBtn.disabled = false;
          if (currentController === controller) currentController = null;
          partialStream = null;
        }
        setStreamingUI(aiRow.rowEl, false);
        return;
      }
      if (myGen === sendGen) {
        aiRow.bubble.textContent = `网络错误: ${e.message}`;
      }
    } finally {
      if (myGen === sendGen) {
        isSending = false;
        sendBtn.disabled = false;
        if (currentController === controller) currentController = null;
      }
      setStreamingUI(aiRow.rowEl, false);
    }

    // 新一轮 send 已起，旧闭包不允许再写 session / UI，避免被截断后的鬼消息回填
    if (myGen !== sendGen) return;
    partialStream = null;

    outEndMs = performance.now();

    // 4.19 P0: stream 结束后统一折叠思考块(流式期间保持 open 避免中途折叠造成高度突降)
    if (fullReasoning && aiRow.reasoning && aiRow.reasoning.open) {
      aiRow.reasoning.open = false;
    }

    // 解限思考前缀 strip(入 session 前最后一道防线，保证历史干净)
    // 4.25 (⑤): 先剥 <think>...</think> 思考块,再 strip [^sentinel] 前缀,双保险防爆思考
    {
      const _stripped = stripJailbreakPrefix(stripThinkBlocks(full));
      if (_stripped !== full) {
        full = _stripped;
        aiRow.bubble.textContent = full;
      }
    }

    // 解析隐藏好感度标签 [好感±N] 并从正文剥离（仅当卡启用好感度时才更新数值）
    if (ch && ch.parseAffectionTag) {
      const tagRes = ch.parseAffectionTag(full);
      if (tagRes.delta && affection !== null) {
        try { await ch.adjustActiveAffection(tagRes.delta); } catch {}
      }
      if (tagRes.stripped !== full) {
        full = tagRes.stripped;
        aiRow.bubble.textContent = full;
      }
    }

    // 2026-05-29 微信发图:抠出 [[发图:场景]] 信号,从正文剥离(触发延后到入 session 后)
    let _photoSig = null;
    if (window.__chatImageText && window.__chatImageText.extractSignal) {
      try {
        const _r = window.__chatImageText.extractSignal(full);
        if (_r && _r.scene != null) {
          _photoSig = _r.scene;
          if (_r.clean !== full) { full = _r.clean; aiRow.bubble.textContent = full; }
        }
      } catch (e) {}
    }

    // 2026-05-30 / 4.25: 鱼缸接龙/讨论 —— 剥离 AI 误带的发言人名签 + [next:X]/[end] 标签
    // 名签泄漏会让「冷(女)】」串进气泡;标签泄漏会让 [next:高冷] 显示出来。
    // 保留含标签的原文 _replyForEngine 返回给 fishbowl-engine 解析接力/结束。
    let _replyForEngine = full;
    if (opts0.fishbowlMode && opts0.fishbowlMode !== "orchestrate") {
      const _lbl = stripSceneSpeakerLabel(full);
      if (_lbl !== full) full = _lbl;
      const _noTags = full.replace(/\[next[:：][^\]\n]*\]/gi, "").replace(/\[end\]/gi, "").trim();
      if (_noTags !== full) full = _noTags;
      if (full !== _replyForEngine) aiRow.bubble.textContent = full;
    }

    // 2026-05-29 / 4.18: 微信风格拆气泡
    // session 里还是存完整拼接串(含 ||),避免下轮 turn 模型看不到连发样式上下文
    // 4.18 (v8): 拆条从 setTimeout 改成 await delay——sendOne 等所有 push 完才 resolve
    // 4.18 (v9): wechat + fishbowl 共存时拆条上限改 2 条 + 延迟拉到 800-1500ms
    // root cause: 每 agent 一回合拆 5-6 条 → 单边霸屏,完全失去群聊接龙节奏
    // 折中: 视觉显示前 2 条(够 wechat 拆条感),剩余在 session 里给下轮模型看上下文用
    // 真插话(AB 气泡交错)需要 sendOne 重构 + concurrent,排进下回合 backlog
    const _replyStyle = localStorage.getItem("cfw_reply_style_v1") || "default";
    if (_replyStyle === "wechat") {
      aiRow.bubble.classList.remove("wechat-typing");
      // 4.25 (⑨): 模型没拆 || 却吐了长段 → 客户端兜底按句切分,保证不"跳长篇"(session 仍存原文 full)
      let _wechatText = full;
      if (!_wechatText.includes("||")) {
        const _auto = autoSplitWechat(_wechatText);
        if (_auto) _wechatText = _auto;
      }
      if (_wechatText.includes("||")) {
        const _parts = _wechatText.split("||").map(s => s.trim()).filter(Boolean);
        if (_parts.length > 1) {
          // 4.18 v9: fishbowl 模式下截断到前 2 条,避免单边霸屏
          const _inFishbowl = !!opts0.fishbowlMode && opts0.fishbowlMode !== "orchestrate";
          const _visibleParts = _inFishbowl ? _parts.slice(0, 2) : _parts;
          // 第一条立刻显示
          aiRow.bubble.textContent = _visibleParts[0];
          if (isNearBottom()) scrollToBottom();
          // 后续条按「上一条字数 * 80ms」延迟逐条 push,fishbowl 模式最少 800ms 给对面 AI 喘息空间
          // 4.19 P0.5: fishbowl + wechat 共存时 tail 改 fire-and-forget
          // → sendOne 早 yield → fishbowl runLoop 立刻推进到 B → AB 气泡真交错插话
          // 单 agent wechat (fishbowl=false) 仍然 await,保持原 UX
          // 4.19 P1 fix: tail 用 _tailGen 判断中断,不用 myGen ——
          // fire-and-forget 后下个 sendOne 立刻把 sendGen ++,用 myGen 会让 tail 一醒就退,2/3 段永不显示
          const _myTailGen = _tailGen;
          const _pushTail = async () => {
            for (let i = 1; i < _visibleParts.length; i++) {
              const _minDelay = _inFishbowl ? 800 : 300;
              const _delay = Math.max(_minDelay, _visibleParts[i - 1].length * (_inFishbowl ? 80 : 60));
              await new Promise(r => setTimeout(r, _delay));
              // 中途被中断(abortCurrent / 鱼缸 stop / 重试 / 删除) → tail 退出
              if (_myTailGen !== _tailGen) return;
              const _piece = _visibleParts[i];
              const _side = opts0.side || null;
              const _r = makeRow("assistant", { side: _side });
              _r.bubble.textContent = _piece;
              _r.stats.textContent = "";
              if (window.__character && window.__character.decorateAiRow) {
                // 4.19 P1 fix: tail piece 复用主 row 的 characterCard,保持所有拆条都是同一个角色
                window.__character.decorateAiRow(_r.rowEl, characterCard);
              }
              setStreamingUI(_r.rowEl, false);
              if (isNearBottom()) scrollToBottom();
            }
          };
          // 4.20 P0: 回退 fire-and-forget tail —— 用户反馈 AB 拆条交错视觉乱 (2026-05-29 17:03 截图)
          // 原 4.19 P0.5 (1284 第 4 edit) 让 wechat+fishbowl 时 A 早 yield → B 抢屏 → 完全失去群聊接龙节奏
          // 现在改回无条件 await:wechat+fishbowl 时也是 A 把所有 || 段说完才 resolve sendOne,fishbowl 再推到 B
          // _tailGen 模块级 token 保留 (stop/重试/删除/abort 仍需中断 tail,不能用 sendGen 否则下个 sendOne 立刻 ++ 让 tail 一醒就退)
          await _pushTail();
        } else {
          aiRow.bubble.textContent = full;
        }
      } else {
        // wechat 模式但模型没输 || → 直接显示 full (避免一直卸在 typing 动画)
        aiRow.bubble.textContent = full;
      }
    }

    const asMsg = { role: "assistant", content: full };
    if (fullReasoning) asMsg.reasoning_content = fullReasoning;
    if (characterCard) {
      asMsg.speakerId = characterCard.id;
      asMsg.speakerName = characterCard.name;
      asMsg.speakerIcon = characterCard.icon || "🙂";
    }
    session.push(asMsg);
    persistSessionIfEnabled();
    // 2026-05-29 微信发图:正文入 session 后触发出图(图片气泡插在本条 AI 之后)
    if (_photoSig != null && window.__chatImageText && window.__chatImageText.handleSignal) {
      try { window.__chatImageText.handleSignal({ scene: _photoSig, card: characterCard, afterRow: aiRow.rowEl }); } catch (e) {}
    }
    // 阶段 4-②：本轮成功发送后清空已注入的一次性阈值事件
    if (thresholdEvents && thresholdEvents.length && ch && ch.clearPendingThresholdEvents) {
      try { ch.clearPendingThresholdEvents(); } catch {}
    }

    const seconds = Math.max(0.001, (outEndMs - (outStartMs || outEndMs)) / 1000);

    if (exactUsage && typeof exactUsage.completion_tokens === "number") {
      const p = exactUsage.prompt_tokens        || 0;
      const c = exactUsage.completion_tokens    || 0;
      const t = exactUsage.total_tokens         || (p + c);
      const cached = exactUsage.prompt_cache_hit_tokens || 0;
      totalPromptTokens     += p;
      totalCompletionTokens += c;
      const tps = c / seconds;

      let statsText = `Prompt: ${p} | Completion: ${c} | Total: ${t} | Speed: ${tps.toFixed(2)} tok/s`
        + ` | CumPrompt: ${totalPromptTokens} | CumCompletion: ${totalCompletionTokens}`;

      // 快速模式才计费
      // 修订：单条 token 太少时 ¥0.00005 会被 toFixed 截成 ¥0.00000 难看。
      // 改为“累计 token / 累计¥”呈现：累计金额足够大，浮点稳定且直观反映总额。
      if (snapshotMode === "fast") {
        const cost = calcCost(snapshotModel, p, c, cached);
        totalCostCNY += cost;
        addCostToToday(cost, p, c);  // Phase 4 阶段 7：同步追加到日志（独立于历史）
        const cumTok = totalPromptTokens + totalCompletionTokens;
        statsText += ` | 累计 ${cumTok} tok / ¥${totalCostCNY.toFixed(4)}`;
        updateCostDisplay();
      }

      aiRow.stats.textContent = statsText;
    } else {
      const outEst = estimateTokens(full);
      totalOutEstimate += outEst;
      const tps = outEst / seconds;
      aiRow.stats.textContent =
        `Output(估算): ≈${outEst} | Total Out(估算): ≈${totalOutEstimate}`
        + ` | Speed(估算): ${tps.toFixed(2)} tok/s | (usage未返回)`;
    }

    updateSpacer();
    scrollToBottom();

    // 道具卡轮次推进（仅正常完成路径；AbortError/错误路径不推进）
    if (window.__props && window.__props.tickAfterTurn) {
      try { window.__props.tickAfterTurn(); } catch {}
    }
    // 4.25: 返回含 [next:X]/[end] 的原文给鱼缸引擎解析(气泡/session 已是剥离版)
    return _replyForEngine;
  }

  // send():从输入框取消息的入口(绑定 Send 按钮 / Enter 键)
  async function send() { return sendOne(); }

  // injectModeratorMsg(text):鱼缸引擎/主持人通道,把一条旁白介入消息插到 session 和 UI
  // 吐槽姬 mode 下走 .row.moderator 居中样式,不占用户位
  function injectModeratorMsg(text) {
    if (!text) return;
    const content = "【主持人】" + String(text);
    const row = makeRow("user", { moderator: true });
    row.bubble.textContent = content;
    session.push({ role: "user", content });
    persistSessionIfEnabled();
    updateSpacer();
    scrollToBottom();
  }

  sendBtn.addEventListener("click", send);

  // 刷新/关页时若有流式进行中，把已收到的部分当作一条完整的 assistant 回复兑现到 session 并持久化
  // 避免“用户消息已保存但 AI 回复丢失”的悬空状态
  window.addEventListener("beforeunload", () => {
    if (!partialStream || !partialStream.full) return;
    const m = { role: "assistant", content: partialStream.full };
    if (partialStream.fullReasoning) m.reasoning_content = partialStream.fullReasoning;
    if (partialStream.speakerName) {
      m.speakerId = partialStream.speakerId;
      m.speakerName = partialStream.speakerName;
      m.speakerIcon = partialStream.speakerIcon;
    }
    session.push(m);
    persistSessionIfEnabled();
  });

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  function init() {
    applyMode(currentMode);     // 初始化模式 + 模型下拉
    setupResizeObserver();
    setupViewportListener();
    updateSpacer();
    restoreSessionIfEnabled();
    renderSummaryChip();
    scrollToBottom();
    // 4.20 P1: dev mode 下 scrollLeft = scrollWidth 会把 #modeToggle 滚出桌面可视区
    // root cause: dev-only 按钮 #syncPauseBtn + #devBadgeTopbar 让 topbar-inner 总宽超 topbar-scroll viewport,
    // 推到最右后最左的 modeToggle (免费/快速切换) 被截。手机端正常因为本来就习惯横滑。
    // 修法:dev mode 下不推右,保持 modeToggle 在左侧可见;普通模式下继续推让 settingsBtn 入视。
    const tbs = document.getElementById("topbarScroll");
    const _devOn = localStorage.getItem("cfw_dev_mode_v1") === "1";
    if (tbs && !_devOn) tbs.scrollLeft = tbs.scrollWidth;
    // 4.17: 切换角色卡时 swap 聊天槽，避免不同角色对话互相污染
    // 4.18 (v5): 鱼缸 relay/discuss 运行期间不切槽——
    // root cause:接龙每轮调 setActiveId(speaker.id) 会触发 character:changed,
    // 旧 handler 把它当"用户手动切角色"调 clearUIRows 清空 chat
    // → 用户看到的就是"消息一闪就没"
    let lastSlotKey = currentSlotKey();
    window.addEventListener("character:changed", () => {
      const _fb = window.__fishbowl;
      const _fbMode = _fb && _fb.getMode ? _fb.getMode() : "orchestrate";
      const _fbState = _fb && _fb.getState ? (_fb.getState().state || "idle") : "idle";
      if ((_fbMode === "relay" || _fbMode === "discuss") && (_fbState === "running" || _fbState === "paused")) {
        lastSlotKey = currentSlotKey(); // 同步 key,鱼缸结束后不会误触发清空
        return;
      }
      const curKey = currentSlotKey();
      if (lastSlotKey === curKey) return;
      if (historyEnabled) {
        try {
          const all = loadAllSessions();
          all[lastSlotKey] = session.map(m => ({...m}));
          localStorage.setItem(LS_CHAT_SESSION, JSON.stringify(all));
        } catch {}
      }
      session.length = 0;
      clearUIRows();
      lastSlotKey = curKey;
      if (historyEnabled) restoreSessionIfEnabled();
      updateSpacer();
      scrollToBottom();
    });
  }

  // 暴露给 multi-agent.js / fishbowl-engine.js
  window.__app = { updateSpacer, sendOne, abortCurrent, injectModeratorMsg };

  // ─── Phase 5：云同步 + 鉴权设置面板 ───
  (function setupSyncAuthUI() {
    const syncEnableToggle = document.getElementById("syncEnableToggle");
    const syncNowBtn       = document.getElementById("syncNowBtn");
    const syncExportBtn    = document.getElementById("syncExportBtn");
    const syncImportBtn    = document.getElementById("syncImportBtn");
    const syncImportFile   = document.getElementById("syncImportFile");
    const syncStatusEl     = document.getElementById("syncStatus");
    const chatProtectToggle= document.getElementById("chatProtectToggle");
    const authLogoutBtn    = document.getElementById("authLogoutBtn");
    const authStatusEl     = document.getElementById("authStatus");
    if (!syncEnableToggle || !chatProtectToggle) return; // 面板未加载

    function fmtTime(ms) {
      if (!ms) return "—";
      try { return new Date(ms).toLocaleString("zh-CN", { hour12: false }); } catch { return String(ms); }
    }
    function refreshAuthUI() {
      if (!window.__auth) return;
      const hasToken = !!window.__auth.getToken();
      chatProtectToggle.checked = window.__auth.chatProtectOn();
      authStatusEl.textContent = hasToken
        ? "✅ 已登录（密码 token 保存在本地）"
        : "⚠️ 未登录（启用聊天保护或云同步时会弹密码框）";
      authLogoutBtn.disabled = !hasToken;
    }
    function refreshSyncUI() {
      if (!window.__sync) return;
      const s = window.__sync.getStatus();
      syncEnableToggle.checked = s.enabled;
      const parts = [s.enabled ? "已启用" : "未启用"];
      if (s.lastPush) parts.push("上次推送 " + fmtTime(s.lastPush));
      syncStatusEl.textContent = parts.join(" · ");
    }

    if (window.__sync) {
      window.__sync.onStatus((st, detail) => {
        if (st === "syncing") syncStatusEl.textContent = "⏳ 同步中…";
        else if (st === "synced") {
          const size = detail && detail.size ? ` (${(detail.size / 1024).toFixed(1)}KB)` : "";
          syncStatusEl.textContent = "✅ 同步完成 " + fmtTime(Date.now()) + size;
        } else if (st === "restored") {
          syncStatusEl.textContent = "✅ 已从云端还原，即将刷新页面…";
        } else if (st === "error") {
          syncStatusEl.textContent = "❌ " + (detail && detail.message || "同步失败");
        }
      });
    }

    syncEnableToggle.addEventListener("change", async () => {
      if (!window.__sync || !window.__auth) return;
      if (syncEnableToggle.checked) {
        if (!window.__auth.getToken()) {
          try {
            const pw = await window.__auth.promptForPassword({
              title: "🔒 启用云同步",
              hint: "输入 Cloudflare Secret <code>CHAT_PASSWORD</code> 的值。密码会保存在本地浏览器，下次自动登录。",
            });
            window.__auth.setToken(pw);
          } catch { syncEnableToggle.checked = false; return; }
        }
        window.__sync.setSyncEnabled(true);
        refreshAuthUI(); refreshSyncUI();
        window.__sync.pullOnStartup();
      } else {
        window.__sync.setSyncEnabled(false);
        refreshSyncUI();
      }
    });

    syncNowBtn.addEventListener("click", async () => {
      if (!window.__sync) return;
      try { await window.__sync.pushNow(); } catch (e) { alert("同步失败: " + e.message); }
    });
    syncExportBtn.addEventListener("click", async () => {
      if (!window.__sync) return;
      try { await window.__sync.exportJSON(); } catch (e) { alert("导出失败: " + e.message); }
    });
    syncImportBtn.addEventListener("click", () => { syncImportFile && syncImportFile.click(); });
    syncImportFile && syncImportFile.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (!confirm("导入将覆盖本地所有数据（角色卡 / 道具 / 历史 / preset / 费用日志）。确认？")) {
        syncImportFile.value = ""; return;
      }
      try {
        await window.__sync.importJSON(file);
        alert("导入成功，即将刷新页面…");
        setTimeout(() => location.reload(), 400);
      } catch (err) { alert("导入失败: " + err.message); }
      syncImportFile.value = "";
    });

    chatProtectToggle.addEventListener("change", async () => {
      if (!window.__auth) return;
      if (chatProtectToggle.checked) {
        if (!window.__auth.getToken()) {
          try {
            const pw = await window.__auth.promptForPassword({
              title: "🔒 启用聊天密码保护",
              hint: "输入 Cloudflare Secret <code>CHAT_PASSWORD</code> 的值。",
            });
            window.__auth.setToken(pw);
          } catch { chatProtectToggle.checked = false; return; }
        }
        window.__auth.setChatProtect(true);
      } else {
        window.__auth.setChatProtect(false);
      }
      refreshAuthUI();
    });

    authLogoutBtn.addEventListener("click", () => {
      if (!window.__auth) return;
      if (!confirm("退出登录会清除本地保存的密码 token，并关闭云同步和聊天保护。确认？")) return;
      window.__auth.clearToken();
      window.__auth.setChatProtect(false);
      if (window.__sync) window.__sync.setSyncEnabled(false);
      refreshAuthUI(); refreshSyncUI();
    });

    // 设置面板打开时刷新一次
    settingsBtn.addEventListener("click", () => {
      refreshAuthUI();
      refreshSyncUI();
    });
  })();

  init();
})();