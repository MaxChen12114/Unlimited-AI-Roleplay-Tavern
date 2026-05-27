// public/config.js
// Worker 会动态下发 /config.js，此文件作为本地备用 fallback
// 正常部署后以 Worker 下发为准，不需要手动改这里

// 免费模式（NVIDIA NIM）——与原 text 项目一致
window.APP_MODELS_FREE = [
  { id: "deepseek-ai/deepseek-v4-pro", label: "deepseek-v4-pro" },
  { id: "z-ai/glm-5.1",                label: "glm-5.1" },
  { id: "openai/gpt-oss-120b",         label: "gpt-oss-120b" },
];

// 快速模式（DeepSeek 官方）—— V4 双档
window.APP_MODELS_FAST = [
  { id: "deepseek-v4-flash", label: "DeepSeek V4-Flash" },
  { id: "deepseek-v4-pro",   label: "DeepSeek V4-Pro" },
];

window.APP_DEFAULT_MODEL_FREE = "deepseek-ai/deepseek-v4-pro";
window.APP_DEFAULT_MODEL_FAST = "deepseek-v4-flash";

// DeepSeek 官方定价（元/百万 token，2026/05 起的 V4 系列）供前端费用计算使用
window.DEEPSEEK_PRICING = {
  "deepseek-v4-flash": {
    cache_hit: 0.02,
    input:     1.00,
    output:    2.00,
  },
  "deepseek-v4-pro": {
    // 2.5 折活动至 2026/05/31 23:59；活动结束后正式价 = 原定价 1/4，数值相同
    cache_hit: 0.025,
    input:     3.00,
    output:    6.00,
  },
  // 兼容：旧模型名映射到 V4-Flash 价格
  "deepseek-chat":     { cache_hit: 0.02, input: 1.00, output: 2.00 },
  "deepseek-reasoner": { cache_hit: 0.02, input: 1.00, output: 2.00 },
};