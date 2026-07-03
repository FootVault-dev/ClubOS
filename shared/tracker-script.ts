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
post(HELLO,{ci:landing.ci,fbclid:landing.fbclid,gclid:landing.gclid,vi:landing.vi,landingUrl:landing.landingUrl,referrer:landing.referrer},function(txt){if(txt){try{var r=JSON.parse(txt);if(r){if(r.visitorId)vid=r.visitorId;if(r.clickId)cid=r.clickId;}}catch(e){}}if(!vid)vid=ck(VID);touch();ready(decorate);});
})();
`;
}
