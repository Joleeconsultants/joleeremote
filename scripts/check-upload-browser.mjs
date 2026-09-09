import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const bundle=await readFile(new URL('../public/dashboard/dashboard.js',import.meta.url));
const css=await readFile(new URL('../public/dashboard/dashboard.css',import.meta.url));
const module=await readFile(new URL('../public/upload-control.js',import.meta.url));
const shell='<!doctype html><link rel="stylesheet" href="/dashboard.css"><div id="root"></div><iframe id="jolee-core" src="/core"></iframe><script type="module" src="/dashboard.js"></script>';
const core=`<button id="saved">Save</button><button id="rejected">Collision</button><button id="legacy">Legacy</button><script type="module">
import {UploadControl} from '/upload-control.js';
let mode='saved',count=0;const socket={readyState:1};
const control=new UploadControl({id:()=> 'test-'+(++count),encode:p=>new TextEncoder().encode(JSON.stringify(p)),
 report:payload=>parent.postMessage({type:'fileUpload',payload},location.origin),
 send:frame=>{const p=JSON.parse(new TextDecoder().decode(frame));if(p.id)setTimeout(()=>control.consume({t:'file_upload_result',id:p.id,status:mode,name:mode==='saved'?p.name:null,bytes:mode==='saved'?5:null,reason:mode==='saved'?null:'exists'},socket),10);}});
control.bind(socket,Date.now()+60000);
for(const id of ['saved','rejected','legacy'])document.getElementById(id).onclick=()=>{mode=id;control.capability(id!=='legacy');control.upload(new File(['hello'],'same.txt',{type:'text/plain'}));};
</script>`;
const server=createServer((req,res)=>{const route={'/':['text/html',shell],'/core':['text/html',core],'/dashboard.css':['text/css',css],'/dashboard.js':['text/javascript',bundle],'/upload-control.js':['text/javascript',module]}[req.url];res.writeHead(route?200:404,{'Content-Type':route?.[0]||'text/plain'});res.end(route?.[1]||'missing');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({headless:true,...(process.env.DASHBOARD_BROWSER_CHANNEL?{channel:process.env.DASHBOARD_BROWSER_CHANNEL}:{})});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 page.setDefaultTimeout(10000);
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('.toggle-handle').waitFor({state:'attached'});
 await page.waitForTimeout(600);
 await page.frameLocator('#jolee-core').locator('#saved').click();await page.locator('.notification-item.end').waitFor().catch(async e=>{console.log({errors,notifications:await page.locator('.notification-container').innerHTML()});throw e;});
 assert.match(await page.locator('.notification-item.end').innerText(),/same.txt/);
 await page.frameLocator('#jolee-core').locator('#rejected').click();await page.locator('.notification-item.error').waitFor();
 assert.match(await page.locator('.notification-item.error').innerText(),/already exists/);
 assert.equal(await page.locator('.notification-item.end').count(),1,'same filename must not replace prior operation');
 await page.frameLocator('#jolee-core').locator('#legacy').click();await page.locator('.notification-item.warn').waitFor();
 assert.match(await page.locator('.notification-item.warn').innerText(),/cannot confirm/);
 assert.deepEqual(errors,[]);console.log('Actual built notification UI: saved, collision, legacy unknown and same-name isolation PASS. No PC/clipboard.');
}finally{try{await browser?.close();}finally{await new Promise(r=>server.close(r));}}
