import {chromium} from 'playwright';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage();page.on('pageerror',e=>console.log('PAGE ERROR',e.message));let starts=0,request,unsupported=false,inspections=0;
 await page.route('https://renewal.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
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
  return route.fulfill({contentType:'text/html',body:`<script type="module">import {mountRenewalUi} from '/renewal-ui.js';window.ui=mountRenewalUi({sessionId:'session',browserToken:'browser',onExpired:()=>window.expired=true});ui.bind('paired',Date.now()+60000);</script>`});
 });
 await page.goto('https://renewal.test/');
 const keep=page.getByRole('button',{name:'Keep Session Active'});
 await page.waitForFunction(()=>!!window.ui);
 await keep.waitFor({state:'visible',timeout:10000});assert.equal(starts,0);assert.equal(inspections,2);
 await keep.click();await page.waitForFunction(()=>document.querySelector('[role=status]').hidden);
 assert.equal(starts,1);
 await page.evaluate(()=>window.ui.bind('expired',Date.now()-1));
 await page.getByRole('button',{name:'Start New Session'}).waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('jolee-restart:session')),'/?clientId=client&agentId=device');
 await page.evaluate(()=>window.ui.bind('paired',Date.now()+60000,{sessionId:'new-session',browserToken:'new-browser'}));
 await keep.waitFor({state:'visible'});await keep.click();await page.waitForFunction(()=>document.querySelector('[role=status]').hidden);
 assert.equal(request.sessionId,'new-session');assert.equal(request.browserToken,'new-browser');
 unsupported=true;await page.reload();await page.waitForFunction(()=>!!window.ui);
 assert.equal(await keep.isVisible(),false);
 console.log('Edge explicit renewal, committed confirmation, expiry/restart and unsupported-agent hiding PASS.');
}finally{await browser.close();}
