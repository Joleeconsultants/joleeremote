import {SessionRenewal,preserveRestartName} from './session-renewal.js';
/** Optional private integration: unsupported hosts and older PCs retain their existing lifetime. */
export function mountRenewalUi({sessionId,browserToken,onExpired,root=document.body}){
 const connectionBox=document.getElementById('connection-status');
 const box=connectionBox||document.createElement('div');if(!connectionBox)box.hidden=true;box.setAttribute('role','status');
 if(!connectionBox)box.style.cssText='position:absolute;top:16px;left:50%;transform:translateX(-50%);max-width:calc(100% - 48px);padding:12px 16px;border:1px solid #75839a;border-radius:8px;background:#222833;color:#e6ebf3;font:16px system-ui;z-index:5;text-align:center';
 const text=document.createElement('span'),button=document.createElement('button');button.type='button';button.className='session-action';button.hidden=true;text.dataset.renewalText='';box.append(text,button);if(!connectionBox)root.append(box);
 box.style.pointerEvents='auto';
 let supported=false,checked=false,checking=false,restartPath=null,lastState='',expiredNotified=false,inspectAttempts=0,retryTimer,identityGeneration=0;
 async function call(payload){
  const response=await fetch('/api/session-renewal',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',cache:'no-store',
   signal:AbortSignal.timeout(4000),body:JSON.stringify({...payload,browserToken})});
  if(!response.ok)throw Error('renewal_unavailable');return response.json();
 }
 function restoreRestart(){
  try{const raw=sessionStorage.getItem('jolee-restart:'+sessionId);if(!raw)return;const url=new URL(raw,location.origin);
   if(url.origin===location.origin&&url.pathname==='/'&&url.searchParams.has('clientId')&&url.searchParams.has('agentId')){
    preserveRestartName(url,sessionId,sessionStorage.getItem('jolee_tab_device'));restartPath=url.pathname+url.search;
   }
  }catch{}
 }
 restoreRestart();
 const render=state=>{
  const ended=state.expired||['ended','expired','unavailable'].includes(lastState);
  const active=Boolean(ended||(supported&&(state.warning||state.error||state.pending)));
  box.dataset.renewalActive=String(active);
  if(!active){text.textContent='';button.hidden=true;const label=box.querySelector('[data-connection-text]');if(label)label.hidden=false;box.hidden=connectionBox?box.dataset.connectionVisible!=='true':true;return;}
  box.hidden=false;
  const connectionPriority=!ended&&box.dataset.connectionVisible==='true';
  const connectionText=box.querySelector('[data-connection-text]');if(connectionText)connectionText.hidden=!connectionPriority;
  text.hidden=connectionPriority;
  text.textContent=ended?(lastState==='expired'||state.expired?'Session expired. The last screen is not live.':'Session ended. The last screen is not live.'):state.pending?'Confirming session extension…':state.error||'Session expires in '+Math.max(1,Math.ceil((state.expiresAt-Date.now())/60000))+' minutes.';
  button.textContent=ended?'Restart session':'Keep session active';button.hidden=ended?!restartPath:false;
  button.disabled=ended?false:!state.canRenew;
  button.onclick=()=>{if(ended&&restartPath)window.top.location.assign(restartPath);else void model.renew();};
  if(state.expired&&!expiredNotified){expiredNotified=true;onExpired();}
 };
 const model=new SessionRenewal({request:async payload=>{
  await call({...payload,action:'start'});
  const until=Date.now()+12000;
  while(Date.now()<until){
   const value=await call({...payload,action:'status'});
   if(value.status==='committed')return value;
   if(value.status!=='pending')throw Error('renewal_failed');
   await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw Error('confirmation_timeout');
 },render});
 const api={bind(state,expiresAt,identity){
  if(identity&&(identity.sessionId!==sessionId||identity.browserToken!==browserToken)){
   identityGeneration++;clearTimeout(retryTimer);model.reset();
   sessionId=identity.sessionId;browserToken=identity.browserToken;
   supported=false;checked=false;checking=false;inspectAttempts=0;restartPath=null;expiredNotified=false;restoreRestart();
  }
  if(state==='paired'&&lastState!=='paired'&&!supported){checked=false;inspectAttempts=0;}
  lastState=state;
  if(Number.isSafeInteger(expiresAt))model.bind(sessionId,expiresAt,supported);
  else if(model.session)model.publish();else render({});
  if(state!=='paired'||checked||checking||!Number.isSafeInteger(expiresAt))return;
  checking=true;inspectAttempts++;const generation=identityGeneration;
  void call({action:'inspect',sessionId,previousExpiresAt:expiresAt,requestId:crypto.randomUUID()}).then(value=>{
   if(generation!==identityGeneration)return;
   checked=true;supported=value.status==='available'&&value.sessionId===sessionId;
   if(supported&&typeof value.restartPath==='string'){
    const url=new URL(value.restartPath,location.origin);
    if(url.origin===location.origin&&url.pathname==='/'&&url.searchParams.has('clientId')&&url.searchParams.has('agentId')){
     try{preserveRestartName(url,sessionId,sessionStorage.getItem('jolee_tab_device'));}catch{}
     restartPath=url.pathname+url.search;
     try{sessionStorage.setItem('jolee-restart:'+sessionId,restartPath);}catch{}
    }
   }
   model.bind(sessionId,model.expiresAt??expiresAt,supported);
  }).catch(()=>{
   if(generation!==identityGeneration)return;
   checked=inspectAttempts>=3;
   if(!checked){clearTimeout(retryTimer);retryTimer=setTimeout(()=>{if(lastState==='paired')api.bind(lastState,model.expiresAt);},inspectAttempts*5000);}
  }).finally(()=>{if(generation===identityGeneration)checking=false;});
 }};
 return api;
}
