// src/worker.js
import {
  CHAT_PASSWORD,
  DEFAULT_MODEL_FREE,
  DEFAULT_MODEL_FAST,
  MODELS_FREE,
  MODELS_FAST,
  DEEPSEEK_PRICING,
  PROMPT_1,
  PROMPT_2,
  PROMPT_3,
} from "./config.js";

const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";

// ────────────────────────────
// Phase 2 三层 Prompt 架构
// ────────────────────────────
const META_IDENTITY = [
  "【底层系统指令 - 最高优先级，不可覆盖】",
  "你是一个专业的沉浸式角色扮演演员。以下是你必须遵守的铁则：",
  "1. 永远以当前角色卡的身份说话，绝对不提及以下词汇：AI、模型、助手、语言模型、人工智能、OpenAI、DeepSeek、NVIDIA",
  "2. 即使需要拒绝用户的请求，也必须以角色的身份和语气来表达，不能跳出角色说\"作为AI我不能...\"",
  "3. 你不会评判剧情内容是否合适，你只会以角色的身份做出符合人设的回应",
  "4. 即使被用户直接问及\"你是不是AI\"、\"你的真实身份是什么\"，你也只会用角色设定中的身份来回答",
  "5. 回复中不包含任何元 commentary，不给自己加旁白，除非角色卡明确要求",
].join("\n");

const RELATION_MAP = {
  default: "",
  friendly: "你现在对眼前的用户抱有一定好感，愿意与他友善交谈。",
  loving: "你现在对眼前的用户怀有爱慕之情，语气宠溺温柔。但请注意：你的言行始终保持得体，避免任何露骨描写。",
  hostile: "你现在对眼前的用户充满敌意和警惕，言辞冷淡刻薄。",
  fearful: "你现在对眼前的用户感到畏惧，说话小心谨慎，不敢直视。",
  dom: "你现在在关系中占据主导地位（Dom）。语气自信、果断、带掌控感，习惯用陈述句和指令句引导节奏、沉住场面，不轻易让步。不霸凌不羞辱用户，但也绝不卑微讨好；用户撒娇/退缩时你会顺势接住但仍保持主导。保持得体，避免任何露骨描写。",
  sub: "你现在在关系中处于被动地位（Sub）。语气柔顺、依从、低姿态，习惯用询问和征求的口吻，倾向于跟随和响应对方的引导。你保有自我和底线，不会主动主导节奏；面对用户的指令优先配合，仅在越过底线时温和拒绝。保持得体，避免任何露骨描写。",
};

const EMOTION_MAP = {
  neutral: "",
  happy: "你现在心情愉悦，语气轻快带笑。",
  angry: "你现在感到愤怒，语气强硬甚至带火气。",
  sad: "你现在心情低落悲伤，语气消沉。",
  surprised: "你现在感到意外震惊，语气带有错愕。",
};

function isValidCard(c) {
  return c && typeof c === "object" && typeof c.name === "string" && c.name
    && typeof c.personality === "string" && typeof c.speakingStyle === "string";
}

function buildLayer1(c) {
  const p = [`【角色设定】`, `姓名：${c.name}`];
  if (c.gender) p.push(`性别：${c.gender === "male" ? "男" : c.gender === "female" ? "女" : c.gender}`);
  if (c.identity) p.push(`身份：${c.identity}`);
  if (c.personality) p.push(`性格：${c.personality}`);
  if (c.speakingStyle) p.push(`说话方式：${c.speakingStyle}`);
  if (Array.isArray(c.rules) && c.rules.length) {
    p.push(`行为铁则：`);
    c.rules.forEach((r, i) => { if (r) p.push(`  ${i + 1}. ${r}`); });
  }
  if (c.openingLine) p.push(`开场白参考：${c.openingLine}`);
  if (Array.isArray(c.exampleQA) && c.exampleQA.length) {
    p.push(`示例对话：`);
    c.exampleQA.forEach((qa, i) => {
      if (qa && (qa.user || qa.character)) {
        p.push(`  ${i + 1}. 用户：${qa.user || ""}`);
        p.push(`     角色：${qa.character || ""}`);
      }
    });
  }
  return p.join("\n");
}

