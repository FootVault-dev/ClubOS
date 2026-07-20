// AttributionOS — the embeddable cross-site tracker `/t.js` (T12).
//
// The marketing sites (minifootball.co.nz, cicyouth.com, …) each load this script
// from THEIR same-root ClubOS funnel domain, e.g.
//   <script src="https://join.minifootball.co.nz/t.js" async></script>
// so it is first-party to the brand root. The server route `GET /t.js`
// (server/routes.ts) injects the serving origin as `collectorBase` and the list of
// brand roots we own as `domains`, then serves the string this function returns.
//
// The tracker itself:
//   1. Boots the visitor via `POST <base>/api/public/analytics/hello` — the server
//      Set-Cookies a usg_vid scoped to the brand ROOT (Domain=minifootball.co.nz),
//      so the marketing site and the funnel subdomain share ONE first-party visitor
//      id, and echoes back { visitorId, clickId }.
//   2. Sends a page_view touch (utm / fbclid / gclid / ci / fbp / fbc / landingUrl)
//      to the existing collector `/api/public/analytics/batch`.
//   3. Decorates outbound <a> links that point at our OTHER brand roots with
//      `?vi=<visitor>&ci=<click>` so a cross-root hop can be stitched (T13 accepts
//      the `?vi=` on the destination landing).
//
// The RETURNED STRING must be ES5-safe (no arrow fns, `const`/`let`, or template
// literals) because it is served verbatim and never transpiled. The TypeScript
// source here IS compiled (esbuild), so template literals in THIS file are fine —
// only the characters inside the returned string matter. `renderTrackerScript` is
// pure (no I/O), so `script/test-attribution-tjs.ts` asserts its size + ES5-safety.

export interface TrackerScriptOptions {
  /** The origin that served the script, e.g. `https://join.minifootball.co.nz`. */
  collectorBase: string;
  /** Registrable brand roots we own (CLUB_ROOT_DOMAINS) — used for link decoration. */
  domains: readonly string[];
}

/** Build the `/t.js` tracker body. Pure — the route injects host-derived config. */
export function renderTrackerScript(opts: TrackerScriptOptions): string {
  const base = JSON.stringify(String(opts.collectorBase || "").replace(/\/+$/, ""));
  const roots = JSON.stringify((opts.domains || []).map((d) => String(d).toLowerCase()));
  // NOTE: everything inside this template literal is emitted verbatim — keep it ES5.
  return `(function(){
var BASE=${base},ROOTS=${roots};
var HELLO=BASE+'/api/public/analytics/hello',BATCH=BASE+'/api/public/analytics/batch';
var VID='usg_vid',CID='usg_cid';
function ck(n){var r=document.cookie||'';var p=r?r.split('; '):[];for(var i=0;i<p.length;i++){var c=p[i];var e=c.indexOf('=');var k=e>-1?c.slice(0,e):c;if(k===n){var v=e>-1?c.slice(e+1):'';try{return decodeURIComponent(v);}catch(x){return v;}}}return null;}
function uuid(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;return (c==='x'?r:(r&0x3|0x8)).toString(16);});}
function qp(n){try{return new URLSearchParams(location.search).get(n)||null;}catch(e){return null;}}
function sid(){var k='_usg_sid';var v=null;try{v=sessionStorage.getItem(k);}catch(e){}if(!v){v=uuid();try{sessionStorage.setItem(k,v);}catch(e){}}return v;}
function rootOf(h){h=(h||'').toLowerCase();for(var i=0;i<ROOTS.length;i++){var d=ROOTS[i];if(h===d||h.slice(-(d.length+1))==='.'+d)return d;}return null;}
function post(u,b,cb){try{var x=new XMLHttpRequest();x.open('POST',u,true);x.withCredentials=true;x.setRequestHeader('Content-Type','application/json');if(cb){x.onreadystatechange=function(){if(x.readyState===4)cb(x.responseText);};}x.send(JSON.stringify(b));}catch(e){if(cb)cb(null);}}
var ci=qp('ci'),vi0=qp('vi');
var vid=ck(VID),cid=ci||ck(CID)||null,s=sid();
var landing={fbclid:qp('fbclid'),gclid:qp('gclid'),ci:ci,vi:vi0,utmSource:qp('utm_source'),utmMedium:qp('utm_medium'),utmCampaign:qp('utm_campaign'),utmContent:qp('utm_content'),utmTerm:qp('utm_term'),landingUrl:location.href,referrer:document.referrer||null,page:location.pathname};
function decorate(){if(!vid&&!cid)return;var mine=rootOf(location.hostname);var as=document.getElementsByTagName('a');for(var i=0;i<as.length;i++){var a=as[i];var href=a.getAttribute('href');if(!href)continue;var u;try{u=new URL(href,location.href);}catch(e){continue;}if(u.protocol!=='http:'&&u.protocol!=='https:')continue;var r=rootOf(u.hostname);if(!r)continue;if(r===mine)continue;try{if(vid&&!u.searchParams.has('vi'))u.searchParams.set('vi',vid);if(cid&&!u.searchParams.has('ci'))u.searchParams.set('ci',cid);a.setAttribute('href',u.toString());}catch(e){}}}
function touch(){if(!vid)return;var e={visitorId:vid,sessionId:s,eventType:'page_view',page:landing.page,referrer:landing.referrer,utmSource:landing.utmSource,utmMedium:landing.utmMedium,utmCampaign:landing.utmCampaign,utmContent:landing.utmContent,utmTerm:landing.utmTerm,fbclid:landing.fbclid,gclid:landing.gclid,ci:landing.ci,clickId:cid,fbp:ck('_fbp'),fbc:ck('_fbc'),landingUrl:landing.landingUrl,device:(window.innerWidth<768?'mobile':(window.innerWidth<1024?'tablet':'desktop')),webdriver:(navigator.webdriver===true),metadata:{trafficSource:'cross-site',crossSite:true}};post(BATCH,{events:[e]});}
function ready(fn){if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',fn);}else{fn();}}
function loadBehavior(){if(!vid)return;try{window.__usgB={base:BASE,vid:vid,sid:s};var sc=document.createElement('script');sc.src=BASE+'/t2.js';sc.async=true;(document.head||document.documentElement).appendChild(sc);}catch(e){}}
post(HELLO,{ci:landing.ci,fbclid:landing.fbclid,gclid:landing.gclid,vi:landing.vi,landingUrl:landing.landingUrl,referrer:landing.referrer},function(txt){if(txt){try{var r=JSON.parse(txt);if(r){if(r.visitorId)vid=r.visitorId;if(r.clickId)cid=r.clickId;}}catch(e){}}if(!vid)vid=ck(VID);touch();ready(decorate);loadBehavior();});
})();
`;
}

