// public/dev.js — 开发者模式中央 (4.17 新增,集中所有 dev-only 逻辑)
// API: window.__dev = { isOn, toggle, enable, disable, debug, log, exportLS, setLastPayload, openPanel }
//
// 设计原则:
//   1. 所有 dev-only 入口/调试逻辑集中此模块,不散落到 character.js / app.js / index.html
//   2. 加载顺序: auth.js → dev.js → 其他。dev.js 内 monkey-patch window.fetch,
//      包裹 auth.js 的 Authorization 注入,无副作用(只在 /api/chat 路径抓 payload 旁路存储)
//   3. Easter-egg: 长按底栏 #githubBtn 2 秒切换 dev mode (短按仍跳转 GitHub)
//   4. DOM 上凡是 [data-dev-only] 的元素,普通模式自动 display:none
//   5. dev mode ON 时右上角常驻 🛠 角标(短按打开 Dev Panel,长按 1.5 秒关闭 dev mode)
//
// LS keys:
//   cfw_dev_mode_v1="1"  开发者模式总开关
//   cfw_dev_debug_v1="1" verbose console log 开关(window.__dev.debug)
(function(){
  "use strict";
  const KEY="cfw_dev_mode_v1";
  const DBG="cfw_dev_debug_v1";
  const isOn=()=>localStorage.getItem(KEY)==="1";

  // === Public API ===
  const api={
    isOn,
    debug:localStorage.getItem(DBG)==="1",
    log(...a){if(api.debug)console.log("[dev]",...a);},
    enable(){localStorage.setItem(KEY,"1");location.reload();},
    disable(){localStorage.removeItem(KEY);location.reload();},
    toggle:toggleDev,
    exportLS:exportCfwLs,
    setLastPayload,
    openPanel,
  };
  window.__dev=api;

  // === Toast helper ===
  function toast(msg,ms){
    const t=document.createElement("div");
    t.textContent=msg;
    t.style.cssText="position:fixed;left:50%;top:24px;transform:translateX(-50%);padding:10px 18px;background:rgba(0,0,0,.88);color:#fff;border-radius:10px;font-size:13px;font-weight:600;z-index:99999;box-shadow:0 6px 20px rgba(0,0,0,.4);backdrop-filter:blur(8px);";
    document.body.appendChild(t);
    setTimeout(()=>t.remove(),ms||1200);
    return t;
  }

  // === Toggle ===
  function toggleDev(){
    const cur=isOn();
    if(cur)localStorage.removeItem(KEY);else localStorage.setItem(KEY,"1");
    try{navigator.vibrate&&navigator.vibrate([30,60,30]);}catch{}
    toast((cur?"🔒 开发者模式 OFF":"🛠 开发者模式 ON")+" · 1 秒后刷新",1000);
    setTimeout(()=>location.reload(),1000);
  }

  // === Apply [data-dev-only] visibility ===
  function applyVisibility(){
    document.documentElement.classList.toggle("dev-mode",isOn());
    document.querySelectorAll("[data-dev-only]").forEach(el=>{
      el.style.display=isOn()?"":"none";
    });
  }

  // === 🛠 角标 ===
  function ensureBadge(){
    const ex=document.getElementById("dev-badge");
    if(!isOn()){if(ex)ex.remove();return;}
    if(ex)return;
    const b=document.createElement("button");
    b.id="dev-badge";
    b.textContent="🛠";
    b.title="开发者模式 ON · 短按打开 Dev Panel · 长按 1.5 秒关闭";
    b.style.cssText="position:fixed;top:10px;right:10px;width:32px;height:32px;border-radius:50%;border:1px solid rgba(255,255,255,.25);background:linear-gradient(135deg,#7d4fcc,#cc4f7d);color:#fff;font-size:14px;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.45);z-index:9998;display:flex;align-items:center;justify-content:center;padding:0;line-height:1;";
    document.body.appendChild(b);
    let t=null,fired=false;
    b.addEventListener("pointerdown",()=>{fired=false;if(t)clearTimeout(t);t=setTimeout(()=>{fired=true;toggleDev();},1500);});
    b.addEventListener("pointerup",()=>{if(t){clearTimeout(t);t=null;}});
    b.addEventListener("pointerleave",()=>{if(t){clearTimeout(t);t=null;}});
    b.addEventListener("pointercancel",()=>{if(t){clearTimeout(t);t=null;}});
    b.addEventListener("click",(e)=>{if(fired){fired=false;e.preventDefault();e.stopPropagation();return;}openPanel();});
  }

  // === Easter-egg: 长按 GitHub 按钮 2 秒切换 ===
  function wireGithubLongPress(){
    const g=document.getElementById("githubBtn");
    if(!g)return;
    let lpT=null,lpF=false;
    g.addEventListener("pointerdown",()=>{lpF=false;if(lpT)clearTimeout(lpT);lpT=setTimeout(()=>{lpF=true;toggleDev();},2000);});
    g.addEventListener("pointerup",()=>{if(lpT){clearTimeout(lpT);lpT=null;}});
    g.addEventListener("pointerleave",()=>{if(lpT){clearTimeout(lpT);lpT=null;}});
    g.addEventListener("pointercancel",()=>{if(lpT){clearTimeout(lpT);lpT=null;}});
    g.addEventListener("click",(e)=>{if(lpF){e.preventDefault();e.stopPropagation();lpF=false;}});
    g.addEventListener("contextmenu",(e)=>{if(lpT||lpF)e.preventDefault();});
  }

  // === Wire #syncPauseBtn (4.17: 顶栏暂停同步按钮,dev-only) ===
  function wireSyncPauseBtn(){
    const btn=document.getElementById("syncPauseBtn");
    if(!btn)return;
    function refresh(){
      const paused=window.__sync&&window.__sync.isPaused&&window.__sync.isPaused();
      btn.textContent=paused?"▶":"⏸";
      btn.title=paused?"恢复同步(目前已暂停)":"暂停同步(临时不推 KV,避免乱聊污染云端)";
      btn.style.background=paused?"rgba(255,160,80,0.25)":"";
    }
    btn.addEventListener("click",()=>{
      if(!window.__sync)return;
      if(window.__sync.isPaused())window.__sync.resume();
      else window.__sync.pause();
      refresh();
      toast(window.__sync.isPaused()?"⏸ 同步已暂停":"▶ 同步已恢复",1200);
    });
    refresh();
  }

  // === Prompt 调试: monkey-patch fetch,旁路存最近一次 /api/chat payload ===
  let lastPayload=null;
  function setLastPayload(p){lastPayload={at:Date.now(),payload:p};api.log("capture payload",p);}
  (function patchFetch(){
    if(!window.fetch)return;
    const orig=window.fetch.bind(window);
    window.fetch=function(input,init){
      try{
        const url=typeof input==="string"?input:(input&&input.url)||"";
        if(url.indexOf("/api/chat")>=0&&init&&init.body){
          try{
            const b=typeof init.body==="string"?JSON.parse(init.body):init.body;
            setLastPayload(b);
          }catch{}
        }
      }catch{}
      return orig(input,init);
    };
  })();

  // === LS 导出 ===
  function exportCfwLs(){
    const obj={};
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(k&&k.indexOf("cfw_")===0)obj[k]=localStorage.getItem(k);
    }
    navigator.clipboard.writeText(JSON.stringify(obj,null,2));
    return obj;
  }
  function exportAllLs(){
    const obj={};
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(k)obj[k]=localStorage.getItem(k);
    }
    navigator.clipboard.writeText(JSON.stringify(obj,null,2));
    return obj;
  }

  // === Dev Panel ===
  let mask=null;
  function openPanel(){
    if(mask){mask.style.display="flex";renderPanel();return;}
    mask=document.createElement("div");
    mask.id="dev-panel-mask";
    mask.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:99997;padding:20px;backdrop-filter:blur(4px);";
    const p=document.createElement("div");
    p.id="dev-panel";
    p.style.cssText="background:#0e0e0e;color:#e0e0e0;border:1px solid #333;border-radius:12px;padding:18px;max-width:760px;width:100%;max-height:85vh;overflow-y:auto;font-size:13px;line-height:1.6;";
    mask.appendChild(p);
    document.body.appendChild(mask);
    mask.addEventListener("click",(e)=>{if(e.target===mask)mask.style.display="none";});
    renderPanel();
  }
  function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
  function renderPanel(){
    const p=document.getElementById("dev-panel");
    if(!p)return;
    const lp=lastPayload;
    const h=[];
    h.push(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;border-bottom:1px solid #333;padding-bottom:10px;"><h3 style="margin:0;font-size:16px;">🛠 Dev Panel</h3><button data-close style="background:#1a1a1a;color:#aaa;border:1px solid #333;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;">关闭</button></div>`);
    h.push(`<div style="margin-bottom:14px;padding:10px;background:#1a1a1a;border-radius:6px;"><label style="display:flex;gap:8px;align-items:center;cursor:pointer;"><input type="checkbox" ${api.debug?"checked":""} data-debug-toggle><span>Console verbose log <code style="font-size:11px;background:#000;padding:1px 5px;border-radius:3px;">window.__dev.debug</code></span></label></div>`);
    // 4.17: 云同步状态 + KV 配额监控
    if(window.__sync&&window.__sync.getStatus){
      const ss=window.__sync.getStatus();
      const quotaColor=ss.pushCount>=800?"#f60":ss.pushCount>=500?"#fc0":"#888";
      h.push(`<div style="margin-bottom:14px;padding:10px;background:#1a1a1a;border-radius:6px;font-size:12px;line-height:1.7;"><div style="color:#ccc;font-weight:600;margin-bottom:4px;">☁️ 云同步状态</div><div>启用: <code>${ss.enabled?"YES":"NO"}</code> · 暂停: <code>${ss.paused?"YES":"NO"}</code> · 同步聊天: <code>${ss.includeChat?"YES":"NO"}</code></div><div>今日 push: <code style="color:${quotaColor};">${ss.pushCount}</code> / 1000 (Cloudflare KV 免费层)</div></div>`);
    }
    h.push(`<div style="margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap;"><button class="dev-btn" data-export-cfw>📤 复制 cfw_* localStorage</button><button class="dev-btn" data-export-all>📤 复制全部 localStorage</button><button class="dev-btn" data-disable>🔒 关闭开发者模式</button></div>`);
    h.push(`<div style="margin-bottom:8px;font-weight:600;font-size:14px;">🐛 最近一次 worker 请求 payload</div>`);
    if(!lp){
      h.push(`<div style="color:#888;font-size:12px;padding:10px;background:#0a0a0a;border-radius:6px;border:1px dashed #333;">暂未捕获。发一条消息后再来看(只抓 /api/chat 路径)。</div>`);
    }else{
      const ago=Math.floor((Date.now()-lp.at)/1000);
      const pretty=JSON.stringify(lp.payload,null,2);
      h.push(`<div style="color:#888;font-size:11px;margin-bottom:6px;">${ago} 秒前 · ${new Date(lp.at).toLocaleTimeString()}</div>`);
      h.push(`<pre style="background:#000;color:#9cdcfe;padding:12px;border-radius:6px;max-height:420px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:11px;line-height:1.55;font-family:ui-monospace,Menlo,Consolas,monospace;">${esc(pretty)}</pre>`);
      h.push(`<button class="dev-btn" data-copy-payload style="margin-top:8px;">📋 复制 payload JSON</button>`);
    }
    h.push(`<style>.dev-btn{background:#1a1a1a;color:#ccc;border:1px solid #333;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;}.dev-btn:hover{background:#222;}</style>`);
    p.innerHTML=h.join("");
    p.querySelector("[data-close]")?.addEventListener("click",()=>{mask.style.display="none";});
    p.querySelector("[data-debug-toggle]")?.addEventListener("change",(e)=>{api.debug=e.target.checked;localStorage.setItem(DBG,api.debug?"1":"0");});
    p.querySelector("[data-export-cfw]")?.addEventListener("click",()=>{const o=exportCfwLs();toast("已复制 cfw_* · "+Object.keys(o).length+" 项",1200);});
    p.querySelector("[data-export-all]")?.addEventListener("click",()=>{const o=exportAllLs();toast("已复制全部 · "+Object.keys(o).length+" 项",1200);});
    p.querySelector("[data-disable]")?.addEventListener("click",()=>{if(confirm("关闭开发者模式并刷新?"))api.disable();});
    p.querySelector("[data-copy-payload]")?.addEventListener("click",()=>{navigator.clipboard.writeText(JSON.stringify(lp.payload,null,2));toast("payload 已复制",1000);});
  }

  // === Boot ===
  document.addEventListener("DOMContentLoaded",()=>{
    applyVisibility();
    ensureBadge();
    wireGithubLongPress();
    wireSyncPauseBtn();
    api.log("dev.js loaded · dev mode =",isOn()?"ON":"OFF");
  });
})();