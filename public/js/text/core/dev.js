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
  // 4.18 (fix v2): 彻底不再 fixed 浮动,改为 wire index.html 顶栏 #devBadgeTopbar 按钮
  // (该按钮带 data-dev-only,普通模式被 applyVisibility 隐藏,dev mode ON 才出现)
  // 顺手清理可能残留的旧 fixed badge
  function ensureBadge(){
    const old=document.getElementById("dev-badge");
    if(old)old.remove();
    const b=document.getElementById("devBadgeTopbar");
    if(!b)return;
    if(b.dataset.wired==="1")return;
    b.dataset.wired="1";
    let t=null,fired=false;
    b.addEventListener("pointerdown",()=>{fired=false;if(t)clearTimeout(t);t=setTimeout(()=>{fired=true;toggleDev();},1500);});
    b.addEventListener("pointerup",()=>{if(t){clearTimeout(t);t=null;}});
    b.addEventListener("pointerleave",()=>{if(t){clearTimeout(t);t=null;}});
    b.addEventListener("pointercancel",()=>{if(t){clearTimeout(t);t=null;}});
    b.addEventListener("click",(e)=>{if(fired){fired=false;e.preventDefault();e.stopPropagation();return;}openPanel();});
  }

  // === Easter-egg: 长按 GitHub 按钮 1.2 秒切换 (4.18 加震动+缩放+光晕反馈,原 2s 无反馈太迷糊) ===
  function wireGithubLongPress(){
    const g=document.getElementById("githubBtn");
    if(!g)return;
    let lpT=null,lpF=false,vibT=null;
    const HOLD_MS=1200;
    function start(){
      lpF=false;
      if(lpT)clearTimeout(lpT);
      // 按下瞬间: 缩放反馈 + 启动光晕
      g.style.transition="transform .15s ease, box-shadow .15s ease";
      g.style.transform="scale(0.92)";
      g.style.boxShadow="0 0 0 0 rgba(140,100,220,.6)";
      // 1.2s 内光晕渐进扩散 (模拟蓄力倒计时)
      requestAnimationFrame(()=>{
        g.style.transition="transform .15s ease, box-shadow "+HOLD_MS+"ms ease";
        g.style.boxShadow="0 0 0 18px rgba(140,100,220,0)";
      });
      // 三段震动: 按下 / 中段 / 触发
      try{navigator.vibrate&&navigator.vibrate(15);}catch{}
      vibT=setTimeout(()=>{try{navigator.vibrate&&navigator.vibrate(25);}catch{}},600);
      lpT=setTimeout(()=>{
        lpF=true;
        try{navigator.vibrate&&navigator.vibrate([40,30,40,30,80]);}catch{}
        toggleDev();
      },HOLD_MS);
    }
    function cancel(){
      if(lpT){clearTimeout(lpT);lpT=null;}
      if(vibT){clearTimeout(vibT);vibT=null;}
      g.style.transform="";
      g.style.boxShadow="";
      g.style.transition="";
    }
    g.addEventListener("pointerdown",start);
    g.addEventListener("pointerup",cancel);
    g.addEventListener("pointerleave",cancel);
    g.addEventListener("pointercancel",cancel);
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

  // ============== 4.23 Dev 测试增强 · 状态 ==============
  const OVR_KEY="cfw_dev_overrides_v1";
  const NOTES_KEY="cfw_dev_notes_v1";
  const HUD_KEY="cfw_dev_hud_v1";
  const INJECT_ID="__dev_inject__";
  let ovr=(function(){try{return JSON.parse(localStorage.getItem(OVR_KEY)||"{}")||{};}catch(e){return{};}})();
  let fault=null;
  let faultMs=4000;
  function saveOvr(){try{localStorage.setItem(OVR_KEY,JSON.stringify(ovr));}catch(e){}}
  const hud={inflight:false,ms:0,bytes:0,at:0,model:""};
  let snapshots=[];

  // === Prompt 调试: monkey-patch fetch,旁路存最近一次 /api/chat payload ===
  let lastPayload=null;
  function setLastPayload(p){lastPayload={at:Date.now(),payload:p};api.log("capture payload",p);}
  (function patchFetch(){
    if(!window.fetch)return;
    const orig=window.fetch.bind(window);
    window.fetch=async function(input,init){
      let isChat=false;
      try{
        const url=typeof input==="string"?input:(input&&input.url)||"";
        isChat=url.indexOf("/api/chat")>=0;
        if(isChat&&init&&init.body){
          try{
            let b=typeof init.body==="string"?JSON.parse(init.body):init.body;
            setLastPayload(b);
            if(typeof ovr.temp==="number")b.temperature=ovr.temp;
            if(typeof ovr.maxTokens==="number")b.max_tokens=ovr.maxTokens;
            init=Object.assign({},init,{body:JSON.stringify(b)});
            if(b&&b.model)hud.model=b.model;
          }catch(e){}
        }
      }catch(e){}
      if(isChat&&fault){
        api.log("fault inject",fault);
        if(fault==="error")return Promise.reject(new TypeError("[dev] 故障注入:模拟网络中断"));
        if(fault==="http500")return new Response('{"error":"[dev] injected 500"}',{status:500,statusText:"Dev Injected",headers:{"content-type":"application/json"}});
        if(fault==="slow")await new Promise(r=>setTimeout(r,faultMs));
      }
      if(!isChat)return orig(input,init);
      const t0=(window.performance&&performance.now)?performance.now():Date.now();
      hud.inflight=true;try{updateHud();}catch(e){}
      let resp;
      try{resp=await orig(input,init);}catch(e){hud.inflight=false;try{updateHud();}catch(_){}throw e;}
      try{measureStream(resp.clone(),t0);}catch(e){hud.inflight=false;try{updateHud();}catch(_){}}
      return resp;
    };
  })();

  function measureStream(resp,t0){
    let bytes=0;
    const rd=(resp&&resp.body&&resp.body.getReader)?resp.body.getReader():null;
    if(!rd){hud.inflight=false;try{updateHud();}catch(e){}return;}
    (function pump(){
      rd.read().then(function(o){
        if(o.done){const t1=(window.performance&&performance.now)?performance.now():Date.now();hud.ms=Math.round(t1-t0);hud.bytes=bytes;hud.at=Date.now();hud.inflight=false;try{updateHud();}catch(e){}return;}
        bytes+=o.value?o.value.length:0;pump();
      }).catch(function(){hud.inflight=false;try{updateHud();}catch(e){}});
    })();
  }

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

  function readLsAll(){const o={};for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k)o[k]=localStorage.getItem(k);}return o;}
  function modelOptions(){const sel=document.getElementById("modelSel");return sel?Array.prototype.map.call(sel.options,function(o){return{v:o.value,t:o.textContent};}):[];}
  function setModel(v){const sel=document.getElementById("modelSel");if(sel){sel.value=v;sel.dispatchEvent(new Event("change",{bubbles:true}));}}
  function setNsfw(v){localStorage.setItem("cfw_nsfw_mode_v1",String(v));try{window.dispatchEvent(new Event("theme:changed"));}catch(e){}}
  function clickThink(){const b=document.getElementById("thinkToggle");if(b)b.click();}
  function setStrict(on){localStorage.setItem("cfw_strict_roleplay_v1",on?"1":"0");}
  function setReplyStyle(v){localStorage.setItem("cfw_reply_style_v1",v);}
  function getInject(){try{const a=JSON.parse(localStorage.getItem("cfw_prompt_presets_v1")||"[]");const p=(Array.isArray(a)?a:[]).find(function(x){return x&&x.id===INJECT_ID;});return p?p.content:"";}catch(e){return"";}}
  function setInject(text){let a;try{a=JSON.parse(localStorage.getItem("cfw_prompt_presets_v1")||"[]");if(!Array.isArray(a))a=[];}catch(e){a=[];}a=a.filter(function(x){return !(x&&x.id===INJECT_ID);});if(text&&text.trim()){const mo=a.reduce(function(m,x){return Math.max(m,x.order||0);},0);a.push({id:INJECT_ID,name:"🧪 DEV注入",content:text,enabled:true,order:mo+1,group:"DEV"});}try{localStorage.setItem("cfw_prompt_presets_v1",JSON.stringify(a));}catch(e){}}
  function snapTake(name){const slot={name:name||("存档 "+(snapshots.length+1)),at:Date.now(),ls:readLsAll()};snapshots.push(slot);return slot;}
  function snapRestore(i){const s=snapshots[i];if(!s)return;if(!confirm("回滚到「"+s.name+"」？\n会覆盖当前 localStorage 并刷新(IndexedDB 角色卡/道具不受影响)。"))return;try{localStorage.clear();Object.keys(s.ls).forEach(function(k){localStorage.setItem(k,s.ls[k]);});}catch(e){alert("回滚失败:"+e);return;}location.reload();}
  function snapDownload(i){const s=(i>=0&&snapshots[i])?snapshots[i]:{name:"current",at:Date.now(),ls:readLsAll()};const blob=new Blob([JSON.stringify(s,null,2)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="snapshot-"+Date.now()+".json";a.click();setTimeout(function(){URL.revokeObjectURL(a.href);},2000);}
  function snapUpload(file){const r=new FileReader();r.onload=function(){try{const s=JSON.parse(r.result);if(!s||!s.ls)throw new Error("格式不对");if(!confirm("从文件回滚?会覆盖当前 localStorage 并刷新。"))return;localStorage.clear();Object.keys(s.ls).forEach(function(k){localStorage.setItem(k,s.ls[k]);});location.reload();}catch(e){alert("读取失败:"+e);}};r.readAsText(file);}
  function notesLoad(){try{const r=JSON.parse(localStorage.getItem(NOTES_KEY)||"[]");return Array.isArray(r)?r:[];}catch(e){return[];}}
  function notesSave(a){try{localStorage.setItem(NOTES_KEY,JSON.stringify(a));}catch(e){}}
  function noteAdd(text){if(!text||!text.trim())return;const a=notesLoad();const ch=window.__character;const cardName=(ch&&ch.getActiveCard&&(ch.getActiveCard()||{}).name)||"";const ctx={model:hud.model||"",nsfw:localStorage.getItem("cfw_nsfw_mode_v1")||"0",theme:localStorage.getItem("cfw_theme_v1")||"minimal",card:cardName};a.push({at:Date.now(),text:text.trim(),ctx:ctx});notesSave(a);}
  function noteDel(i){const a=notesLoad();a.splice(i,1);notesSave(a);}
  let hudEl=null;
  function showHud(){if(!hudEl){hudEl=document.createElement("div");hudEl.id="dev-hud";hudEl.style.cssText="position:fixed;left:12px;bottom:72px;z-index:9000;background:rgba(10,10,14,.92);color:#cfe;border:1px solid #345;border-radius:10px;padding:8px 10px;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;max-width:240px;box-shadow:0 6px 18px rgba(0,0,0,.5);backdrop-filter:blur(6px);cursor:move;";document.body.appendChild(hudEl);dragify(hudEl);}localStorage.setItem(HUD_KEY,"1");hudEl.style.display="block";updateHud();}
  function hideHud(){localStorage.setItem(HUD_KEY,"0");if(hudEl)hudEl.style.display="none";}
  function dragify(el){let sx,sy,ox,oy,on=false;el.addEventListener("pointerdown",function(e){if(e.target.closest&&e.target.closest("[data-hud-x]"))return;on=true;sx=e.clientX;sy=e.clientY;const r=el.getBoundingClientRect();ox=r.left;oy=r.top;try{el.setPointerCapture(e.pointerId);}catch(_){}});el.addEventListener("pointermove",function(e){if(!on)return;el.style.left=(ox+e.clientX-sx)+"px";el.style.top=(oy+e.clientY-sy)+"px";el.style.bottom="auto";});el.addEventListener("pointerup",function(){on=false;});}
  function updateHud(){if(!hudEl||hudEl.style.display==="none")return;const nsf=localStorage.getItem("cfw_nsfw_mode_v1")||"0";const th=localStorage.getItem("cfw_theme_v1")||"minimal";const think=(document.getElementById("thinkToggle")||{}).textContent||"";let sync="—",push="—";try{if(window.__sync&&window.__sync.getStatus){const s=window.__sync.getStatus();sync=s.enabled?(s.paused?"暂停":"开"):"关";push=s.pushCount;}}catch(e){}const spd=hud.ms?(Math.round(hud.bytes/1024/(hud.ms/1000)*10)/10+"KB/s"):"—";hudEl.innerHTML='<div style="display:flex;justify-content:space-between;gap:8px;"><b style="color:#8df;">🛠 HUD</b><span data-hud-x style="cursor:pointer;color:#f88;">✕</span></div><div>模型 '+esc(hud.model||"—")+'</div><div>NSFW '+nsf+' · '+esc(th)+'</div><div>'+esc(think)+'</div><div>同步 '+sync+' · push '+push+'</div><div>'+(hud.inflight?'<span style="color:#fd6;">● 请求中…</span>':('上次 '+(hud.ms||0)+'ms · '+spd))+'</div>'+(fault?'<div style="color:#f66;">⚠ 故障注入:'+fault+'</div>':'');const x=hudEl.querySelector("[data-hud-x]");if(x)x.onclick=hideHud;}
  setInterval(function(){try{updateHud();}catch(e){}},2000);
  function buildReport(){const notes=notesLoad();const lines=["# 测试报告 "+new Date().toLocaleString(),"","## 环境","- 模型(最近): "+(hud.model||"—"),"- NSFW: "+(localStorage.getItem("cfw_nsfw_mode_v1")||"0"),"- 主题: "+(localStorage.getItem("cfw_theme_v1")||"minimal"),"- UA: "+navigator.userAgent,"","## Bug / 笔记 ("+notes.length+")"];notes.forEach(function(n,i){lines.push((i+1)+". ["+new Date(n.at).toLocaleString()+"] "+n.text+"  \n   _ctx: 模型="+n.ctx.model+" NSFW="+n.ctx.nsfw+" 主题="+n.ctx.theme+(n.ctx.card?" 角色="+n.ctx.card:"")+"_");});if(lastPayload){lines.push("","## 最近一次请求 payload","```json",JSON.stringify(lastPayload.payload,null,2),"```");}return lines.join("\n");}
  function buildScene(n,startMode){const ch=window.__character,M=window.__multi;if(!M||!ch){alert("多智能体/角色模块未就绪");return;}const archs=(ch.archetypes||[]).slice(0,Math.max(2,Math.min(6,n||3)));if(!archs.length){alert("没有可用原型");return;}M.setMulti(true);M.getSceneIds().slice().forEach(function(id){M.removeFromScene(id);});archs.forEach(function(a){M.addToScene(a.id);});if(ch.setActiveId&&archs[0])ch.setActiveId(archs[0].id);const fb=window.__fishbowl;if(startMode&&fb){fb.setMode(startMode);if(fb.setMaxRounds)fb.setMaxRounds(6);if(startMode==="discuss"&&fb.setTopic)fb.setTopic("测试议题:今晚吃什么");setTimeout(function(){if(fb.start)fb.start();},250);}toast("🎭 已造场景:"+archs.length+" 人"+(startMode?" · "+startMode:""),1600);}
  function chaos(){const themes=["minimal","glass","lewd-peach","lewd-doll"];const t=themes[Math.floor(Math.random()*themes.length)];if(window.__theme&&window.__theme.set)window.__theme.set(t);else localStorage.setItem("cfw_theme_v1",t);const nv=String(Math.floor(Math.random()*3));setNsfw(nv);const opts=modelOptions();if(opts.length)setModel(opts[Math.floor(Math.random()*opts.length)].v);const styles=["default","wechat","verbose"];setReplyStyle(styles[Math.floor(Math.random()*styles.length)]);setStrict(Math.random()<0.5);toast("🎰 混沌:"+t+" · NSFW"+nv,2000);setTimeout(function(){if(mask&&mask.style.display!=="none")renderPanel();},120);}
  async function replay(){if(!lastPayload){alert("还没捕获到 payload,先发一条消息");return;}const t0=Date.now();try{const r=await window.fetch("/api/chat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(lastPayload.payload)});const txt=await r.text();alert("重放完成 "+(Date.now()-t0)+"ms · HTTP "+r.status+"\n\n"+txt.slice(0,800));}catch(e){alert("重放失败:"+e);}}
  function dtParam(){
    const opts=modelOptions(),cur=(document.getElementById("modelSel")||{}).value||"";
    const nsf=localStorage.getItem("cfw_nsfw_mode_v1")||"0",rs=localStorage.getItem("cfw_reply_style_v1")||"default",strict=localStorage.getItem("cfw_strict_roleplay_v1")==="1";
    return '<div class="devx-card"><div class="devx-h">⚡ 参数快切台</div><div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;"><select data-q-model class="dev-in">'+opts.map(function(o){return '<option value="'+esc(o.v)+'"'+(o.v===cur?" selected":"")+'>'+esc(o.t)+'</option>';}).join("")+'</select><select data-q-nsfw class="dev-in">'+[0,1,2,3].map(function(v){return '<option value="'+v+'"'+(String(v)===nsf?" selected":"")+'>NSFW '+v+'</option>';}).join("")+'</select><select data-q-style class="dev-in"><option value="default"'+(rs==="default"?" selected":"")+'>默认</option><option value="wechat"'+(rs==="wechat"?" selected":"")+'>微信连发</option><option value="verbose"'+(rs==="verbose"?" selected":"")+'>长段叙事</option></select><button class="dev-btn" data-q-think>🧠 思考</button><label style="display:flex;gap:4px;align-items:center;"><input type="checkbox" data-q-strict'+(strict?" checked":"")+'>严格RP</label></div><div style="display:flex;gap:6px;margin-top:6px;align-items:center;"><span style="color:#888;">temp</span><input data-q-temp class="dev-in" type="number" step="0.1" style="width:60px;" value="'+(typeof ovr.temp==="number"?ovr.temp:"")+'" placeholder="默认"><span style="color:#888;">max</span><input data-q-max class="dev-in" type="number" style="width:80px;" value="'+(typeof ovr.maxTokens==="number"?ovr.maxTokens:"")+'" placeholder="默认"></div><div class="devx-tip">temp/max 为追加叠加;worker 不读则无害</div></div>';
  }
  function dtPrompt(){
    return '<div class="devx-card"><div class="devx-h">🔍 Prompt 透视 + 实时注入</div><button class="dev-btn" data-x-payload>🔬 解析最近 payload</button><div class="devx-tip" style="margin:6px 0 4px;">下面内容作为追加预设(🧪DEV注入)走真实通道,只追加不动解限 base:</div><textarea data-inject class="dev-in" rows="3" style="width:100%;" placeholder="临时追加到 system…">'+esc(getInject())+'</textarea><div style="display:flex;gap:6px;margin-top:4px;"><button class="dev-btn" data-inject-save>💉 启用注入</button><button class="dev-btn" data-inject-clear>清除注入</button></div></div>';
  }
  function dtSnap(){
    return '<div class="devx-card"><div class="devx-h">💾 状态快照 / 回滚</div><div style="display:flex;gap:6px;flex-wrap:wrap;"><button class="dev-btn" data-snap-take>📸 存档(内存)</button><button class="dev-btn" data-snap-dl>⬇ 下载当前</button><label class="dev-btn" style="cursor:pointer;">⬆ 从文件回滚<input type="file" data-snap-up accept=".json" style="display:none;"></label></div><div data-snap-list style="margin-top:6px;font-size:11px;"></div><div class="devx-tip">快照只含 localStorage;IndexedDB 的角色卡/道具不在内</div></div>';
  }
  function dtNotes(){
    return '<div class="devx-card"><div class="devx-h">📝 Bug 速记 / 测试报告</div><div style="display:flex;gap:6px;"><input data-note class="dev-in" style="flex:1;" placeholder="记一条 bug/观察(自动附环境)…"><button class="dev-btn" data-note-add>+ 记</button></div><div data-note-list style="margin-top:6px;font-size:11px;max-height:160px;overflow:auto;"></div><div style="display:flex;gap:6px;margin-top:6px;"><button class="dev-btn" data-report-md>📋 复制报告(MD)</button><button class="dev-btn" data-report-dl>⬇ 下载报告</button></div></div>';
  }
  function dtHud(){
    return '<div class="devx-card"><div class="devx-h">📊 实时 HUD 浮层</div><div style="display:flex;gap:6px;"><button class="dev-btn" data-hud-on>显示 HUD</button><button class="dev-btn" data-hud-off>隐藏 HUD</button></div><div class="devx-tip">浮层可拖动 · 显示模型/NSFW/同步/上次请求耗时速度/故障状态</div></div>';
  }
  function devToolsSectionHtml(){
    const style='<style>.devx-card{background:#1a1a1a;border-radius:6px;padding:10px;margin-bottom:12px;}.devx-h{font-weight:600;margin-bottom:6px;font-size:13px;}.devx-tip{color:#777;font-size:11px;margin-top:4px;}.dev-in{background:#0f0f0f;color:#ddd;border:1px solid #333;border-radius:5px;padding:4px 6px;font-size:12px;}</style>';
    return '<div style="border-top:1px solid #333;margin:6px 0 12px;padding-top:10px;font-weight:700;font-size:14px;">🧪 测试增强工具 (4.23)</div>'+dtParam()+dtPrompt()+dtSnap()+dtNotes()+dtPlay()+dtHud()+style;
  }
  function dtPlay(){
    return '<div class="devx-card"><div class="devx-h">🎲 玩法 / 容错测试</div><div style="display:flex;gap:6px;flex-wrap:wrap;"><button class="dev-btn" data-scene-3>🎭 造场景(3人)</button><button class="dev-btn" data-scene-relay>🔁 3人接龙</button><button class="dev-btn" data-scene-discuss>🎙️ 3人讨论</button><button class="dev-btn" data-chaos>🎰 混沌随机</button><button class="dev-btn" data-replay>♻️ 重放上条</button></div><div style="display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap;"><span style="color:#888;">🐛 故障注入</span><select data-fault class="dev-in"><option value="">关</option><option value="error"'+(fault==="error"?" selected":"")+'>网络中断</option><option value="http500"'+(fault==="http500"?" selected":"")+'>HTTP 500</option><option value="slow"'+(fault==="slow"?" selected":"")+'>慢响应</option></select><input data-fault-ms class="dev-in" type="number" style="width:74px;" value="'+faultMs+'"><span style="color:#777;">ms</span></div>'+(fault?'<div style="color:#f66;font-size:11px;margin-top:4px;">⚠ 故障注入生效中,测完记得关</div>':'')+'</div>';
  }
  function renderDevDynamic(p){
    const sl=p.querySelector("[data-snap-list]");
    if(sl)sl.innerHTML=snapshots.length?snapshots.map(function(s,i){return '<div style="display:flex;justify-content:space-between;gap:6px;padding:2px 0;"><span>'+esc(s.name)+' · '+new Date(s.at).toLocaleTimeString()+'</span><span><button class="dev-btn" data-snap-restore="'+i+'">回滚</button> <button class="dev-btn" data-snap-dli="'+i+'">⬇</button></span></div>';}).join(""):'<span style="color:#666;">暂无内存存档</span>';
    const nl=p.querySelector("[data-note-list]");const notes=notesLoad();
    if(nl)nl.innerHTML=notes.length?notes.map(function(n,i){return '<div style="display:flex;justify-content:space-between;gap:6px;padding:2px 0;border-bottom:1px solid #222;"><span>['+new Date(n.at).toLocaleTimeString()+'] '+esc(n.text)+'</span><button class="dev-btn" data-note-del="'+i+'">✕</button></div>';}).join(""):'<span style="color:#666;">还没记录</span>';
  }
  function wireDevTools(p){wireParamTools(p);wirePromptTools(p);wireSnapTools(p);wireNoteTools(p);wirePlayTools(p);wireHudTools(p);}
  function wireParamTools(p){
    p.querySelector("[data-q-model]")?.addEventListener("change",function(e){setModel(e.target.value);toast("模型→"+e.target.value,1000);});
    p.querySelector("[data-q-nsfw]")?.addEventListener("change",function(e){setNsfw(e.target.value);});
    p.querySelector("[data-q-style]")?.addEventListener("change",function(e){setReplyStyle(e.target.value);});
    p.querySelector("[data-q-think]")?.addEventListener("click",function(){clickThink();});
    p.querySelector("[data-q-strict]")?.addEventListener("change",function(e){setStrict(e.target.checked);});
    p.querySelector("[data-q-temp]")?.addEventListener("change",function(e){const v=parseFloat(e.target.value);if(isNaN(v))delete ovr.temp;else ovr.temp=v;saveOvr();});
    p.querySelector("[data-q-max]")?.addEventListener("change",function(e){const v=parseInt(e.target.value,10);if(isNaN(v))delete ovr.maxTokens;else ovr.maxTokens=v;saveOvr();});
  }
  function wirePromptTools(p){
    p.querySelector("[data-x-payload]")?.addEventListener("click",function(){if(!lastPayload){alert("还没捕获 payload");return;}const b=lastPayload.payload||{};const msgs=Array.isArray(b.messages)?b.messages:[];const lastU=(msgs.filter(function(m){return m.role==="user";}).pop()||{}).content||"";const lines=["模型: "+(b.model||"—"),"消息数: "+msgs.length,"角色卡: "+((b.characterCard&&b.characterCard.name)||b.characterCard||"—"),"关系: "+(b.relation||"—")+" 情绪: "+(b.emotion||"—"),"temperature: "+(b.temperature==null?"(默认)":b.temperature),"max_tokens: "+(b.max_tokens==null?"(默认)":b.max_tokens),"","最后一条 user: "+String(lastU).slice(0,300)];alert("🔬 payload 解析\n\n"+lines.join("\n"));});
    p.querySelector("[data-inject-save]")?.addEventListener("click",function(){const v=p.querySelector("[data-inject]").value;setInject(v);toast(v.trim()?"💉 注入已启用(走预设通道)":"已清空注入",1400);});
    p.querySelector("[data-inject-clear]")?.addEventListener("click",function(){setInject("");p.querySelector("[data-inject]").value="";toast("已清除注入",1000);});
  }
  function wireSnapTools(p){
    p.querySelector("[data-snap-take]")?.addEventListener("click",function(){const n=prompt("存档名:","存档 "+(snapshots.length+1));if(n===null)return;snapTake(n);renderDevDynamic(p);toast("📸 已存档(内存)",1000);});
    p.querySelector("[data-snap-dl]")?.addEventListener("click",function(){snapDownload(-1);});
    p.querySelector("[data-snap-up]")?.addEventListener("change",function(e){const f=e.target.files&&e.target.files[0];if(f)snapUpload(f);});
    const sl=p.querySelector("[data-snap-list]");
    if(sl)sl.addEventListener("click",function(e){const b=e.target.closest("button");if(!b)return;if(b.dataset.snapRestore!=null)snapRestore(parseInt(b.dataset.snapRestore,10));else if(b.dataset.snapDli!=null)snapDownload(parseInt(b.dataset.snapDli,10));});
  }
  function wireNoteTools(p){
    const add=function(){const inp=p.querySelector("[data-note]");if(!inp)return;noteAdd(inp.value);inp.value="";renderDevDynamic(p);};
    p.querySelector("[data-note-add]")?.addEventListener("click",add);
    p.querySelector("[data-note]")?.addEventListener("keydown",function(e){if(e.key==="Enter")add();});
    p.querySelector("[data-report-md]")?.addEventListener("click",function(){navigator.clipboard.writeText(buildReport());toast("📋 报告已复制(Markdown)",1400);});
    p.querySelector("[data-report-dl]")?.addEventListener("click",function(){const blob=new Blob([buildReport()],{type:"text/markdown"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="test-report-"+Date.now()+".md";a.click();setTimeout(function(){URL.revokeObjectURL(a.href);},2000);});
    const nl=p.querySelector("[data-note-list]");
    if(nl)nl.addEventListener("click",function(e){const b=e.target.closest("button[data-note-del]");if(b){noteDel(parseInt(b.dataset.noteDel,10));renderDevDynamic(p);}});
  }
  function wirePlayTools(p){
    p.querySelector("[data-scene-3]")?.addEventListener("click",function(){buildScene(3,null);});
    p.querySelector("[data-scene-relay]")?.addEventListener("click",function(){buildScene(3,"relay");});
    p.querySelector("[data-scene-discuss]")?.addEventListener("click",function(){buildScene(3,"discuss");});
    p.querySelector("[data-chaos]")?.addEventListener("click",chaos);
    p.querySelector("[data-replay]")?.addEventListener("click",replay);
    p.querySelector("[data-fault]")?.addEventListener("change",function(e){fault=e.target.value||null;renderPanel();toast(fault?"🐛 故障注入:"+fault:"故障注入已关",1400);});
    p.querySelector("[data-fault-ms]")?.addEventListener("change",function(e){const v=parseInt(e.target.value,10);if(!isNaN(v))faultMs=Math.max(100,v);});
  }
  function wireHudTools(p){
    p.querySelector("[data-hud-on]")?.addEventListener("click",showHud);
    p.querySelector("[data-hud-off]")?.addEventListener("click",hideHud);
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
    try{h.push(devToolsSectionHtml());}catch(e){}
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
    try{wireDevTools(p);renderDevDynamic(p);}catch(e){console.warn("[dev] tools wire fail",e);}
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
    try{if(localStorage.getItem(HUD_KEY)==="1"&&isOn())showHud();}catch(e){}
    api.log("dev.js loaded · dev mode =",isOn()?"ON":"OFF");
  });
})();