// ── Phase 1 (Behavioral Depth) — the v2 behavioral collector, T6 ──────────────
//
// This is a SEPARATE, lazy-loaded script (`GET /t2.js`) — NOT part of the boot
// tracker above. `renderTrackerScript`'s `loadBehavior()` injects it as a second
// <script> tag only once `vid` (the visitor id) is known, and hands it
// `window.__usgB = {base, vid, sid}` so it never re-derives cookies/session
// itself. Keeping it lazy/separate is what keeps the BOOT script under the 6KB
// budget (AGENTS.md §7) even though the full v2 taxonomy is substantial.
//
// Emits the taxonomy from AGENTS.md §1 to the NEW `POST <base>/api/public/
// analytics/behavior` collector (T5) — never the attribution `/batch` endpoint
// (rule 4). Batched in-memory, flushed on an 8s interval (XHR) and immediately
// via `navigator.sendBeacon` on `visibilitychange`→hidden / `pagehide` (≤2
// requests/pageview typical for a page with no SPA navigation, per spec).
//
// Same ES5-safety constraint as the boot script (no arrow fns/const/let/template
// literals in the OUTPUT) — the syntax must parse in old engines even though the
// APIs used (IntersectionObserver, PerformanceObserver, sendBeacon) are modern
// and feature-detected/try-caught, never assumed. `script/test-attribution-tjs.ts`
// asserts this. NOTE: any regex needing a metacharacter escape (e.g. `\s`) must be
// written with a DOUBLED backslash in this TS source — a template literal cooks
// `\s` down to a bare `s` (valid "identity escape"), silently corrupting the
// output regex if written with a single backslash.
export interface BehaviorScriptOptions {
  /** The origin that served the script, e.g. `https://join.minifootball.co.nz`. */
  collectorBase: string;
}