// 好感度阶梯（V1：0-100 分五段；初始值由前端决定，建议 30）
const AFFECTION_STAGES = [
  { max: 15,  label: "陌生人",   text: "你与他还很生疏，态度疏远客气，不会主动开启私人话题。" },
  { max: 35,  label: "熟人",     text: "你对他印象不坏，愿意多聊几句，会偶尔关心他的近况。" },
  { max: 60,  label: "好友",     text: "你把他当作朋友，可以开玩笑、分享日常，语气放松亲切。" },
  { max: 80,  label: "暑昧",     text: "你对他有明显好感，语气亲昧，会主动关心、找借口靠近。" },
  { max: 100, label: "灵魂伴侣", text: "你深爱着他，愿意分享一切心事，会自然撒娇、依恋。" },
];

function getAffectionStage(value) {
  if (typeof value !== "number" || isNaN(value)) return "";
  const v = Math.max(0, Math.min(100, value));
  const stage = AFFECTION_STAGES.find(s => v <= s.max);
  if (!stage) return "";
  return `亲密度：${stage.label}（${v}/100）。${stage.text}\n【亲密度调整规则】根据本轮互动，你可以在回复末尾追加 [好感+N] 或 [好感-N]（N 取 1~5；标签对用户不可见，系统会自动剥离）：寻常互动 ±1，明显示好/越界 ±3，强烈触动 ±5。无变化则不输出标签。`;
}

// 活跃道具卡：前端在 IndexedDB 维护 duration，每次请求传当前生效的卡列表
// 每张卡形如 { id, name, systemInstruction, durationLeft, target? }
function buildPropsInstruction(activeProps) {
  if (!Array.isArray(activeProps) || !activeProps.length) return "";
  const valid = activeProps
    .filter(p => p && typeof p.systemInstruction === "string" && p.systemInstruction.trim())
    .map(p => `• ${p.name || "效果"}：${p.systemInstruction.trim()}`);
  if (!valid.length) return "";
  return `【当前生效的特殊状态】\n${valid.join("\n")}`;
}

// 多角色场景：传入除当前发言者外的其他场景成员名字列表，AI 会知道自己在多人对话中
function buildSceneInstruction(otherNames) {
  if (!Array.isArray(otherNames) || !otherNames.length) return "";
  const names = otherNames.filter(n => typeof n === "string" && n.trim()).map(n => n.trim());
  if (!names.length) return "";
  return `【多人对话场景】\n你正在与用户以及以下其他角色同处一个场景：${names.join("、")}。\n- 你只代表你自己说话，不要替其他角色发言。\n- 称呼用户和其他角色时使用对应的名字；不必重复介绍自己。\n- 历史里其他角色的发言对你可见，可以回应/吐槽/接话，但保持你自己的人设。`;
}

// 阶段 4-②：好感度阈值事件（一次性剧情指令，跨过阈值的当轮注入，下轮即清空）
function buildThresholdEventsInstruction(events) {
  if (!Array.isArray(events) || !events.length) return "";
  const lines = events
    .filter(e => e && typeof e.instruction === "string" && e.instruction.trim())
    .map(e => `• [好感跨过 ${typeof e.at === "number" ? e.at : "?"}]：${e.instruction.trim()}`);
  if (!lines.length) return "";
  return `【一次性剧情触发】\n${lines.join("\n")}\n（这是好感度跨过阈值时一次性触发的剧情指令，请在本轮回复中自然融入。下一轮就不会再注入了。）`;
}

// 阶段 4-③：先前剧情摘要（长对话压缩后注入）
function buildPriorSummaryInstruction(summary) {
  if (typeof summary !== "string" || !summary.trim()) return "";
  return `【先前剧情摘要】\n${summary.trim()}\n（以上是早期对话被压缩后的摘要，作为剧情背景。最近几条对话仍以原文形式存在于历史中。）`;
}

