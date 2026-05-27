# DeepSeek Worker UI (Password Gate + Donate)

## Where to modify
- `src/config.js`：
  - `CHAT_PASSWORD`：进页面输入的密码
  - `MODELS` / `DEFAULT_MODEL`：模型列表与默认值
  - `PROMPT_1` / `PROMPT_2`：内置人物模板（网页看不到）

## Deploy (Cloudflare Workers)
1) Install & login
```bash
npm i -g wrangler
wrangler login
```

2) Set NVIDIA key (secret)
```bash
wrangler secret put NVIDIA_API_KEY
```

3) Deploy
```bash
wrangler deploy
```

Open the Worker URL, it will prompt for password.

## Notes
- History & custom prompt are stored in browser localStorage only (optional).
- 😈 uses Worker built-in prompts; 😇 allows web custom prompt.
- Donate button 💚 opens QR modal.
