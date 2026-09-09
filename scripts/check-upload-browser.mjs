import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const bundle=await readFile(new URL('../public/dashboard/dashboard.js',import.meta.url));
const css=await readFile(new URL('../public/dashboard/dashboard.css',import.meta.url));
const module=await readFile(new URL('../public/upload-control.js',import.meta.url));
const shell=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const core=`<button id="saved">Save</button><button id="rejected">Collision</button><button id="legacy">Legacy</button><script type="module">
import {UploadControl} from '/upload-control.js';
let mode='saved',count=0;const socket={readyState:1};
const control=new UploadControl({id:()=> 'test-'+(++count),encode:p=>new TextEncoder().encode(JSON.stringify(p)),
 report:payload=>parent.postMessage({type:'fileUpload',payload},location.origin),
 send:frame=>{const p=JSON.parse(new TextDecoder().decode(frame));if(p.id)setTimeout(()=>control.consume({t:'file_upload_result',id:p.id,status:mode,name:mode==='saved'?p.name:null,bytes:mode==='saved'?5:null,reason:mode==='saved'?null:'exists'},socket),10);}});
control.bind(socket,Date.now()+60000);
window.addEventListener('message',event=>{
 if(event.origin!==location.origin||event.source!==parent||event.data?.type!=='fileUpload')return;
 mode='saved';control.capability(true);control.upload(event.data.file);
});
for(const id of ['saved','rejected','legacy'])document.getElementById(id).onclick=()=>{mode=id;control.capability(id!=='legacy');control.upload(new File(['hello'],'same.txt',{type:'text/plain'}));};
</script>`;
const server=createServer((req,res)=>{const route={'/':['text/html',shell],'/viewer.html':['text/html',core],'/core':['text/html',core],'/dashboard/dashboard.css':['text/css',css],'/dashboard/dashboard.js':['text/javascript',bundle],'/upload-control.js':['text/javascript',module]}[new URL(req.url,'http://fixture').pathname];res.writeHead(route?200:404,{'Content-Type':route?.[0]||'text/plain'});res.end(route?.[1]||'missing');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({headless:true,...(process.env.DASHBOARD_BROWSER_CHANNEL?{channel:process.env.DASHBOARD_BROWSER_CHANNEL}:{})});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 page.setDefaultTimeout(10000);
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('.toggle-handle').waitFor({state:'attached'});
 await page.waitForTimeout(600);
 await page.locator('.toggle-handle').click();
 await page.getByText('Files',{exact:true}).click();
 const chooserPromise=page.waitForEvent('filechooser');
 await page.getByRole('button',{name:'Upload Files',exact:true}).click();
 const chooser=await chooserPromise;
 await chooser.setFiles({name:'picker-proof.txt',mimeType:'text/plain',buffer:Buffer.from('hello')});
 await page.locator('.notification-item.end').filter({hasText:'picker-proof.txt'}).waitFor();
 assert.equal(await page.locator('#jolee-file-upload').inputValue(),'','same file can be selected again');
 await page.locator('.notification-item.end').filter({hasText:'picker-proof.txt'}).locator('button').click();
 await page.locator('.toggle-handle').click();
 await page.frameLocator('#jolee-core').locator('#saved').click();await page.locator('.notification-item.end').filter({hasText:'same.txt'}).waitFor();
 assert.match(await page.locator('.notification-item.end').filter({hasText:'same.txt'}).innerText(),/same.txt/);
 await page.frameLocator('#jolee-core').locator('#rejected').click();await page.locator('.notification-item.error').waitFor();
 assert.match(await page.locator('.notification-item.error').innerText(),/already exists/);
 assert.equal(await page.locator('.notification-item.end').count(),1,'same filename must not replace prior operation');
 await page.frameLocator('#jolee-core').locator('#legacy').click();await page.locator('.notification-item.warn').waitFor().catch(async error=>{console.log({errors,notices:await page.locator('.notification-container').innerText()});throw error;});
 assert.match(await page.locator('.notification-item.warn').innerText(),/cannot confirm/);
 assert.deepEqual(errors,[]);console.log('Actual Upload Files button → picker → File postMessage → upload receipt UI PASS; collision, legacy unknown and same-name isolation PASS. Native save mocked; no PC/clipboard.');
}finally{try{await browser?.close();}finally{await new Promise(r=>server.close(r));}}
