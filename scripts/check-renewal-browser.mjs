import {chromium} from 'playwright';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const viewer=readFileSync(new URL('../public/viewer.html',import.meta.url),'utf8');
const notice=viewer.match(/<div id="connection-status"[^>]*>.*?<\/div>/)[0];
const stateInit=viewer.slice(viewer.indexOf('const sessionState=new SessionState('),viewer.indexOf('const renewalUi='));
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage();page.on('pageerror',e=>console.log('PAGE ERROR',e.message));let starts=0,ends=0,request,unsupported=false,inspections=0,freshOnLoad=true;
 await page.route('https://renewal.test/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path==='/sessions/session/end'){
    assert.equal(route.request().method(),'POST');assert.equal(route.request().headers().authorization,'Bearer browser');ends++;
    return route.fulfill({status:204,body:''});
   }
  if(path==='/api/session-renewal'){
   const body=route.request().postDataJSON();
   if(unsupported)return route.fulfill({status:409,body:'{}'});
   if(body.action==='inspect'&&++inspections===1)return route.fulfill({status:503,body:'{}'});
   if(body.action==='inspect')return route.fulfill({json:{...body,status:'available',restartPath:'/?clientId=client&agentId=device'}});
   if(body.action==='start'){starts++;request=body;return route.fulfill({json:{...body,status:'pending'}});}
   assert.equal(body.requestId,request.requestId);
   return route.fulfill({json:{...body,status:'committed',expiresAt:Date.now()+3600000}});
  }
  if(path.endsWith('.js'))return route.fulfill({contentType:'text/javascript',body:readFileSync(new URL('../public'+path,import.meta.url),'utf8')});
  return route.fulfill({contentType:'text/html',body:`${notice}<script type="module">import {mountRenewalUi} from '/renewal-ui.js';import {SessionState} from '/session-state.js';${stateInit}window.sessionState=sessionState;sessionState.set('paired');${freshOnLoad?'sessionState.frame();':''}sessionStorage.setItem('jolee_tab_device',JSON.stringify({session:'session',name:'QBOOKS-HOST'}));window.ui=mountRenewalUi({sessionId:'session',browserToken:'browser',onExpired:()=>window.expired=true});ui.bind('paired',Date.now()+180000);</script>`});
 });
 await page.goto('https://renewal.test/');
 const keep=page.getByRole('button',{name:'Keep session active'});
 await page.waitForFunction(()=>!!window.ui);
 await keep.waitFor({state:'visible',timeout:10000});assert.equal(starts,0);assert.equal(inspections,2);
 await page.evaluate(()=>window.sessionState.stale('The screen has stopped updating.'));
 assert.equal(await page.locator('[data-connection-text]').isVisible(),true);
 assert.equal(await page.locator('[data-renewal-text]').isVisible(),false);
 await page.evaluate(()=>window.ui.bind('paired',Date.now()+60000));
 assert.equal(await page.locator('[data-connection-text]').isVisible(),true);
 await page.evaluate(()=>{window.sessionState.set('disconnected');window.ui.bind('disconnected');});
 assert.match(await page.locator('[data-connection-text]').innerText(),/Connection lost/);
 assert.equal(await page.locator('[data-renewal-text]').isVisible(),false);
 await page.evaluate(()=>{window.sessionState.set('paired');window.sessionState.frame();window.ui.bind('paired',Date.now()+60000);});
 await keep.click();await page.waitForFunction(()=>document.querySelector('[role=status]').hidden);
 assert.equal(starts,1);assert.equal(new URL(page.url()).pathname,'/');assert.equal(await page.locator('[role=status]').count(),1);assert.equal(await page.locator('#connection-status').evaluate(el=>el.style.bottom),'');
 await page.evaluate(()=>window.ui.bind('expired',Date.now()-1));
 await page.getByRole('button',{name:'Restart session'}).waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('jolee-restart:session')),'/?clientId=client&agentId=device&machineName=QBOOKS-HOST');
 await page.evaluate(()=>window.ui.bind('paired',Date.now()+60000,{sessionId:'new-session',browserToken:'new-browser'}));
 await keep.waitFor({state:'visible'});await keep.click();await page.waitForFunction(()=>document.querySelector('[role=status]').hidden);
 assert.equal(request.sessionId,'new-session');assert.equal(request.browserToken,'new-browser');
 await page.reload();await page.waitForFunction(()=>!!window.ui);
 await page.clock.install();
 await page.evaluate(()=>{window.sessionState.set('waiting');window.ui.bind('waiting');});
 assert.equal(await page.getByRole('button',{name:'Restart session'}).isVisible(),false);
 assert.equal(await page.locator('[data-connection-text]').isVisible(),true);
 await page.clock.fastForward(14000);
 await page.evaluate(()=>window.ui.bind('disconnected'));
 assert.equal(await page.getByRole('button',{name:'Restart session'}).isVisible(),false);
 await page.clock.fastForward(1000);
 await page.getByRole('button',{name:'Restart session'}).waitFor({state:'visible'});
 assert.match(await page.locator('[data-connection-text]').innerText(),/Waiting for the PC/);
 await page.evaluate(()=>window.ui.bind('expired'));await page.getByRole('button',{name:'Restart session'}).waitFor({state:'visible'});
 // Refresh near expiry: paired transport must not flash the renewal action
 // over the waiting-for-first-frame message, even after async inspection.
 freshOnLoad=false;await page.reload();await page.waitForFunction(()=>!!window.ui);
 await page.waitForFunction(()=>document.querySelector('.session-action').textContent==='Restart session');
 assert.match(await page.locator('[data-connection-text]').innerText(),/Waiting for a fresh screen/);
 assert.equal(await keep.isVisible(),false);
 assert.equal(await page.locator('.session-action').isVisible(),false);
 await page.clock.fastForward(14000);
 await page.evaluate(()=>window.ui.bind('paired',Date.now()+180000));
 assert.equal(await page.locator('.session-action').isVisible(),false);
 await page.clock.fastForward(1000);
 await page.getByRole('button',{name:'Restart session'}).waitFor({state:'visible'});
 // The final expiry bubble and its renewal action return on fresh paint,
 // without requiring another status packet. The reconnect timer is cancelled.
 await page.evaluate(()=>window.sessionState.frame());
 await keep.waitFor({state:'visible'});
 assert.match(await page.locator('[data-renewal-text]').innerText(),/Session expires in 3 minutes/);
 assert.equal(await page.locator('[data-connection-text]').isVisible(),false);
 assert.equal(await keep.isEnabled(),true);
 await page.evaluate(()=>{window.sessionState.set('disconnected');window.ui.bind('disconnected');});
 await page.clock.fastForward(5000);
 await page.evaluate(()=>{window.sessionState.set('paired');window.ui.bind('paired',Date.now()+180000);});
 await page.clock.fastForward(9000);
 assert.equal(await page.locator('.session-action').isVisible(),false);
 await page.evaluate(()=>window.sessionState.frame());
 await keep.waitFor({state:'visible'});
 await page.clock.fastForward(1000);
 assert.equal(await keep.isVisible(),true);
 assert.equal(await page.getByRole('button',{name:'Restart session'}).isVisible(),false);
 await keep.click();await page.waitForFunction(()=>document.querySelector('[role=status]').hidden);
 assert.equal(starts,3);
  unsupported=true;await page.reload();await page.waitForFunction(()=>!!window.ui);
  assert.equal(await keep.isVisible(),false);
  // A user-requested recovery is an actual owner-authorized replacement: end
  // the broken session, then navigate once through the normal mint route.
  unsupported=false;freshOnLoad=false;await page.reload();await page.waitForFunction(()=>!!window.ui);
  await page.evaluate(()=>{window.sessionState.set('waiting');window.ui.bind('waiting');});
  await page.clock.fastForward(15000);
  const replacement=page.waitForRequest(request=>new URL(request.url()).searchParams.get('clientId')==='client');
  await page.getByRole('button',{name:'Restart session'}).click();await replacement;
  assert.equal(ends,1);
  console.log('Edge explicit renewal, owner-authorized replacement, expiry/restart and unsupported-agent hiding PASS.');
}finally{await browser.close();}