/** Build the `/t2.js` behavioral collector body. Pure — the route injects the host-derived base. */
export function renderBehaviorScript(opts: BehaviorScriptOptions): string {
  const base = JSON.stringify(String(opts.collectorBase || "").replace(/\/+$/, ""));
  return `(function(){
var W=window,B=W.__usgB||{};
if(!B.vid)return;
var BASE=${base},URL=BASE+'/api/public/analytics/behavior';
var VID=B.vid,SID=B.sid||'';
var D=document;
function vp(){var w=W.innerWidth||0;return w<768?'mobile':(w<1024?'tablet':'desktop');}
function pathOf(){try{return location.pathname||'/';}catch(e){return '/';}}
function siteOf(){try{return location.hostname||'';}catch(e){return '';}}
var CURPATH=pathOf();
var Q=[],MAXQ=40;
function mk(t,extra){var e={visitorId:VID,sessionId:SID,site:siteOf(),eventType:t,page:CURPATH,viewport:vp()};if(extra){for(var k in extra){if(extra.hasOwnProperty(k))e[k]=extra[k];}}return e;}
function push(t,extra){Q.push(mk(t,extra));if(Q.length>=MAXQ)flush(false);}
function flush(sync){if(Q.length===0)return;var batch=Q;Q=[];scrollEvt=null;var body;try{body=JSON.stringify({events:batch});}catch(e){return;}
if(sync){try{if(navigator.sendBeacon){var blob=new Blob([body],{type:'application/json'});if(navigator.sendBeacon(URL,blob))return;}}catch(e){}}
try{var x=new XMLHttpRequest();x.open('POST',URL,true);x.withCredentials=true;x.setRequestHeader('Content-Type','application/json');x.send(body);}catch(e){}}
function cssPath(el){
if(!el||el.nodeType!==1)return '';
var parts=[],node=el,depth=0;
while(node&&node.nodeType===1&&depth<5){
var part=node.tagName?node.tagName.toLowerCase():'?';
if(node.id){parts.unshift(part+'#'+node.id);break;}
var sib=node,i=1;
while(sib.previousElementSibling){sib=sib.previousElementSibling;if(sib.tagName===node.tagName)i++;}
parts.unshift(part+':nth-of-type('+i+')');
node=node.parentElement;depth++;
}
return parts.join('>');
}
var lastClicks={};
function onClick(ev){
try{
var t=ev.target;if(!t||t.nodeType!==1)return;
var p=cssPath(t);
var ox=null,oy=null,rect=null;
try{rect=t.getBoundingClientRect();}catch(e){}
if(rect&&rect.width>0&&rect.height>0){
ox=(ev.clientX-rect.left)/rect.width;oy=(ev.clientY-rect.top)/rect.height;
if(ox<0)ox=0;if(ox>1)ox=1;if(oy<0)oy=0;if(oy>1)oy=1;
}
var txt=(t.textContent||'').replace(/\\s+/g,' ');
txt=txt.length>80?txt.slice(0,80):txt;
push('click',{cssPath:p,offsetX:ox,offsetY:oy,text:txt||null});
var now=Date.now(),rec=lastClicks[p];
if(!rec||now-rec.last>1000)rec={count:0,last:0};
rec.count++;rec.last=now;lastClicks[p]=rec;
if(rec.count===3)push('rage_click',{cssPath:p});
}catch(e){}
}
var maxBand=0,scrollEvt=null,scrollTimer=null;
function setScroll(band){
if(!scrollEvt){scrollEvt=mk('scroll',{scrollBand:band});Q.push(scrollEvt);}
else{scrollEvt.scrollBand=band;}
}
function onScroll(){
if(scrollTimer)return;
scrollTimer=setTimeout(function(){
scrollTimer=null;
try{
var de=D.documentElement,bd=D.body;
var sh=Math.max(de?de.scrollHeight:0,bd?bd.scrollHeight:0,1);
var vh=W.innerHeight||(de?de.clientHeight:0)||0;
var y=W.pageYOffset||(de?de.scrollTop:0)||0;
var pct=((y+vh)/sh)*100;if(pct>100)pct=100;if(pct<0)pct=0;
var band=Math.round(pct/10)*10;
if(band>maxBand){maxBand=band;setScroll(band);}
}catch(e){}
},200);
}
var secState={},secObserver=null;
function secKeyOf(el){try{return el.getAttribute('data-track-section')||'';}catch(e){return '';}}
function onSecEntries(entries){
for(var i=0;i<entries.length;i++){
var en=entries[i],k=secKeyOf(en.target);if(!k)continue;
if(!secState[k])secState[k]={start:null,acc:0};
if(en.isIntersecting){if(secState[k].start===null)secState[k].start=Date.now();}
else if(secState[k].start!==null){secState[k].acc+=Date.now()-secState[k].start;secState[k].start=null;}
}
}
function scanSections(){
if(!W.IntersectionObserver)return;
try{
if(!secObserver)secObserver=new IntersectionObserver(onSecEntries,{threshold:[0]});
var els=D.querySelectorAll('[data-track-section]');
for(var i=0;i<els.length;i++){if(!els[i].__usgSecObs){els[i].__usgSecObs=1;secObserver.observe(els[i]);}}
}catch(e){}
}
function flushSections(){
var now=Date.now();
for(var k in secState){
if(!secState.hasOwnProperty(k))continue;
var st=secState[k],ms=st.acc;
if(st.start!==null){ms+=now-st.start;st.start=now;}
if(ms>0){push('section_view',{sectionKey:k,visibleMs:Math.round(ms)});st.acc=0;}
}
}
var startedForms={},submittedForms={};
function formIdOf(f){try{return f.id||f.getAttribute('name')||'form';}catch(e){return 'form';}}
function onFocusIn(ev){
try{
var t=ev.target;if(!t||!t.form)return;
var id=formIdOf(t.form);
if(!startedForms[id]){startedForms[id]=true;push('form_start',{formId:id});}
}catch(e){}
}
function onSubmit(ev){
try{var f=ev.target;if(f&&f.tagName==='FORM')submittedForms[formIdOf(f)]=true;}catch(e){}
}
function flushFormAbandons(){
for(var id in startedForms){
if(!startedForms.hasOwnProperty(id))continue;
if(!submittedForms[id])push('form_abandon',{formId:id});
}
startedForms={};submittedForms={};
}
var lcpVal=null,clsVal=0,inpVal=0;
function initVitals(){
if(!W.PerformanceObserver)return;
try{var po1=new PerformanceObserver(function(list){var es=list.getEntries();if(es.length)lcpVal=es[es.length-1].startTime;});po1.observe({type:'largest-contentful-paint',buffered:true});}catch(e){}
try{var po2=new PerformanceObserver(function(list){var es=list.getEntries();for(var i=0;i<es.length;i++){if(!es[i].hadRecentInput)clsVal+=es[i].value;}});po2.observe({type:'layout-shift',buffered:true});}catch(e){}
try{var po3=new PerformanceObserver(function(list){var es=list.getEntries();for(var i=0;i<es.length;i++){var d=es[i].duration||0;if(d>inpVal)inpVal=d;}});po3.observe({type:'event',buffered:true,durationThreshold:40});}catch(e){}
}
function reportVitals(){
if(lcpVal!==null)push('vitals',{metric:'LCP',metricValue:Math.round(lcpVal)});
if(clsVal>0)push('vitals',{metric:'CLS',metricValue:Math.round(clsVal*1000)/1000});
if(inpVal>0)push('vitals',{metric:'INP',metricValue:Math.round(inpVal)});
}
var pageStart=Date.now(),leftSent=false;
function leave(sync){
if(leftSent)return;leftSent=true;
push('page_leave',{dwellMs:Date.now()-pageStart});
flushSections();flushFormAbandons();reportVitals();
flush(sync);
}
function onRoute(){
try{
var p=pathOf();if(p===CURPATH)return;
leave(true);
CURPATH=p;pageStart=Date.now();leftSent=false;maxBand=0;scrollEvt=null;
push('route_change',{});
scanSections();
}catch(e){}
}
D.addEventListener('click',onClick,true);
D.addEventListener('focusin',onFocusIn,true);
D.addEventListener('submit',onSubmit,true);
W.addEventListener('scroll',onScroll,false);
D.addEventListener('visibilitychange',function(){if(D.visibilityState==='hidden')leave(true);},false);
W.addEventListener('pagehide',function(){leave(true);},false);
try{
var _ps=history.pushState,_rs=history.replaceState;
if(_ps)history.pushState=function(){var r=_ps.apply(history,arguments);setTimeout(onRoute,0);return r;};
if(_rs)history.replaceState=function(){var r=_rs.apply(history,arguments);setTimeout(onRoute,0);return r;};
}catch(e){}
W.addEventListener('popstate',function(){setTimeout(onRoute,0);},false);
scanSections();
setInterval(scanSections,4000);
initVitals();
setInterval(function(){flushSections();flush(false);},8000);
})();
`;
}