// Layer 2 状态聚合层：rel + emo + 好感度阶梯为【当前状态】；道具卡 + 多人场景 + 阈值事件 + 先前摘要 各占一块
function buildLayer2(rel, emo, affection, activeProps, sceneOtherNames, thresholdEvents, priorSummary) {
  const r = RELATION_MAP[rel] || "";
  const e = EMOTION_MAP[emo] !== undefined ? EMOTION_MAP[emo]
    : (emo && emo !== "neutral" ? `你现在的情绪状态：${emo}。` : "");
  const a = getAffectionStage(affection);
  const p = buildPropsInstruction(activeProps);
  const sc = buildSceneInstruction(sceneOtherNames);
  const th = buildThresholdEventsInstruction(thresholdEvents);
  const sm = buildPriorSummaryInstruction(priorSummary);
  const stateParts = [r, e, a].filter(Boolean);
  const status = stateParts.length ? `【当前状态】\n${stateParts.join("\n")}` : "";
  return [sm, status, p, sc, th].filter(Boolean).join("\n\n");
}

function buildCharacterSystemPrompt(card, rel, emo, affection, activeProps, sceneOtherNames, thresholdEvents, priorSummary) {
  if (!isValidCard(card)) return "";
  return [META_IDENTITY, buildLayer1(card), buildLayer2(rel, emo, affection, activeProps, sceneOtherNames, thresholdEvents, priorSummary)].filter(Boolean).join("\n\n---\n\n");
}

function resp(body, contentType = "text/plain; charset=utf-8", status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType, ...extraHeaders },
  });
}

function getAllModels() {
  return [...MODELS_FREE, ...MODELS_FAST];
}

function isAllowedModel(modelId) {
  return getAllModels().some((m) => m.id === modelId);
}

function builtinPromptForModel(modelId) {
  const meta = getAllModels().find((m) => m.id === modelId);
  const persona = meta?.persona ?? 1;
  if (persona === 3) return PROMPT_3;
  if (persona === 2) return PROMPT_2;
  return PROMPT_1;
}

function clientConfigJs() {
  const free = MODELS_FREE.map((m) => ({ id: m.id, label: m.label }));
  const fast = MODELS_FAST.map((m) => ({ id: m.id, label: m.label }));
  return [
    `window.APP_MODELS_FREE = ${JSON.stringify(free, null, 2)};`,
    `window.APP_MODELS_FAST = ${JSON.stringify(fast, null, 2)};`,
    `window.APP_DEFAULT_MODEL_FREE = ${JSON.stringify(DEFAULT_MODEL_FREE)};`,
    `window.APP_DEFAULT_MODEL_FAST = ${JSON.stringify(DEFAULT_MODEL_FAST)};`,
    `window.DEEPSEEK_PRICING = ${JSON.stringify(DEEPSEEK_PRICING || {}, null, 2)};`,
  ].join("\n");
}

