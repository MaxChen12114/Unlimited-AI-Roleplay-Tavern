// public/chat-ux.js — 对话区交互细节
//   ① 用户/AI 行操作按钮（复制 / ⇺ 重试 / 删除 / ■ 停止）+ 流式状态守护
//   ② 智能自动滚动（用户在底部时跟随新消息；上拉阅读时不打扰；点发送回底）
//
// 与 app.js 的接口：
//   window.__abortCurrent(discardPartial?)   重试/删除 传 true 丢弃 partialStream
//   window.__sessionTruncateTo(n)            截断 session 到第 n 条
//   window.__sessionDeleteAt(start, count)   删除 session 指定位置的消息
//   window.__resetSending()                  强制解锁 isSending 与 Send 按钮
//   AI 行 .row.ai 有 dataset.streaming === "1" 时 ■ 停止按钮可见

(function () {
  // ────────────────────────────────────────────────────────────
  // ① 行按钮
  // ────────────────────────────────────────────────────────────
  window.addEventListener("load", function () {
    const chat = document.getElementById("chat");
    const sendBtn = document.getElementById("sendBtn");
    const msgInput = document.getElementById("msg");
    if (!chat || !sendBtn || !msgInput) return;

    // 样式交由 styles.css .msg-action-btn 管，与 Phase 4 主题系统（minimal / glass）统一
    function makeBtn(label) {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.className = "msg-action-btn";
      return btn;
    }

    // 通用：复制 bubble 文本（带 navigator.clipboard + execCommand fallback，手机兼容）
    function bindCopy(btn, bubbleSelector, row) {
      btn.addEventListener("click", () => {
        const bubble = row.querySelector(bubbleSelector);
        const text = bubble ? bubble.textContent.trim() : "";
        const doFallback = () => {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px;";
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          try {
            document.execCommand("copy");
            btn.textContent = "已复制";
          } catch {
            btn.textContent = "失败";
          }
          document.body.removeChild(ta);
          setTimeout(() => (btn.textContent = "复制"), 1500);
        };
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard
            .writeText(text)
            .then(() => {
              btn.textContent = "已复制";
              setTimeout(() => (btn.textContent = "复制"), 1500);
            })
            .catch(doFallback);
        } else {
          doFallback();
        }
      });
    }

    // 通用：从指定起始 row（含）开始全部移除 DOM + 截断 session + 回填输入框 + 触发发送
    function resendFromUserRow(userRow) {
      if (typeof window.__abortCurrent === "function") window.__abortCurrent(true);
      const allRows = Array.from(chat.querySelectorAll(".row"));
      const userIdx = allRows.indexOf(userRow);
      if (userIdx < 0) return;
      const bubble = userRow.querySelector(".bubble.user");
      if (!bubble) return;
      const userText = bubble.textContent.trim();
      if (!userText) return;
      for (let i = allRows.length - 1; i >= userIdx; i--) allRows[i].remove();
      if (typeof window.__sessionTruncateTo === "function") {
        window.__sessionTruncateTo(userIdx);
      }
      if (typeof window.__resetSending === "function") window.__resetSending();
      else {
        sendBtn.disabled = false;
        sendBtn.textContent = "Send";
      }
      msgInput.value = userText;
      msgInput.dispatchEvent(new Event("input"));
      setTimeout(() => {
        msgInput.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
        );
      }, 30);
    }

    // 通用：删 user + 紧随的 AI / 删 AI + 前面的 user；同时清理任何残留流式行
    function deleteRowPair(anchorRow, mode) {
      // mode = "fromUser" | "fromAi"
      if (typeof window.__abortCurrent === "function") window.__abortCurrent(true);
      const allRows = Array.from(chat.querySelectorAll(".row"));
      const idx = allRows.indexOf(anchorRow);
      if (idx < 0) return;
      let start, count;
      if (mode === "fromUser") {
        const next = allRows[idx + 1];
        const hasAi = !!(next && next.classList.contains("ai"));
        anchorRow.remove();
        if (hasAi) next.remove();
        start = idx;
        count = hasAi ? 2 : 1;
      } else {
        const prev = allRows[idx - 1];
        const hasUser = !!(prev && prev.classList.contains("user"));
        anchorRow.remove();
        if (hasUser) prev.remove();
        start = hasUser ? idx - 1 : idx;
        count = hasUser ? 2 : 1;
      }
      if (typeof window.__sessionDeleteAt === "function") {
        window.__sessionDeleteAt(start, count);
      }
      // partialStream 已被 __abortCurrent(true) 丢弃，必须连带从 DOM 移除残留流式行
      // 否则会出现 DOM 多一条悬空 AI 行 / session 少一条 a_n 的错位
      chat.querySelectorAll('.row.ai[data-streaming="1"]').forEach((r) => r.remove());
    }

    function addAiButtons(aiRow) {
      if (aiRow.dataset.btnsAttached) return;
      aiRow.dataset.btnsAttached = "1";
      const content = aiRow.querySelector(".content");
      if (!content) return;

      const wrap = document.createElement("div");
      wrap.className = "my-action-btns";
      wrap.style.cssText =
        "display:flex;justify-content:flex-start;gap:8px;padding:4px 4px 2px;flex-wrap:wrap;";

      // ■ 停止（仅流式中可见；点击中断当前请求，已收到部分作为完整 AI 回复保留入 session）
      const stopBtn = makeBtn("■ 停止");
      stopBtn.classList.add("my-stop-btn");
      stopBtn.style.display = aiRow.dataset.streaming === "1" ? "" : "none";
      stopBtn.addEventListener("click", () => {
        if (typeof window.__abortCurrent === "function") window.__abortCurrent();
        stopBtn.style.display = "none";
        try {
          delete aiRow.dataset.streaming;
        } catch {
          aiRow.removeAttribute("data-streaming");
        }
      });

      const copyBtn = makeBtn("复制");
      bindCopy(copyBtn, ".bubble.ai", aiRow);

      // ⇺ 重试（从对应的上一条用户消息重新发送）
      const retryBtn = makeBtn("↺ 重试");
      retryBtn.addEventListener("click", () => {
        const allRows = Array.from(chat.querySelectorAll(".row"));
        const aiIdx = allRows.indexOf(aiRow);
        if (aiIdx < 0) return;
        const prev = allRows[aiIdx - 1];
        if (!prev || !prev.classList.contains("user")) return;
        resendFromUserRow(prev);
      });

      // 删除（本条 AI + 前面的用户消息一并删，清理残留流式行）
      const delBtn = makeBtn("删除");
      delBtn.addEventListener("click", () => deleteRowPair(aiRow, "fromAi"));

      wrap.appendChild(stopBtn);
      wrap.appendChild(retryBtn);
      wrap.appendChild(delBtn);
      wrap.appendChild(copyBtn);
      content.appendChild(wrap);
    }

    function addUserButtons(userRow) {
      if (userRow.dataset.btnsAttached) return;
      userRow.dataset.btnsAttached = "1";
      const content = userRow.querySelector(".content");
      if (!content) return;

      const wrap = document.createElement("div");
      wrap.className = "my-action-btns";
      wrap.style.cssText =
        "display:flex;justify-content:flex-end;gap:8px;padding:4px 4px 2px;flex-wrap:wrap;";

      const copyBtn = makeBtn("复制");
      bindCopy(copyBtn, ".bubble.user", userRow);

      // ⇺ 重试（从这条用户消息重新发送，其后所有回复 / 后续对话都会被丢弃）
      const retryBtn = makeBtn("↺ 重试");
      retryBtn.addEventListener("click", () => resendFromUserRow(userRow));

      // 删除（本条用户 + 紧随其后的 AI 回复一并删）
      const delBtn = makeBtn("删除");
      delBtn.addEventListener("click", () => deleteRowPair(userRow, "fromUser"));

      wrap.appendChild(retryBtn);
      wrap.appendChild(delBtn);
      wrap.appendChild(copyBtn);
      content.appendChild(wrap);
    }

    // 监听新增的消息行，自动挂按钮（流式回复 / 刷新还原 / 多智能体切换都会触发）
    const observer = new MutationObserver(() => {
      chat.querySelectorAll(".row.ai").forEach(addAiButtons);
      chat.querySelectorAll(".row.user").forEach(addUserButtons);
    });
    observer.observe(chat, { childList: true });

    // 首次加载时给历史还原的消息补按钮
    chat.querySelectorAll(".row.ai").forEach(addAiButtons);
    chat.querySelectorAll(".row.user").forEach(addUserButtons);
  });

  // ────────────────────────────────────────────────────────────
  // ② 智能自动滚动
  //   原 my-comfort.js 的浅/深主题切换已剥离（Phase 4 阶段 4 由 theme.js 接管）
  //   旧 localStorage 键 "my-theme" 已无任何代码读写
  // ────────────────────────────────────────────────────────────
  window.addEventListener("load", function () {
    const chat = document.getElementById("chat");
    const history = document.getElementById("history");
    if (!chat || !history) return;

    // 用户在底部时自动跟随到最新消息；上拉阅读时不打扰
    let autoScroll = true;
    history.addEventListener(
      "scroll",
      () => {
        const dist = history.scrollHeight - history.scrollTop - history.clientHeight;
        autoScroll = dist < 60;
      },
      { passive: true }
    );

    const scrollObserver = new MutationObserver(() => {
      if (autoScroll) {
        history.scrollTo({ top: history.scrollHeight, behavior: "smooth" });
      }
    });
    scrollObserver.observe(chat, { childList: true, subtree: true, characterData: true });

    // 点击发送：强制贴底（即使用户刚才滚到上面看历史）
    const sendBtn = document.getElementById("sendBtn");
    if (sendBtn) {
      sendBtn.addEventListener("click", () => {
        autoScroll = true;
        setTimeout(() => {
          history.scrollTo({ top: history.scrollHeight, behavior: "smooth" });
        }, 50);
      });
    }
  });
})();