// public/props.js — 道具卡系统 v1 (Phase 3 阶段 2)
// 6 类骨架机制（写死）+ 用户自定义内容；UI 与 character.js 对称
// API: window.__props.{getActiveProps, getActivePropsForWorker, useProp, removeProp, tickAfterTurn, open, close, types}
(function(){
"use strict";
const DB="tavern_props_v1",ST="cards";
const LSA="tavern_active_props_v1"; // 激活中的道具数组（JSON）

// 6 类骨架机制：机制写死，内容用户填
// 6 类骨架：maxActive 同类型激活上限（达到上限激活新卡会卸下最老的同类）
const TYPES={
  atmosphere:{label:"气氛卡",icon:"🌤️",defaultDuration:3,durMin:1,durMax:10,allowDelta:false,maxActive:1,hint:"调对话气氛/语气，不直接动好感度",placeholder:"示例：气氛轻松愉快，可以多说日常闲聊。"},
  gift:      {label:"示好卡",icon:"🎁",defaultDuration:2,durMin:1,durMax:5, allowDelta:true,deltaMin:-5,deltaMax:5,defaultDelta:3,maxActive:99,hint:"一次性好感增减 + 短时气氛软化",placeholder:"示例：递出礼物，对方感到受宠若惊。"},
  roleplay:  {label:"角色扮演卡",icon:"🎭",defaultDuration:5,durMin:1,durMax:20,allowDelta:false,maxActive:1,hint:"临时切换身份/关系设定",placeholder:"示例：假装互相不认识，重新建立关系。"},
  status:    {label:"状态卡",icon:"💧",defaultDuration:4,durMin:1,durMax:10,allowDelta:false,maxActive:3,hint:"临时附加生理/精神状态",placeholder:"示例：微醺状态，话变多但不失智。"},
  rule:      {label:"规则卡",icon:"📜",defaultDuration:3,durMin:1,durMax:10,allowDelta:false,maxActive:3,hint:"临时增加/修改对话规则",placeholder:"示例：必须诚实回答，不能回避问题。"},
  plot:      {label:"剧情卡",icon:"✨",defaultDuration:-1,durMin:-1,durMax:50,allowDelta:true,allowReset:true,deltaMin:-50,deltaMax:50,defaultDelta:10,maxActive:99,hint:"永久或重置型大事件（duration=-1 永久）",placeholder:"示例：失去对历史的所有记忆，从头开始。"},
};

const esc=(s)=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

// IndexedDB
const db=()=>new Promise((r,j)=>{const q=indexedDB.open(DB,1);q.onupgradeneeded=()=>{const d=q.result;if(!d.objectStoreNames.contains(ST))d.createObjectStore(ST,{keyPath:"id"});};q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
const all=async()=>{const d=await db();return new Promise((r,j)=>{const t=d.transaction(ST,"readonly").objectStore(ST).getAll();t.onsuccess=()=>r(t.result||[]);t.onerror=()=>j(t.error);});};
const put=async(c)=>{const d=await db();return new Promise((r,j)=>{const t=d.transaction(ST,"readwrite");t.objectStore(ST).put(c);t.oncomplete=r;t.onerror=()=>j(t.error);});};
const del=async(id)=>{const d=await db();return new Promise((r,j)=>{const t=d.transaction(ST,"readwrite");t.objectStore(ST).delete(id);t.oncomplete=r;t.onerror=()=>j(t.error);});};
const getOne=async(id)=>{const d=await db();return new Promise((r,j)=>{const t=d.transaction(ST,"readonly").objectStore(ST).get(id);t.onsuccess=()=>r(t.result||null);t.onerror=()=>j(t.error);});};

// 激活态（localStorage）
function getActive(){try{const r=JSON.parse(localStorage.getItem(LSA)||"[]");return Array.isArray(r)?r:[];}catch{return[];}}
function setActive(arr){localStorage.setItem(LSA,JSON.stringify(arr||[]));}
const notif=()=>window.dispatchEvent(new CustomEvent("props:changed"));

// 使用道具：push 到激活列表（同卡覆盖=刷新 duration）+ 互斥组/同类上限处理 + 即时应用好感度
async function useProp(cardId){
  const c=await getOne(cardId);if(!c)return;
  const t=TYPES[c.type];if(!t)return;
  let arr=getActive().filter(p=>p.cardId!==cardId);
  // 阶段 4-① 互斥组：卸下同 exclusiveGroup 的其他卡（跨类型也生效）
  if(c.exclusiveGroup){
    const allCards=await all();
    const mateIds=new Set(allCards.filter(x=>x.exclusiveGroup===c.exclusiveGroup&&x.id!==cardId).map(x=>x.id));
    if(mateIds.size)arr=arr.filter(p=>!mateIds.has(p.cardId));
  }
  // 阶段 4-① 同类型上限：超过 maxActive 时按 FIFO 卸下最老的同类
  const cap=(typeof t.maxActive==="number"?t.maxActive:99);
  while(arr.filter(p=>p.type===c.type).length>=cap){
    const idx=arr.findIndex(p=>p.type===c.type);
    if(idx<0)break;
    arr.splice(idx,1);
  }
  const durRaw=(typeof c.duration==="number"?c.duration:t.defaultDuration);
  arr.push({cardId,type:c.type,name:c.name,icon:c.icon||t.icon,systemInstruction:c.systemInstruction||"",durationLeft:durRaw});
  setActive(arr);
  if(window.__character){
    if(typeof c.affectionReset==="number"&&window.__character.setActiveAffection){await window.__character.setActiveAffection(c.affectionReset);}
    if(typeof c.affectionDelta==="number"&&c.affectionDelta!==0&&window.__character.adjustActiveAffection){await window.__character.adjustActiveAffection(c.affectionDelta);}
  }
  notif();
}

// 手动卸下
function removeProp(cardId){setActive(getActive().filter(p=>p.cardId!==cardId));notif();}

// 一轮结束钩子：永久卡(-1)不动；其他 -1，归 0 移除
function tickAfterTurn(){
  const arr=getActive();if(!arr.length)return;
  const next=arr.map(p=>p.durationLeft===-1?p:{...p,durationLeft:(typeof p.durationLeft==="number"?p.durationLeft:0)-1}).filter(p=>p.durationLeft===-1||p.durationLeft>0);
  setActive(next);notif();
}

// 暴露给 app.js → worker：只传 worker 关心的字段（name/systemInstruction）+ durationLeft 留作 UI 调试
function getActiveForWorker(){return getActive().filter(p=>p&&p.name&&p.systemInstruction).map(p=>({name:p.name,systemInstruction:p.systemInstruction,durationLeft:p.durationLeft}));}

// ==== UI ====
let mask=null,P=null,tab="mine",editTarget=null;
function ensure(){if(mask)return;mask=document.createElement("div");mask.className="char-panel-mask";P=document.createElement("div");P.className="char-panel";mask.appendChild(P);document.body.appendChild(mask);let downOnMask=false;mask.addEventListener("mousedown",(e)=>{downOnMask=(e.target===mask);});mask.addEventListener("click",(e)=>{const ok=downOnMask&&e.target===mask;downOnMask=false;if(ok)close();});}
const open=()=>{ensure();mask.style.display="flex";render();};
const close=()=>{if(mask)mask.style.display="none";};

function render(){
  const h=[];
  h.push(`<div class="char-panel-header"><h3>🎒 道具卡</h3><button class="iconbtn char-close-btn" data-close>✕</button></div>`);
  h.push(`<div class="char-relation-row" style="margin-bottom:6px;">`);
  for(const[k,l]of[["mine","我的卡库"],["new","新建"]])h.push(`<button class="char-rel-btn ${tab===k?"active":""}" data-tab="${k}">${l}</button>`);
  h.push(`</div>`);
  h.push(activeSec());
  h.push(`<div data-body></div>`);
  P.innerHTML=h.join("");
  const b=P.querySelector("[data-body]");
  if(tab==="mine")libView(b);else editor(b,editTarget);
  P.querySelector("[data-close]")?.addEventListener("click",close);
  P.querySelectorAll("[data-tab]").forEach(x=>x.addEventListener("click",()=>{tab=x.dataset.tab;if(tab!=="new")editTarget=null;render();}));
  P.querySelectorAll("[data-remove]").forEach(x=>x.addEventListener("click",()=>{removeProp(x.dataset.remove);render();}));
  theme();
}

function activeSec(){
  const arr=getActive();
  const h=[`<div class="char-section-title">当前生效</div>`];
  if(!arr.length){h.push(`<div style="font-size:12px;color:#888;padding:4px 0;">没有激活的道具卡</div>`);return h.join("");}
  h.push(`<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px;">`);
  for(const p of arr){
    const t=TYPES[p.type];
    const left=p.durationLeft===-1?"永久":`剩 ${p.durationLeft} 轮`;
    h.push(`<div class="char-prop-active" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;border:1px solid;font-size:13px;"><span style="font-size:16px;">${esc(p.icon||(t?t.icon:""))}</span><span style="flex:1;font-weight:600;">${esc(p.name)}</span><span style="font-size:11px;color:#888;">${esc(left)}</span><button class="char-rel-btn" data-remove="${esc(p.cardId)}" style="font-size:11px;padding:2px 8px;">卸下</button></div>`);
  }
  h.push(`</div>`);
  return h.join("");
}

async function libView(b){
  b.innerHTML=`<div class="char-section-title">我的道具卡</div><div class="char-grid" data-g></div>`;
  const g=b.querySelector("[data-g]");
  const a=await all();
  if(!a.length){g.outerHTML=`<div style="font-size:12px;color:#888;padding:6px 0;">还没有道具卡。去「新建」基于 6 类骨架机制创建。</div>`;return;}
  const actIds=new Set(getActive().map(p=>p.cardId));
  g.innerHTML=a.map(c=>{const t=TYPES[c.type]||TYPES.atmosphere;const eg=c.exclusiveGroup?`<span style="font-size:9px;background:#7d4fcc;color:#fff;padding:1px 5px;border-radius:3px;margin-left:4px;" title="互斥组：${esc(c.exclusiveGroup)}">⊘${esc(c.exclusiveGroup)}</span>`:"";return `<div class="char-item ${actIds.has(c.id)?"active":""}" data-u="${esc(c.id)}"><div class="char-item-avatar">${esc(c.icon||t.icon)}</div><div class="char-item-name">${esc(c.name)}</div><div style="font-size:10px;color:#888;text-align:center;line-height:1.3;">${esc(t.label)}${eg}</div><div class="char-item-actions"><button class="char-item-btn" data-use="${esc(c.id)}">用</button><button class="char-item-btn" data-e="${esc(c.id)}">改</button><button class="char-item-btn" data-d="${esc(c.id)}">删</button></div></div>`;}).join("");
  g.querySelectorAll("[data-use]").forEach(x=>x.addEventListener("click",async(ev)=>{ev.stopPropagation();await useProp(x.dataset.use);render();}));
  g.querySelectorAll("[data-e]").forEach(x=>x.addEventListener("click",async(ev)=>{ev.stopPropagation();const c=await getOne(x.dataset.e);if(c){editTarget=c;tab="new";render();}}));
  g.querySelectorAll("[data-d]").forEach(x=>x.addEventListener("click",async(ev)=>{ev.stopPropagation();if(!confirm("删除这张道具卡？激活中的副本会一并卸下。"))return;await del(x.dataset.d);removeProp(x.dataset.d);render();}));
  theme();
}

function editor(b,card){
  const isN=!card||!card.id;
  const c=card?{...card}:{id:"",type:"atmosphere",name:"",icon:"",description:"",systemInstruction:"",duration:null,affectionDelta:null,affectionReset:null,exclusiveGroup:""};
  let curType=TYPES[c.type]?c.type:"atmosphere";
  const renderEditor=()=>{
    const t=TYPES[curType];
    const dur=(c.duration==null?t.defaultDuration:c.duration);
    const delta=(c.affectionDelta==null?(t.allowDelta?t.defaultDelta:0):c.affectionDelta);
    const reset=(c.affectionReset==null?"":c.affectionReset);
    b.innerHTML=`<div class="char-edit-form">
      <label class="char-label">卡片类型（机制骨架，决定字段约束）</label>
      <select class="char-input" data-f="type">${Object.entries(TYPES).map(([k,v])=>`<option value="${k}" ${k===curType?"selected":""}>${v.icon} ${v.label} — ${v.hint}</option>`).join("")}</select>
      <label class="char-label">卡名</label><input class="char-input" data-f="name" value="${esc(c.name)}" placeholder="自取（如：温柔的吻 / 续命咖啡 / 决裂宣言）">
      <label class="char-label">图标 emoji</label><input class="char-input" data-f="icon" value="${esc(c.icon||t.icon)}" placeholder="${t.icon}" maxlength="4" style="width:80px;">
      <label class="char-label">简述（仅 UI 显示）</label><input class="char-input" data-f="description" value="${esc(c.description||"")}" placeholder="一句话说明这张卡的效果">
      <label class="char-label">注入指令（systemInstruction · 会作为【当前生效的特殊状态】发给 AI）</label>
      <textarea class="char-input" data-f="systemInstruction" rows="3" placeholder="${esc(t.placeholder)}">${esc(c.systemInstruction||"")}</textarea>
      <label class="char-label">互斥组（可空 · 填了相同标识的卡互斥，激活时自动卸下同组其他卡。用于跨类型互斥，如多张「身份扮演」组）</label><input class="char-input" data-f="exclusiveGroup" value="${esc(c.exclusiveGroup||"")}" placeholder="留空 = 不互斥；填任意名字 = 同名互斥" style="width:280px;">
      <label class="char-label">持续轮数${t.durMin===-1?"（剧情卡可填 -1 = 永久；或 1 ~ 50）":`（${t.durMin} ~ ${t.durMax}）`}（同类型上限 ${t.maxActive||99} 张，超出自动卸下最老）</label>
      <input class="char-input" data-f="duration" type="number" value="${dur}" min="${t.durMin}" max="${t.durMax}" style="width:120px;">
      ${t.allowDelta?`<label class="char-label">使用时一次性好感增减（${t.deltaMin} ~ ${t.deltaMax}，0 表示不变）</label><input class="char-input" data-f="affectionDelta" type="number" value="${delta}" min="${t.deltaMin}" max="${t.deltaMax}" style="width:120px;">`:""}
      ${t.allowReset?`<label class="char-label">好感度直接覆盖（可空；填了会无视当前值，强制设为该数 0~100）</label><input class="char-input" data-f="affectionReset" type="number" value="${reset}" min="0" max="100" placeholder="留空 = 不覆盖" style="width:160px;">`:""}
      <div class="char-btn-row"><button class="char-rel-btn active" data-save>${isN?"新建":"保存修改"}</button><button class="char-rel-btn" data-back>返回</button></div>
    </div>`;
    b.querySelector('[data-f="type"]').addEventListener("change",(e)=>{
      const nf={name:b.querySelector('[data-f="name"]').value,description:b.querySelector('[data-f="description"]').value,systemInstruction:b.querySelector('[data-f="systemInstruction"]').value};
      curType=e.target.value;
      c.name=nf.name;c.description=nf.description;c.systemInstruction=nf.systemInstruction;
      c.duration=null;c.affectionDelta=null;c.affectionReset=null;
      renderEditor();
    });
    b.querySelector("[data-save]").addEventListener("click",async()=>{
      const t=TYPES[curType];
      const g=(f)=>{const el=b.querySelector(`[data-f="${f}"]`);return el?el.value:"";};
      const name=g("name").trim();if(!name){alert("卡名不能为空");return;}
      const si=g("systemInstruction").trim();if(!si){alert("注入指令不能为空");return;}
      const dur=parseInt(g("duration"),10);
      const durOk=(curType==="plot"&&dur===-1)||(dur>=t.durMin&&dur<=t.durMax);
      if(!durOk){alert(`持续轮数应在 ${t.durMin} ~ ${t.durMax} 之间${curType==="plot"?"（或 -1 表示永久）":""}`);return;}
      const eg=g("exclusiveGroup").trim();
      const s={id:c.id||("p_"+Date.now().toString(36)),type:curType,name,icon:g("icon").trim()||t.icon,description:g("description").trim(),systemInstruction:si,duration:dur,exclusiveGroup:eg};
      if(t.allowDelta){const v=parseInt(g("affectionDelta"),10);if(!isNaN(v))s.affectionDelta=Math.max(t.deltaMin,Math.min(t.deltaMax,v));}
      if(t.allowReset){const raw=g("affectionReset").trim();if(raw!==""){const v=parseInt(raw,10);if(!isNaN(v))s.affectionReset=Math.max(0,Math.min(100,v));}}
      await put(s);editTarget=null;tab="mine";render();
    });
    b.querySelector("[data-back]").addEventListener("click",()=>{editTarget=null;tab="mine";render();});
    theme();
  };
  renderEditor();
}

function theme(){
  if(!P)return;
  const L=localStorage.getItem("my-theme")==="light";
  P.style.background=L?"#f5f5f5":"#0f0f0f";
  P.style.borderColor=L?"#ddd":"#2a2a2a";
  P.style.color=L?"#111":"#eaeaea";
  P.querySelectorAll(".char-item").forEach(e=>{e.style.background=L?"#fff":"#111";e.style.borderColor=L?"#e0e0e0":"#2a2a2a";e.style.color=L?"#111":"#eaeaea";});
  P.querySelectorAll(".char-item.active").forEach(e=>{e.style.background=L?"#f0f0f0":"#1a1a1a";e.style.borderColor=L?"#aaa":"#555";});
  P.querySelectorAll(".char-rel-btn").forEach(e=>{e.style.background=L?"#e8e8e8":"#141414";e.style.color=L?"#555":"#888";e.style.borderColor=L?"#ccc":"#2a2a2a";});
  P.querySelectorAll(".char-rel-btn.active").forEach(e=>{e.style.background=L?"#ddd":"#222";e.style.color=L?"#111":"#fff";});
  P.querySelectorAll(".char-input").forEach(e=>{e.style.background=L?"#fff":"#0f0f0f";e.style.color=L?"#111":"#fff";e.style.borderColor=L?"#ccc":"#2f2f2f";});
  P.querySelectorAll(".char-section-title").forEach(e=>{e.style.color=L?"#666":"#9a9a9a";});
  P.querySelectorAll(".char-prop-active").forEach(e=>{e.style.background=L?"#fff":"#111";e.style.borderColor=L?"#e0e0e0":"#2a2a2a";e.style.color=L?"#111":"#eaeaea";});
}

window.__props={getActiveProps:getActive,getActivePropsForWorker:getActiveForWorker,useProp,removeProp,tickAfterTurn,open,close,types:TYPES};
document.addEventListener("DOMContentLoaded",()=>{const b=document.getElementById("propsBtn");if(b)b.addEventListener("click",open);});
})();