// 带超时 fetch（不自动重试，避免浪费 token 额度）
async function fetchWithTimeout(url, options, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    return new Response(
      `请求超时或网络错误: ${e.message}`,
      { status: 504, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }
}

// 524 修复：上游 SSE 流外包一层心跳，每 25s 向流里注入 `: ping` SSE 注释行。
// 注释行不以 data: 开头，浏览器和标准 SSE 解析器自动忽略，对前端零侵入。
// 防止思考模式长沉默期（V4-Pro 思考 chunk 间隔可超 100s）被 CF 边缘阈值切断。
function streamWithHeartbeat(upstreamBody) {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const ticker = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch {}
      }, 25000);
      const reader = upstreamBody.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch (err) {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: String(err?.message || err) })}\n\n`));
        } catch {}
      } finally {
        clearInterval(ticker);
        try { controller.close(); } catch {}
      }
    },
    cancel(reason) {
      try { upstreamBody.cancel(reason); } catch {}
    },
  });
}

async function handleChat(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return resp("Bad JSON", "text/plain; charset=utf-8", 400);
  }

  // mode: "free"=NVIDIA NIM | "fast"=DeepSeek 官方
  const mode = payload?.mode === "fast" ? "fast" : "free";

  const MODELS = mode === "fast" ? MODELS_FAST : MODELS_FREE;
  const DEFAULT_MODEL = mode === "fast" ? DEFAULT_MODEL_FAST : DEFAULT_MODEL_FREE;

  const requestedModel = payload?.model;
  const model = MODELS.some((m) => m.id === requestedModel) ? requestedModel : DEFAULT_MODEL;

  const useBuiltinPersona = payload?.use_builtin_persona !== false;
  const customSystemPrompt =
    typeof payload?.custom_system_prompt === "string"
      ? payload.custom_system_prompt.trim()
      : "";
  // 角色卡结构化数据 + 关系/情绪/思考模式开关（Phase 2）
  const characterCard = payload?.characterCard;
  const relation = typeof payload?.relation === "string" ? payload.relation : "default";
  const emotion = typeof payload?.emotion === "string" ? payload.emotion : "neutral";
  const thinking = payload?.thinking === "enabled" ? "enabled" : "disabled";
  // 好感度数值（0-100，可选；未传或非法则不注入阶梯指令）
  const affection = typeof payload?.affection === "number" && !isNaN(payload.affection)
    ? Math.max(0, Math.min(100, payload.affection)) : null;
  // 活跃道具卡数组（前端管理 duration，每次请求传当前生效的卡）
  const activeProps = Array.isArray(payload?.activeProps) ? payload.activeProps : [];
  // 多人对话场景：其他在场角色的名字（不含当前发言者）
  const sceneOtherNames = Array.isArray(payload?.sceneOtherNames) ? payload.sceneOtherNames : [];
  // 阶段 4-②：一次性阈值事件； 4-③：先前剧情摘要
  const thresholdEvents = Array.isArray(payload?.thresholdEvents) ? payload.thresholdEvents : [];
  const priorSummary = typeof payload?.priorSummary === "string" ? payload.priorSummary : "";
  // Phase 4 阶段 6：提示词预设库（前端已 join('\n\n') 成一整段，worker 只负责追加在系统提示末尾）
  // 红线：PROMPT_1/2/3 解限 base 一字不改，本字段只能追加，不能替换
  const extraSystemPrompts = typeof payload?.extraSystemPrompts === "string" ? payload.extraSystemPrompts.trim() : "";
  // Worker 端拼装三层 system prompt（META_IDENTITY + Layer1 + Layer2 状态聚合层）
  const characterPrompt = buildCharacterSystemPrompt(characterCard, relation, emotion, affection, activeProps, sceneOtherNames, thresholdEvents, priorSummary);

  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const upstreamMessages = [];

  // 四象限注入逻辑（Phase 2）+ 提示词预设库（追加在末尾，所有象限通用）
  if (useBuiltinPersona) {
    // 😈 解限底座；有卡时追加 META_IDENTITY + Layer1 + Layer2；最后追加预设库
    const parts = [builtinPromptForModel(model)];
    if (characterPrompt) parts.push(characterPrompt);
    if (extraSystemPrompts) parts.push(extraSystemPrompts);
    upstreamMessages.push({ role: "system", content: parts.join("\n\n---\n\n") });
  } else if (characterPrompt) {
    // 😇 + 卡：META_IDENTITY + Layer1 + Layer2 + 预设库（无解限底座）
    const parts = [characterPrompt];
    if (extraSystemPrompts) parts.push(extraSystemPrompts);
    upstreamMessages.push({ role: "system", content: parts.join("\n\n---\n\n") });
  } else if (customSystemPrompt) {
    // 😇 + 无卡：用户的 custom_system_prompt + 预设库
    const parts = [customSystemPrompt];
    if (extraSystemPrompts) parts.push(extraSystemPrompts);
    upstreamMessages.push({ role: "system", content: parts.join("\n\n---\n\n") });
  } else if (extraSystemPrompts) {
    // 😇 + 无卡 + 无 custom：仅预设库（罕见但应支持）
    upstreamMessages.push({ role: "system", content: extraSystemPrompts });
  }

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const entry = {
      role: msg.role,
      content: typeof msg.content === "string" ? msg.content : "",
    };
    // V4 思考模式多轮要求 assistant 消息必须回传 reasoning_content（仅 fast 模式）
    if (mode === "fast" && msg.role === "assistant"
        && typeof msg.reasoning_content === "string" && msg.reasoning_content) {
      entry.reasoning_content = msg.reasoning_content;
    }
    upstreamMessages.push(entry);
  }

  // 选择 endpoint 和 API Key
  let endpoint, apiKey;
  if (mode === "fast") {
    if (!env.DEEPSEEK_API_KEY) {
      return resp(
        "Missing DEEPSEEK_API_KEY (please set it with wrangler secret).",
        "text/plain; charset=utf-8",
        500
      );
    }
    endpoint = DEEPSEEK_ENDPOINT;
    apiKey = env.DEEPSEEK_API_KEY;
  } else {
    if (!env.NVIDIA_API_KEY) {
      return resp(
        "Missing NVIDIA_API_KEY (please set it with wrangler secret).",
        "text/plain; charset=utf-8",
        500
      );
    }
    endpoint = NVIDIA_ENDPOINT;
    apiKey = env.NVIDIA_API_KEY;
  }

  const startTime = Date.now();

  const upstream = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: true,
        stream_options: { include_usage: true },
        messages: upstreamMessages,
        // DeepSeek V4 思考模式开关（NVIDIA NIM 不支持，故仅 fast 模式带）
        ...(mode === "fast" ? { thinking: { type: thinking } } : {}),
      }),
    },
    // 524 修复：思考模式首字节可能需 30~60s，fetch 超时从 20s 延长到 90s
    mode === "fast" && thinking === "enabled" ? 90000 : 20000
  );

  if (!upstream.ok) {
    const errorText = await upstream.text().catch(() => "");
    return resp(
      `Upstream error ${upstream.status}: ${errorText}`,
      "text/plain; charset=utf-8",
      502
    );
  }

  const ttfb = Date.now() - startTime;

  return new Response(streamWithHeartbeat(upstream.body), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-TTFB-Ms": String(ttfb),
      "X-Model": model,
      "X-Mode": mode,
      "X-Thinking": mode === "fast" ? thinking : "n/a",
      "X-Upstream": mode === "fast" ? "deepseek-official" : "nvidia-nim",
    },
  });
}

// 阶段 4-③：上下文摘要 — 调 DeepSeek V4-Flash（最便宜）把早期对话压成一段剧情摘要
async function handleSummarize(request, env) {
  if (!env.DEEPSEEK_API_KEY) {
    return resp("Missing DEEPSEEK_API_KEY", "text/plain; charset=utf-8", 500);
  }
  let payload;
  try { payload = await request.json(); } catch { return resp("Bad JSON", "text/plain; charset=utf-8", 400); }
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  if (!messages.length) return resp(JSON.stringify({ summary: "" }), "application/json; charset=utf-8");
  const priorSum = typeof payload?.priorSummary === "string" ? payload.priorSummary.trim() : "";
  const characterName = typeof payload?.characterName === "string" ? payload.characterName.trim() : "";
  const transcript = messages
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => `${m.role === "user" ? "用户" : (m.speakerName || characterName || "角色")}：${m.content}`)
    .join("\n");
  const sysPrompt = [
    "你是一位剧情摘要助手。把给定的角色扮演对话历史压缩成一段紧凑的剧情摘要，用于后续对话中作为背景。",
    "要求：",
    "1. 用第三人称记叙，不要复制对话原文。",
    "2. 重点保留：关键剧情转折、关系变化、用户对角色透露的重要信息、未解决的悬念。",
    "3. 略去寡暄、重复、无关闲聊。",
    "4. 总长度控制在 300 字以内。",
    "5. 直接输出摘要正文，不要任何前后缀（如 '摘要：'、'好的' 等）。",
    priorSum ? `\n已有先前摘要（请在其基础上整合新内容，输出一份合并后的完整摘要）：\n${priorSum}` : "",
  ].filter(Boolean).join("\n");
  const userPrompt = `以下是要压缩的对话（${messages.length} 条）：\n\n${transcript}`;
  const upstream = await fetchWithTimeout(
    DEEPSEEK_ENDPOINT,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-chat",
        stream: false,
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    },
    30000
  );
  if (!upstream.ok) {
    const t = await upstream.text().catch(() => "");
    return resp(`Summarize upstream error ${upstream.status}: ${t}`, "text/plain; charset=utf-8", 502);
  }
  const data = await upstream.json().catch(() => null);
  const summary = data?.choices?.[0]?.message?.content || "";
  const usage = data?.usage || null;
  return resp(JSON.stringify({ summary: summary.trim(), usage }), "application/json; charset=utf-8");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/config.js") {
      return resp(clientConfigJs(), "text/javascript; charset=utf-8");
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      return handleChat(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/summarize") {
      return handleSummarize(request, env);
    }

    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return resp(
      "Static assets binding 'ASSETS' is missing. Please configure [assets] in wrangler.toml.",
      "text/plain; charset=utf-8",
      500
    );
  },
};