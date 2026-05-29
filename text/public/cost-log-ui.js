// cost-log-ui.js — Phase 4 阶段 7 · 费用日志 UI（独立于本地历史）
// 拆自 index.html 内联 script（架构整理 · B 方案）
// 数据来源：window.__cost（由 app.js 暴露），LS key：cfw_cost_log_v1
(function () {
  window.addEventListener("load", function () {
    function _ttoday() {
      var d = new Date();
      return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
    }
    function renderCostUI() {
      var log = (window.__cost && window.__cost.loadCostLog) ? window.__cost.loadCostLog() : {};
      var today = _ttoday();
      var monthPrefix = today.slice(0, 7);
      var wk = new Date(Date.now() - 6*86400000);
      var weekStr = wk.getFullYear() + "-" + String(wk.getMonth()+1).padStart(2,"0") + "-" + String(wk.getDate()).padStart(2,"0");
      var todayC = 0, weekC = 0, monthC = 0, totalC = 0, totalR = 0;
      var days = Object.keys(log).sort().reverse();
      days.forEach(function (d) {
        var e = log[d] || {};
        totalC += e.cost || 0;
        totalR += e.requests || 0;
        if (d === today) todayC += e.cost || 0;
        if (d >= weekStr) weekC += e.cost || 0;
        if (d.startsWith(monthPrefix)) monthC += e.cost || 0;
      });
      var sum = document.getElementById("costSummary");
      if (sum) {
        sum.innerHTML =
          '<div class="cost-cell"><span class="cost-label">今日</span><span class="cost-val">¥' + todayC.toFixed(4) + '</span></div>' +
          '<div class="cost-cell"><span class="cost-label">近 7 日</span><span class="cost-val">¥' + weekC.toFixed(4) + '</span></div>' +
          '<div class="cost-cell"><span class="cost-label">本月</span><span class="cost-val">¥' + monthC.toFixed(4) + '</span></div>' +
          '<div class="cost-cell total"><span class="cost-label">总计</span><span class="cost-val">¥' + totalC.toFixed(4) + '</span><span class="cost-sub">' + totalR + ' 次请求</span></div>';
      }
      var list = document.getElementById("costDailyList");
      if (list) {
        if (!days.length) {
          list.innerHTML = '<div class="cost-empty">暂无数据。快速模式（DeepSeek）下发出第一条计费消息后开始记录。</div>';
        } else {
          list.innerHTML = days.map(function (d) {
            var e = log[d] || {};
            return '<div class="cost-row"><span class="cost-date">' + d + '</span>' +
              '<span class="cost-amt">¥' + (e.cost||0).toFixed(5) + '</span>' +
              '<span class="cost-meta">' + (e.requests||0) + ' 次 · in ' + (e.prompt||0) + ' / out ' + (e.completion||0) + '</span></div>';
          }).join("");
        }
      }
    }
    var exportBtn = document.getElementById("costExportBtn");
    if (exportBtn) {
      exportBtn.addEventListener("click", function () {
        var log = (window.__cost && window.__cost.loadCostLog) ? window.__cost.loadCostLog() : {};
        var json = JSON.stringify(log, null, 2);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(json).then(
            function () { alert("已导出到剪贴板"); },
            function () { prompt("复制下方 JSON：", json); }
          );
        } else { prompt("复制下方 JSON：", json); }
      });
    }
    var clearBtn = document.getElementById("costClearBtn");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        if (!confirm("确定清空所有费用日志？此操作不可恢复。\n建议先导出备份。")) return;
        try { localStorage.removeItem("cfw_cost_log_v1"); } catch (e) {}
        renderCostUI();
        if (window.__cost && window.__cost.refreshTopbar) window.__cost.refreshTopbar();
      });
    }
    if (window.__cost) window.__cost.refreshSettings = renderCostUI;
    renderCostUI();
    // 打开 Settings 时刷新数字（防止后台有新计费）
    var sb = document.getElementById("settingsBtn");
    if (sb) sb.addEventListener("click", renderCostUI);
  });
})();