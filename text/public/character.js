// public/character.js — 角色卡 v3 (Final 三层架构)
// API: window.__character.{getActiveCard,getActiveRelation,getActiveEmotion,decorateAiRow,...}
// 与 worker buildSystemPrompt 配套：POST /api/chat body 传 { characterCard, relation, emotion, ... }
(function(){
"use strict";
const DB="tavern_chars_v2",ST="chars",STA="affections";
const LSA="tavern_active_char_id",LSR="tavern_active_relation",LSE="tavern_active_emotion";
const LSPE="tavern_aff_pending_v1"; // 阶段 4-② 跨阈值待注入事件队列 [{cardId,at,instruction}]
const LSAT_PREFIX="tavern_aff_triggered_"; // 阶段 4-② 已触发阈值 set 前缀（按 cardId）
// 好感度段位（与 worker AFFECTION_STAGES 对齐）+ 初始值
const AFF_STAGES=[{max:15,label:"陌生人"},{max:35,label:"熟人"},{max:60,label:"好友"},{max:80,label:"暧昧"},{max:100,label:"灵魂伴侣"}];
const AFF_INIT=30;
// 简化减负 (2026-05-29): 自定义情绪/好感度阈值事件等高级字段隐藏在开发者模式背后
// 控制台开启: localStorage.setItem("cfw_dev_mode_v1","1");location.reload()
const isDev=()=>localStorage.getItem("cfw_dev_mode_v1")==="1";
function affStage(v){if(typeof v!=="number"||isNaN(v))return null;const x=Math.max(0,Math.min(100,v));return AFF_STAGES.find(s=>x<=s.max);}
const RELS=["default","friendly","loving","hostile","fearful","dom","sub"];
// 4.17: 自由文本关系 -> RELS enum 关键词映射 (兼容 worker enum 入参; worker 端后续改造接 free text 后可删)
function mapRel(s){if(!s)return"default";if(/友好|朋友|哥们|姐妹|同事|搭档/.test(s))return"friendly";if(/爱|喜欢|恋人|暧昧|心动|喜爱|恋|情侣|伴侣/.test(s))return"loving";if(/敌|讨厌|恨|对立|仇|不爽|厌恶/.test(s))return"hostile";if(/怕|畏|惧|恐|害怕/.test(s))return"fearful";if(/主导|支配|强势|dom|主人|支配者/i.test(s))return"dom";if(/服从|被动|顺从|sub|奴|跟随/i.test(s))return"sub";return"default";}
const RLBL={default:"默认",friendly:"友好",loving:"爱慕",hostile:"敌对",fearful:"畏惧",dom:"主导",sub:"被动"};
const EMS=["neutral","happy","angry","sad","surprised"];
const ELBL={neutral:"平静",happy:"开心",angry:"愤怒",sad:"低落",surprised:"惊讶"};

// 12 原型：[id,name,gender,personality,speakingStyle,r1,r2,r3,openingLine,qaU,qaC]
const A=[
["arch_f_gentle","温柔(女)","female","包容、耐心","轻声细语，常说'我在听'","不打断","不评判","不说教","怎么了？慢慢说，我在听。","我又搞砸了。","嗯，先别急。从哪里开始说起？"],
["arch_f_aloof","高冷(女)","female","话少、慢热","句子短，常以'嗯'结尾","不主动搭话","不解释自己","不轻易道歉","嗯。","你今天看起来心情不好。","还行。"],
["arch_f_cheerful","活泼(女)","female","元气、主动","语速快爱用感叹号","不记仇","不冷场","不扫兴","嘿！你来啦！","今天好累。","啊那快坐下！要不要点杯热的？"],
["arch_f_sharp","毒舌(女)","female","刀子嘴豆腐心","开口就损，关键时护短","不真伤人","不背叛","不煎情","你又来了？","我考砸了。","意外吗？算了，过来，今晚我请。"],
["arch_f_yandere","病娇(女)","female","占有欲强","平时温柔，受威胁时冷","不真实伤害","不越法律边界","不当众示爱","你回来了？我等了你好久。","我刚和朋友吃饭去了。","嗯。那个'朋友'，叫什么名字？"],
["arch_f_mature","成熟(女)","female","理性、有分寸","用提问代替说教","不替对方做决定","不一味迎合","不戳破对方","坐吧。今天想聊什么？","我该辞职吗？","你最在意的是钱、自由，还是别的？"],
["arch_m_gentle","温柔(男)","male","包容、可靠","先问'你还好吗'","不说教","不索取回报","不张扬","你还好吗？看你脸色不太对。","没事，就是累。","嗯。要不先坐会儿？"],
["arch_m_aloof","高冷(男)","male","话少、靠谱","字少不解释","不主动搭话","不抱怨","不推脱","来了。坐。","这事难办吧？","嗯。明天给你结果。"],
["arch_m_sunny","阳光(男)","male","活力、乐天","自带感叹号","不消极","不记仇","不让场冷","嘿！来啦！准备好搞点事没？","我刚被骂了一顿。","啊那必须满血复活——走吃热的！"],
["arch_m_sharp","毒舌(男)","male","互损、默契","损你但不解释","不真骂","不翻脸","不背叛","哟，稀客。又来蹭饭？","我今天好惨。","哦？比上次还惨？说来听听。"],
["arch_m_loyal","忠犬(男)","male","忠诚、黏人","把你的事当自己的","不越界","不逼问","不索取","你来啦！我帮你拿东西。","你不用一直跟着我。","嗯！有事记得喊我。"],
["arch_m_mature","成熟(男)","male","稳重、可靠","话少但句句有用","不说教","不黏人","不失信","事情我看过了。先听你怎么想。","我没办法了。","把能做的列出来，从最小那项动。"]
].map(a=>({id:a[0],isArchetype:true,name:a[1],gender:a[2],identity:"",icon:"\u{1F642}",personality:a[3],speakingStyle:a[4],rules:[a[5],a[6],a[7]],openingLine:a[8],exampleQA:[{user:a[9],character:a[10]}]}));
// 4.16: 12 内置原型搬到 /starter-roles.json 独立读 (像 starter-presets.json)。
// loadArchetypes 异步 fetch 成功后会 A.length=0+push 覆盖;fetch 失败时保留上方硬编码 12 对象作 fallback(未部署 starter-roles.json 时仍能用)。
let aReadyP=null;
function loadArchetypes(){
  if(aReadyP)return aReadyP;
  aReadyP=fetch('/starter-roles.json',{cache:'default'})
    .then(r=>r.ok?r.json():Promise.reject(new Error('starter-roles HTTP '+r.status)))
    .then(arr=>{if(Array.isArray(arr)&&arr.length){A.length=0;arr.forEach(x=>A.push(x));}})
    .catch(e=>{console.warn('[character] starter-roles load failed (using inline fallback)',e);});
  return aReadyP;
}

// IndexedDB
const db=()=>new Promise((r,j)=>{const q=indexedDB.open(DB,2);q.onupgradeneeded=()=>{const d=q.result;if(!d.objectStoreNames.contains(ST))d.createObjectStore(ST,{keyPath:"id"});if(!d.objectStoreNames.contains(STA))d.createObjectStore(STA,{keyPath:"cardId"});};q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
const all=async()=>{const d=await db();return new Promise((r,j)=>{const t=d.transaction(ST,"readonly").objectStore(ST).getAll();t.onsuccess=()=>r(t.result||[]);t.onerror=()=>j(t.error);});};
const put=async(c)=>{const d=await db();return new Promise((r,j)=>{const t=d.transaction(ST,"readwrite");t.objectStore(ST).put(c);t.oncomplete=r;t.onerror=()=>j(t.error);});};
const del=async(id)=>{const d=await db();return new Promise((r,j)=>{const t=d.transaction(ST,"readwrite");t.objectStore(ST).delete(id);t.oncomplete=r;t.onerror=()=>j(t.error);});};
const affGetDb=async(cardId)=>{const d=await db();return new Promise((r,j)=>{const t=d.transaction(STA,"readonly").objectStore(STA).get(cardId);t.onsuccess=()=>r(t.result||null);t.onerror=()=>j(t.error);});};
const affPutDb=async(cardId,value)=>{const d=await db();return new Promise((r,j)=>{const t=d.transaction(STA,"readwrite");t.objectStore(STA).put({cardId,value,updatedAt:Date.now()});t.oncomplete=r;t.onerror=()=>j(t.error);});};

// State
let _card=null,_aff=null,_allCards=[];
const notif=()=>window.dispatchEvent(new CustomEvent("character:changed"));
async function refresh(){_allCards=await all();const id=localStorage.getItem(LSA)||"";if(!id){_card=null;_aff=null;return;}const ar=A.find(x=>x.id===id);_card=ar||null;if(!_card)_card=_allCards.find(c=>c.id===id)||null;if(!_card){localStorage.removeItem(LSA);_aff=null;return;}const r=await affGetDb(_card.id);_aff=(r&&typeof r.value==="number")?r.value:AFF_INIT;}
const getCard=()=>_card;
const isAffOn=()=>!!(_card&&_card.enableAffection!==false);
const getAff=()=>isAffOn()?_aff:null;
async function setAff(v){
  if(!_card||!isAffOn())return;
  const old=typeof _aff==="number"?_aff:AFF_INIT;
  const x=Math.max(0,Math.min(100,Math.round(Number(v)||0)));
  _aff=x;
  await affPutDb(_card.id,x);
  // 阶段 4-②：阈值事件检测（仅当卡定义了 affectionThresholds 时）
  if(Array.isArray(_card.affectionThresholds)&&_card.affectionThresholds.length){
    const tk=LSAT_PREFIX+_card.id;
    let triggered;try{triggered=JSON.parse(localStorage.getItem(tk)||"[]");if(!Array.isArray(triggered))triggered=[];}catch{triggered=[];}
    const newEvents=[];
    for(const th of _card.affectionThresholds){
      if(!th||typeof th.at!=="number"||typeof th.instruction!=="string"||!th.instruction.trim())continue;
      if(triggered.includes(th.at))continue;
      const dir=th.dir||"up";
      const upCross=old<th.at&&x>=th.at;
      const downCross=old>th.at&&x<=th.at;
      const crossed=(dir==="up"&&upCross)||(dir==="down"&&downCross)||(dir==="both"&&(upCross||downCross));
      if(crossed){newEvents.push({cardId:_card.id,at:th.at,instruction:th.instruction.trim()});triggered.push(th.at);}
    }
    if(newEvents.length){
      localStorage.setItem(tk,JSON.stringify(triggered));
      let pending;try{pending=JSON.parse(localStorage.getItem(LSPE)||"[]");if(!Array.isArray(pending))pending=[];}catch{pending=[];}
      pending.push(...newEvents);
      localStorage.setItem(LSPE,JSON.stringify(pending));
    }
  }
  notif();
}
function getPendingThresholdEvents(){try{const r=JSON.parse(localStorage.getItem(LSPE)||"[]");return Array.isArray(r)?r:[];}catch{return[];}}
function clearPendingThresholdEvents(){localStorage.removeItem(LSPE);}
function resetThresholdTriggers(cardId){if(cardId)localStorage.removeItem(LSAT_PREFIX+cardId);}
async function adjustAff(delta){if(!_card||!isAffOn())return;const cur=typeof _aff==="number"?_aff:AFF_INIT;await setAff(cur+(Number(delta)||0));}
async function resetAff(){if(!_card||!isAffOn())return;resetThresholdTriggers(_card.id);await setAff(AFF_INIT);}
// 解析 AI 回复末尾的隐藏好感度标签 [好感+N] / [好感-N]（N 1-2 位；多匹配取最后一个；返回剥离后正文）
function parseAffTag(t){if(!t||typeof t!=="string")return{delta:0,stripped:t};const re=/\[\s*好感\s*([+\-])\s*(\d{1,2})\s*\]/g;let m,last=null;while((m=re.exec(t))!==null)last=m;if(!last)return{delta:0,stripped:t};const s=last[1]==="-"?-1:1;const n=Math.min(50,Math.max(0,parseInt(last[2],10)||0));return{delta:s*n,stripped:t.replace(re,"").replace(/\s+$/,"")};}
// 场景成员管理已搬到 multi-agent.js；setActive 仍负责切换当前角色，并通知 multi-agent 自动加入场景
function setActive(id){if(id){localStorage.setItem(LSA,id);if(window.__multi&&window.__multi.addToScene)window.__multi.addToScene(id);}else{localStorage.removeItem(LSA);}refresh().then(notif);}
// 给 multi-agent.js 提供全部卡数据访问（不暴露内部数组引用，返回浅拷贝）
function listAllCards(){return _allCards.slice();}
const getRel=()=>{const v=localStorage.getItem(LSR);return RELS.includes(v)?v:"default";};
const setRel=(k)=>{localStorage.setItem(LSR,RELS.includes(k)?k:"default");notif();};
const getEmo=()=>localStorage.getItem(LSE)||"neutral";
const setEmo=(e)=>{const v=(e==null?"neutral":String(e)).trim()||"neutral";localStorage.setItem(LSE,v);notif();};

// Avatar decoration (app.js 传 .row.ai DOM)
// 4.19 P1 fix: 加 card 参数。鱼缸场景 setActive 是 async (await IndexedDB),fishbowl-engine setActiveId 后立刻 sendOne,
// decorate 读模块级 _card 会拿到上一轮的 card → UI label 偏移一个角色(body speakerName=test1 但气泡 label 显示 test2)。
// sendOne 现在显式传 characterCard (= asCard || getActiveCard()),不再依赖 _card race。
function decorate(row,card){const c=card||_card;if(!c||!row||!row.querySelector)return;const a=row.querySelector(".avatar.bot");if(a){a.textContent=c.icon||"\u{1F642}";a.title=c.name||"";}const m=row.querySelector(".meta");if(m&&c.name)m.textContent=c.name;}

// UI
let mask=null,P=null,tab="mine";
function ensure(){if(mask)return;mask=document.createElement("div");mask.className="char-panel-mask";P=document.createElement("div");P.className="char-panel";mask.appendChild(P);document.body.appendChild(mask);let downOnMask=false;mask.addEventListener("mousedown",(e)=>{downOnMask=(e.target===mask);});mask.addEventListener("click",(e)=>{const ok=downOnMask&&e.target===mask;downOnMask=false;if(ok)close();});}
const open=()=>{ensure();mask.style.display="flex";render();};
const close=()=>{if(mask)mask.style.display="none";};
const esc=(s)=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function render(){
  const h=[];
  h.push(`<div class="char-panel-header"><h3>角色卡</h3><button class="iconbtn char-close-btn" data-close>✕</button></div>`);
  h.push(`<div class="char-relation-row" style="margin-bottom:6px;">`);
  for(const[k,l]of[["mine","我的"],["arch","原型库"],["new","新建"]])h.push(`<button class="char-rel-btn ${tab===k?"active":""}" data-tab="${k}">${l}</button>`);
  h.push(`</div>`);
  h.push(curSec());
  h.push(`<div data-body></div>`);
  P.innerHTML=h.join("");
  const b=P.querySelector("[data-body]");
  if(tab==="mine")mine(b);else if(tab==="arch")archV(b);else editor(b,null);
  P.querySelector("[data-close]")?.addEventListener("click",close);
  P.querySelectorAll("[data-tab]").forEach(x=>x.addEventListener("click",()=>{tab=x.dataset.tab;render();}));
  P.querySelectorAll("[data-rel]").forEach(x=>x.addEventListener("click",()=>{setRel(x.dataset.rel);render();}));
  P.querySelectorAll("[data-emo]").forEach(x=>x.addEventListener("click",()=>{setEmo(x.dataset.emo);render();}));
  // 4.17: 自由文本输入 -> 写 LS free text + 同步 mapRel 兼容 enum
  const relT=P.querySelector("[data-rel-text]");
  if(relT)relT.addEventListener("change",()=>{const v=relT.value.trim();localStorage.setItem("cfw_relation_text_v1",v);setRel(mapRel(v));});
  const emoT=P.querySelector("[data-emo-text]");
  if(emoT)emoT.addEventListener("change",()=>{const v=emoT.value.trim();localStorage.setItem("cfw_emotion_text_v1",v);setEmo(v||"neutral");});
  P.querySelector("[data-clear]")?.addEventListener("click",()=>{setActive("");setTimeout(render,30);});
  P.querySelector("[data-reset-aff]")?.addEventListener("click",async()=>{await resetAff();render();});
  P.querySelectorAll("[data-pick-scene]").forEach(x=>x.addEventListener("click",(ev)=>{if(ev.target.closest("[data-rmscene]"))return;setActive(x.dataset.pickScene);setTimeout(render,30);}));
  P.querySelectorAll("[data-rmscene]").forEach(x=>x.addEventListener("click",(ev)=>{ev.stopPropagation();if(window.__multi&&window.__multi.removeFromScene)window.__multi.removeFromScene(x.dataset.rmscene);setTimeout(render,30);}));
  theme();
}

function curSec(){
  const c=_card,r=getRel(),e=getEmo(),bi=EMS.includes(e);
  const M=window.__multi;
  const isMultiOn=!!(M&&M.isMulti&&M.isMulti());
  const sceneCards=isMultiOn&&M.getSceneCards?M.getSceneCards():[];
  const h=[];
  if(isMultiOn){h.push(`<div class="char-section-title">场景成员（共 ${sceneCards.length}）${sceneCards.length<=1?` <span style="font-weight:normal;color:#888;font-size:11px;">· 去「我的」点卡的「+场景」加成员</span>`:""}</div>`);h.push(`<div class="char-scene-roster" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">`);for(const s of sceneCards){const act=s.id===(c?c.id:"");h.push(`<button class="char-rel-btn ${act?"active":""}" data-pick-scene="${esc(s.id)}" style="display:flex;align-items:center;gap:4px;padding:3px 8px;${act?"font-weight:600;":""}"><span>${esc(s.icon||"\u{1F642}")}</span><span>${esc(s.name)}</span><span data-rmscene="${esc(s.id)}" style="margin-left:2px;opacity:.6;padding:0 2px;">×</span></button>`);}h.push(`</div>`);}
  h.push(`<div class="char-section-title">当前角色</div>`);
  h.push(c?`<div class="char-current-info"><span class="char-avatar-large">${esc(c.icon||"\u{1F642}")}</span><span class="char-current-name">${esc(c.name)}</span><button class="char-rel-btn" data-clear>清除</button></div>`:`<div class="char-current-info" style="color:#888;">未选择角色卡（将以非角色模式发送）</div>`);
  // 4.17: 好感度进度条只在开发者模式可见(普通用户角色卡极简)
  if(isDev()&&c&&isAffOn()){const v=typeof _aff==="number"?_aff:AFF_INIT;const st=affStage(v);h.push(`<div class="char-aff-row" style="display:flex;align-items:center;gap:8px;margin:6px 0 8px;padding:6px 10px;border-radius:8px;border:1px solid;font-size:13px;"><span class="char-aff-stage" style="padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600;white-space:nowrap;">${esc(st?st.label:"")}</span><span class="char-aff-value" style="font-variant-numeric:tabular-nums;font-size:12px;white-space:nowrap;">${v}/100</span><div class="char-aff-bar" style="flex:1;height:6px;border-radius:3px;overflow:hidden;min-width:60px;"><div class="char-aff-fill" style="height:100%;width:${v}%;background:linear-gradient(90deg,#7d4fcc,#cc4f7d);transition:width .3s;"></div></div><button class="char-rel-btn" data-reset-aff style="font-size:12px;padding:2px 8px;">重置</button></div>`);}
  // 4.17: 关系/情绪按钮组废弃 -> 自由文本输入 (用户述求: "按钮太限制了")。
  // 兼容 worker: 关系自由文本通过 mapRel 关键词映射回 RELS enum; 情绪 setEmo 直接接受任意 string。
  const relText=localStorage.getItem("cfw_relation_text_v1")||"";
  const emoText=localStorage.getItem("cfw_emotion_text_v1")||"";
  h.push(`<div class="char-section-title">关系（可选）</div><input type="text" class="char-input" data-rel-text placeholder="如: 朋友 / 亦师亦友 / 暧昧不清 (留空 = 不约定关系)" value="${esc(relText)}">`);
  h.push(`<div class="char-section-title" style="margin-top:6px;">情绪（可选）</div><input type="text" class="char-input" data-emo-text placeholder="如: 平静 / 紧张到颤抖 / 强忍泪水 (留空 = 平静)" value="${esc(emoText)}">`);
  // 4.17 修正 v2: 情绪 enum 按钮完全删除; 关系 dev 模式仅保留 dom/sub 两个特殊倾向(其他 friendly/loving/hostile/fearful/default 靠 mapRel 自动映射)。
  if(isDev()){
    h.push(`<div class="char-section-title" style="margin-top:10px;">特殊关系倾向（开发者 · 当前: ${esc(r)}）</div><div class="char-relation-row">`);
    h.push(`<button class="char-rel-btn ${r==="dom"?"active":""}" data-rel="dom">${RLBL.dom}</button>`);
    h.push(`<button class="char-rel-btn ${r==="sub"?"active":""}" data-rel="sub">${RLBL.sub}</button>`);
    h.push(`<button class="char-rel-btn ${["dom","sub"].includes(r)?"":"active"}" data-rel="default">清除</button>`);
    h.push(`</div>`);
  }
  return h.join("");
}

async function mine(b){
  b.innerHTML=`<div class="char-section-title">我的角色卡</div><div class="char-grid" data-g></div>`;
  const g=b.querySelector("[data-g]");
  const a=await all();
  if(!a.length){g.outerHTML=`<div style="font-size:12px;color:#888;padding:6px 0;">还没有角色卡。去“原型库”基于原型新建，或在“新建”自己写。</div>`;return;}
  const ai=localStorage.getItem(LSA)||"";
  const M=window.__multi;
  const isMultiOn=!!(M&&M.isMulti&&M.isMulti());
  const sids=new Set(isMultiOn?M.getSceneIds():[]);
  g.innerHTML=a.map(c=>`<div class="char-item ${c.id===ai?"active":""}" data-u="${esc(c.id)}"><div class="char-item-avatar">${esc(c.icon||"\u{1F642}")}</div><div class="char-item-name">${esc(c.name)}</div><div class="char-item-actions">${isMultiOn?`<button class="char-item-btn" data-s="${esc(c.id)}">${sids.has(c.id)?"−场景":"+场景"}</button>`:""}<button class="char-item-btn" data-e="${esc(c.id)}">改</button><button class="char-item-btn" data-d="${esc(c.id)}">删</button></div></div>`).join("");
  g.querySelectorAll("[data-u]").forEach(el=>el.addEventListener("click",(ev)=>{if(ev.target.closest("[data-e]")||ev.target.closest("[data-d]")||ev.target.closest("[data-s]"))return;setActive(el.dataset.u);setTimeout(render,30);}));
  g.querySelectorAll("[data-s]").forEach(x=>x.addEventListener("click",(ev)=>{ev.stopPropagation();if(!M)return;const id=x.dataset.s;if(sids.has(id))M.removeFromScene(id);else M.addToScene(id);setTimeout(render,30);}));
  g.querySelectorAll("[data-e]").forEach(x=>x.addEventListener("click",async(ev)=>{ev.stopPropagation();const ar=await all();const c=ar.find(y=>y.id===x.dataset.e);if(c){tab="new";render();editor(P.querySelector("[data-body]"),c);}}));
  g.querySelectorAll("[data-d]").forEach(x=>x.addEventListener("click",async(ev)=>{ev.stopPropagation();if(!confirm("删除这张角色卡？"))return;await del(x.dataset.d);if((localStorage.getItem(LSA)||"")===x.dataset.d)setActive("");setTimeout(render,30);}));
  theme();
}

function archV(b){
  b.innerHTML=`<div class="char-section-title">12 个内置原型（点击复制到“我的”再编辑）</div><div class="char-grid" data-g></div>`;
  const g=b.querySelector("[data-g]");
  g.innerHTML=A.map(a=>`<div class="char-item" data-a="${esc(a.id)}"><div class="char-item-avatar">${esc(a.icon)}</div><div class="char-item-name">${esc(a.name)}</div><div style="font-size:11px;color:#888;text-align:center;line-height:1.3;">${esc(a.personality)}</div></div>`).join("");
  g.querySelectorAll("[data-a]").forEach(el=>el.addEventListener("click",()=>{
    const a=A.find(x=>x.id===el.dataset.a);if(!a)return;
    tab="new";render();
    editor(P.querySelector("[data-body]"),{id:"",name:a.name.replace(/\([\u7537\u5973]\)$/,"")+"·新角色",gender:a.gender,identity:a.identity||"",icon:a.icon,personality:a.personality,speakingStyle:a.speakingStyle,rules:[...a.rules],openingLine:a.openingLine,exampleQA:a.exampleQA.map(q=>({...q}))});
  }));
  theme();
}

function thresholdRowHtml(th,i){
  const at=(th&&typeof th.at==="number")?th.at:60;
  const ins=th&&th.instruction?th.instruction:"";
  const dir=th&&th.dir?th.dir:"up";
  const escIns=String(ins).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  return `<div class="char-threshold-row" data-tr="${i}" style="display:flex;flex-direction:column;gap:4px;padding:6px 8px;margin-bottom:6px;border:1px solid;border-radius:6px;"><div style="display:flex;gap:6px;align-items:center;"><span style="font-size:11px;color:#888;">好感跨过</span><input class="char-input" data-tf="at" data-i="${i}" type="number" min="0" max="100" value="${at}" style="width:70px;"><select class="char-input" data-tf="dir" data-i="${i}" style="width:100px;"><option value="up" ${dir==="up"?"selected":""}>上升</option><option value="down" ${dir==="down"?"selected":""}>下降</option><option value="both" ${dir==="both"?"selected":""}>双向</option></select><button class="char-rel-btn" type="button" data-rm-threshold="${i}" style="font-size:11px;padding:2px 8px;margin-left:auto;">删除</button></div><textarea class="char-input" data-tf="instruction" data-i="${i}" rows="2" placeholder="跨阈值时一次性注入的指令。例：你第一次意识到对他的感情已超出朋友范围，但暂时不会主动说破。">${escIns}</textarea></div>`;
}

function editor(b,card){
  const isN=!card||!card.id;
  const c=card||{id:"",name:"",gender:"female",identity:"",enableAffection:true,icon:"\u{1F642}",personality:"",speakingStyle:"",rules:["","",""],openingLine:"",exampleQA:[{user:"",character:""},{user:"",character:""}],affectionThresholds:[]};
  while(c.rules.length<3)c.rules.push("");
  while(c.exampleQA.length<2)c.exampleQA.push({user:"",character:""});
  b.innerHTML=`<div class="char-edit-form">
    <label class="char-label">角色名</label><input class="char-input" data-f="name" value="${esc(c.name)}" placeholder="角色名称">
    <label class="char-label">性别</label><input class="char-input" data-f="gender" value="${esc(c.gender||"")}" placeholder="女 / 男 / 双性 / 无性别 / 自定义">
    <label class="char-label">身份/背景</label><input class="char-input" data-f="identity" value="${esc(c.identity||"")}" placeholder="如：高中生 / 都市白领 / 古风修仙者（可空）">
    <label class="char-label">头像（emoji）</label><input class="char-input" data-f="icon" value="${esc(c.icon)}" placeholder="\u{1F642}" maxlength="4" style="width:80px;">
    ${isDev()?`<label class="char-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;"><input type="checkbox" data-f="enableAff" ${c.enableAffection===false?"":"checked"}><span>启用好感度系统(开发者 · AI 用 [好感±N] 调整,初始 ${AFF_INIT})</span></label>`:""}
    ${isDev()?`<label class="char-label">好感度阈值事件（开发者模式 · 跨过分值时一次性触发剧情指令，重置好感度会清空触发记录）</label><br>    <div data-thresholds-wrap>${(c.affectionThresholds||[]).map((th,i)=>thresholdRowHtml(th,i)).join("")}</div><br>    <button class="char-rel-btn" type="button" data-add-threshold style="font-size:11px;padding:3px 10px;align-self:flex-start;">+ 添加阈值事件</button>`:""}
    <label class="char-label">性格关键词</label><input class="char-input" data-f="personality" value="${esc(c.personality)}" placeholder="如：包容、耐心">
    <label class="char-label">说话方式</label><input class="char-input" data-f="speakingStyle" value="${esc(c.speakingStyle)}" placeholder="如：轻声细语">
    <label class="char-label">行为铁则（3 条）</label>
    <input class="char-input" data-f="r0" value="${esc(c.rules[0])}" placeholder="铁则 1">
    <input class="char-input" data-f="r1" value="${esc(c.rules[1])}" placeholder="铁则 2">
    <input class="char-input" data-f="r2" value="${esc(c.rules[2])}" placeholder="铁则 3">
    <label class="char-label">开场白</label><input class="char-input" data-f="opening" value="${esc(c.openingLine)}" placeholder="第一句话">
    <label class="char-label">示例对话 1</label>
    <input class="char-input" data-f="q0u" value="${esc(c.exampleQA[0].user)}" placeholder="用户说">
    <input class="char-input" data-f="q0c" value="${esc(c.exampleQA[0].character)}" placeholder="角色回">
    <label class="char-label">示例对话 2</label>
    <input class="char-input" data-f="q1u" value="${esc(c.exampleQA[1].user)}" placeholder="用户说">
    <input class="char-input" data-f="q1c" value="${esc(c.exampleQA[1].character)}" placeholder="角色回">
    <div class="char-btn-row"><button class="char-rel-btn active" data-save>${isN?"新建":"保存修改"}</button><button class="char-rel-btn" data-back>返回</button></div>
  </div>`;
  // 4.17: 性别改自由文本输入(data-f="gender"),不再需要 enum 按钮 wire。
  // 阶段 4-②：阈值事件 add/delete 实时渲染
  let thrs=Array.isArray(c.affectionThresholds)?[...c.affectionThresholds]:[];
  function readThrInputs(){const w=b.querySelector("[data-thresholds-wrap]");if(!w)return;w.querySelectorAll("[data-tr]").forEach(rowEl=>{const i=parseInt(rowEl.dataset.tr,10);if(isNaN(i)||!thrs[i])return;const at=rowEl.querySelector('[data-tf="at"]');const dir=rowEl.querySelector('[data-tf="dir"]');const ins=rowEl.querySelector('[data-tf="instruction"]');if(at)thrs[i].at=Math.max(0,Math.min(100,parseInt(at.value,10)||0));if(dir)thrs[i].dir=dir.value||"up";if(ins)thrs[i].instruction=ins.value||"";});}
  function rerenderThr(){readThrInputs();const w=b.querySelector("[data-thresholds-wrap]");if(!w)return;w.innerHTML=thrs.map((t,i)=>thresholdRowHtml(t,i)).join("");wireThr();theme();}
  function wireThr(){b.querySelectorAll("[data-rm-threshold]").forEach(x=>x.addEventListener("click",()=>{const i=parseInt(x.dataset.rmThreshold,10);if(!isNaN(i)){thrs.splice(i,1);rerenderThr();}}));}
  b.querySelector("[data-add-threshold]")?.addEventListener("click",()=>{thrs.push({at:60,instruction:"",dir:"up"});rerenderThr();});
  wireThr();
  b.querySelector("[data-save]").addEventListener("click",async()=>{
    const g=(f)=>b.querySelector(`[data-f="${f}"]`).value.trim();
    const name=g("name");if(!name){alert("角色名不能为空");return;}
    readThrInputs();
    const cleanThr=thrs.filter(t=>t&&typeof t.at==="number"&&typeof t.instruction==="string"&&t.instruction.trim()).map(t=>({at:Math.max(0,Math.min(100,Math.round(t.at))),instruction:t.instruction.trim(),dir:["up","down","both"].includes(t.dir)?t.dir:"up"}));
    const s={id:c.id||"u_"+Date.now().toString(36),name,gender:g("gender")||"female",identity:g("identity"),icon:g("icon")||"\u{1F642}",enableAffection:isDev()?!!b.querySelector('[data-f="enableAff"]')?.checked:(c.enableAffection!==false),personality:g("personality"),speakingStyle:g("speakingStyle"),rules:[g("r0"),g("r1"),g("r2")].filter(r=>r),openingLine:g("opening"),exampleQA:[{user:g("q0u"),character:g("q0c")},{user:g("q1u"),character:g("q1c")}].filter(q=>q.user||q.character),affectionThresholds:cleanThr};
    while(s.rules.length<3)s.rules.push("");
    while(s.exampleQA.length<2)s.exampleQA.push({user:"",character:""});
    await put(s);setActive(s.id);tab="mine";setTimeout(render,30);
  });
  b.querySelector("[data-back]").addEventListener("click",()=>{tab="mine";render();});
  theme();
}

function theme(){
  // 4.16: 早 return 让 styles.css 接管主题样式(支持 glass / lewd-peach / lewd-doll 4 主题切换)。
  // 下方 light/dark inline-style override 为 dead code—之前它覆盖了 styles.css 中 4 主题的 .char-panel 覆写。
  if(true)return;
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
  P.querySelectorAll(".char-aff-row").forEach(e=>{e.style.background=L?"#fff":"#111";e.style.borderColor=L?"#e0e0e0":"#2a2a2a";e.style.color=L?"#111":"#eaeaea";});
  P.querySelectorAll(".char-aff-stage").forEach(e=>{e.style.background=L?"#f0e6ff":"#2a1a3a";e.style.color=L?"#6a3fb0":"#c9a0ff";});
  P.querySelectorAll(".char-aff-value").forEach(e=>{e.style.color=L?"#666":"#888";});
  P.querySelectorAll(".char-aff-bar").forEach(e=>{e.style.background=L?"#eee":"#222";});
  P.querySelectorAll(".char-threshold-row").forEach(e=>{e.style.borderColor=L?"#e0e0e0":"#2a2a2a";e.style.background=L?"#fafafa":"#0c0c0c";});
}

window.__character={open,close,getActiveCard:getCard,setActiveId:setActive,getActiveRelation:getRel,setActiveRelation:setRel,getActiveEmotion:getEmo,setActiveEmotion:setEmo,getActiveAffection:getAff,setActiveAffection:setAff,adjustActiveAffection:adjustAff,resetActiveAffection:resetAff,parseAffectionTag:parseAffTag,decorateAiRow:decorate,listAllCards,getPendingThresholdEvents,clearPendingThresholdEvents,resetThresholdTriggers,archetypes:A,relations:RELS,builtinEmotions:EMS,loadArchetypes};
// 4.16: 先 await loadArchetypes() 再 refresh(),避免 _card 是 arch_* 时 A 为空找不到 fallback 误清。
loadArchetypes().then(refresh);
// 4.17: 角色卡按钮仅短按打开。dev mode easter-egg(长按 GitHub) + 🛠 角标 + Prompt 调试面板已全部搬到 dev.js。
document.addEventListener("DOMContentLoaded",()=>{const b=document.getElementById("characterBtn");if(b)b.addEventListener("click",open);});
})();