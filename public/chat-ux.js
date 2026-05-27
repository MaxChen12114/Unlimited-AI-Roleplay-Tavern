// chat-ux.js —— 对话区交互细节（B 重构：由 my-buttons.js + my-comfort.js 合并改名）
//   ① 用户/AI 行操作按钮（复制 / ↺ 重试 / 删除 / ■ 停止）+ 流式状态守护
//   ② 智能自动滚动（用户在底部时跟随新消息；上拉阅读时不打扰；点发送回底）
(function () {
  window.addEventListener("load", function () {
    const chat = document.getElementById("chat");
    const sendBtn = document.getElementById("sendBtn");
    const msgInput = document.getElementById("msg");
    if (!chat || !sendBtn || !msgInput) return;

    function makeBtn(label) {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.cssText = `
        border: 1px solid #2e2e2e;
        background: #111;
        color: #666;
        border-radius: 10px;
        padding: 4px 11px;
        font-size: 12px;
        cursor: pointer;
        transition: color .15s, background .15s;
      `;
      // hover 颜色随主题变化，避免浅色模式下 hover 闪烁深色
      btn.addEventListener("mouseenter", () => {
        const isLight = localStorage.getItem("my-theme") === "light";
        btn.style.color      = isLight ? "#111"    : "#ccc";
        btn.style.background = isLight ? "#d8d8d8" : "#1e1e1e";
      });
      btn.addEventListener("mouseleave", () => {
        const isLight = localStorage.getItem("my-theme") === "light";
        btn.style.color      = isLight ? "#444"    : "#666";
        btn.style.background = isLight ? "#e8e8e8" : "#111";
      });
      return btn;
    }

    function addAiButtons(aiRow) {
      if (aiRow.dataset.btnsAttached) return;
      aiRow.dataset.btnsAttached = "1";

      const content = aiRow.querySelector(".content");
      if (!content) return;

      const wrap = document.createElement("div");
      wrap.className = "my-action-btns";
      wrap.style.cssText = "display:flex;justify-content:flex-start;gap:8px;padding:4px 4px 2px;flex-wrap:wrap;";

      // 停止（仅流式中可见；点击中断当前请求，已收到的部分作为完整 AI 回复保留入 session）
      const stopBtn = makeBtn("■ 停止");
      stopBtn.classList.add("my-stop-btn");
      stopBtn.style.display = aiRow.dataset.streaming === "1" ? "" : "none";
      stopBtn.addEventListener("click", () => {
        if (typeof window.__abortCurrent === "function") window.__abortCurrent();
        stopBtn.style.display = "none";
        try { delete aiRow.dataset.streaming; } catch (e) { aiRow.removeAttribute("data-streaming"); }
      });

      // 复制
      const copyBtn = makeBtn("复制");
      copyBtn.addEventListener("click", () => {
        const bubble = aiRow.querySelector(".bubble.ai");
        const text = bubble ? bubble.textContent.trim() : "";
        const doFallback = () => {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px;";
          document.body.appendChild(ta);
          ta.focus(); ta.select();
          try { document.execCommand("copy"); copyBtn.textContent = "已复制"; }
          catch { copyBtn.textContent = "失败"; }
          document.body.removeChild(ta);
          setTimeout(() => copyBtn.textContent = "复制", 1500);
        };
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(text)
            .then(() => { copyBtn.textContent = "已复制"; setTimeout(() => copyBtn.textContent = "复制", 1500); })
            .catch(doFallback);
        } else { doFallback(); }
      });

      // 重试
      const retryBtn = makeBtn("↺ 重试");
      retryBtn.addEventListener("click", () => {
        if (typeof window.__abortCurrent === "function") window.__abortCurrent(true);
        const allRows = Array.from(chat.querySelectorAll(".row"));
        const aiIdx = allRows.indexOf(aiRow);
        if (aiIdx < 0) return;
        const userRowDomIdx = aiIdx - 1;
        if (userRowDomIdx < 0 || !allRows[userRowDomIdx].classList.contains("user")) return;
        const bubble = allRows[userRowDomIdx].querySelector(".bubble.user");
        if (!bubble) return;
        const lastUserText = bubble.textContent.trim();
        if (!lastUserText) return;

        for (let i = allRows.length - 1; i >= userRowDomIdx; i--) allRows[i].remove();

        if (typeof window.__sessionTruncateTo === "function") window.__sessionTruncateTo(aiIdx - 1);
        if (typeof window.__resetSending === "function") window.__resetSending();
        else { sendBtn.disabled = false; sendBtn.textContent = "Send"; }

        msgInput.value = lastUserText;
        msgInput.dispatchEvent(new Event("input"));
        setTimeout(() => {
          msgInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        }, 30);
      });

      // 删除（删本条 AI + 前面的用户消息；同时清理任何残留的流式行，避免 DOM/session 错位）
      const delBtn = makeBtn("删除");
      delBtn.addEventListener("click", () => {
        if (typeof window.__abortCurrent === "function") window.__abortCurrent(true);
        const allRows = Array.from(chat.querySelectorAll(".row"));
        const aiIdx = allRows.indexOf(aiRow);
        if (aiIdx < 0) return;
        const userRowDomIdx = aiIdx - 1;
        const hasUserRow = userRowDomIdx >= 0 && allRows[userRowDomIdx].classList.contains("user");
        aiRow.remove();
        if (hasUserRow) allRows[userRowDomIdx].remove();
        if (typeof window.__sessionDeleteAt === "function") {
          window.__sessionDeleteAt(hasUserRow ? userRowDomIdx : aiIdx, hasUserRow ? 2 : 1);
        }
        // 别处仍有流式行时：partialStream 已被 __abortCurrent(true) 丢弃、不会入 session
        // 必须连带从 DOM 移除，否则出现 DOM 多一条悬空 AI 行 / session 少一条 a_n
        chat.querySelectorAll('.row.ai[data-streaming="1"]').forEach((r) => r.remove());
      });

      wrap.appendChild(stopBtn);
      wrap.appendChild(retryBtn);
      wrap.appendChild(delBtn);
      wrap.appendChild(copyBtn);
      content.appendChild(wrap);
    }

    // 用户行按钮（修复刷新后悬空消息无法重试/删除的 bug）
    function addUserButtons(userRow) {
      if (userRow.dataset.btnsAttached) return;
      userRow.dataset.btnsAttached = "1";

      const content = userRow.querySelector(".content");
      if (!content) return;

      const wrap = document.createElement("div");
      wrap.className = "my-action-btns";
      wrap.style.cssText = "display:flex;justify-content:flex-end;gap:8px;padding:4px 4px 2px;flex-wrap:wrap;";

      // 复制
      const copyBtn = makeBtn("复制");
      copyBtn.addEventListener("click", () => {
        const bubble = userRow.querySelector(".bubble.user");
        const text = bubble ? bubble.textContent.trim() : "";
        const doFallback = () => {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px;";
          document.body.appendChild(ta);
          ta.focus(); ta.select();
          try { document.execCommand("copy"); copyBtn.textContent = "已复制"; }
          catch { copyBtn.textContent = "失败"; }
          document.body.removeChild(ta);
          setTimeout(() => copyBtn.textContent = "复制", 1500);
        };
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(text)
            .then(() => { copyBtn.textContent = "已复制"; setTimeout(() => copyBtn.textContent = "复制", 1500); })
            .catch(doFallback);
        } else { doFallback(); }
      });

      // 重试（从这条用户消息重新发送，其后所有回复/后续对话都会被丢弃）
      const retryBtn = makeBtn("↺ 重试");
      retryBtn.addEventListener("click", () => {
        if (typeof window.__abortCurrent === "function") window.__abortCurrent(true);
        const allRows = Array.from(chat.querySelectorAll(".row"));
        const userIdx = allRows.indexOf(userRow);
        if (userIdx < 0) return;
        const bubble = userRow.querySelector(".bubble.user");
        if (!bubble) return;
        const userText = bubble.textContent.trim();
        if (!userText) return;

        for (let i = allRows.length - 1; i >= userIdx; i--) allRows[i].remove();

        if (typeof window.__sessionTruncateTo === "function") window.__sessionTruncateTo(userIdx);
        if (typeof window.__resetSending === "function") window.__resetSending();
        else { sendBtn.disabled = false; sendBtn.textContent = "Send"; }

        msgInput.value = userText;
        msgInput.dispatchEvent(new Event("input"));
        setTimeout(() => {
          msgInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        }, 30);
      });

      // 删除（删本条用户 + 紧随其后的 AI 回复；同时清理任何残留的流式行）
      const delBtn = makeBtn("删除");
      delBtn.addEventListener("click", () => {
        if (typeof window.__abortCurrent === "function") window.__abortCurrent(true);
        const allRows = Array.from(chat.querySelectorAll(".row"));
        const userIdx = allRows.indexOf(userRow);
        if (userIdx < 0) return;
        const nextRow = allRows[userIdx + 1];
        const hasAi = !!(nextRow && nextRow.classList.contains("ai"));
        userRow.remove();
        if (hasAi) nextRow.remove();
        if (typeof window.__sessionDeleteAt === "function") {
          window.__sessionDeleteAt(userIdx, hasAi ? 2 : 1);
        }
        chat.querySelectorAll('.row.ai[data-streaming="1"]').forEach((r) => r.remove());
      });

      wrap.appendChild(retryBtn);
      wrap.appendChild(delBtn);
      wrap.appendChild(copyBtn);
      content.appendChild(wrap);
    }

    const observer = new MutationObserver(() => {
      chat.querySelectorAll(".row.ai").forEach(addAiButtons);
      chat.querySelectorAll(".row.user").forEach(addUserButtons);
    });
    observer.observe(chat, { childList: true });

    // 刷新后历史已恢复时补充按钮
    chat.querySelectorAll(".row.ai").forEach(addAiButtons);
    chat.querySelectorAll(".row.user").forEach(addUserButtons);
  });
})();

// ============================================================
// ② 智能自动滚动
//   历史命名：原 my-comfort.js（旧的浅/深主题切换系统已剥离，由 Phase 4 阶段 4 接管）
//   旧 localStorage 键 "my-theme" 留在本地无害（不再被任何代码读写）
// ============================================================
(function () {
  window.addEventListener("load", function () {
    const chat = document.getElementById("chat");
    const history = document.getElementById("history");
    if (!chat || !history) return;

    // 用户在底部时自动跟随到最新消息；上拉阅读时不打扰
    let autoScroll = true;

    history.addEventListener("scroll", () => {
      const dist = history.scrollHeight - history.scrollTop - history.clientHeight;
      autoScroll = dist < 60;
    }, { passive: true });

    const scrollObserver = new MutationObserver(() => {
      if (autoScroll) {
        history.scrollTo({ top: history.scrollHeight, behavior: "smooth" });
      }
    });
    scrollObserver.observe(chat, { childList: true, subtree: true, characterData: true });

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