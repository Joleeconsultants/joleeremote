import {chromium} from 'playwright';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const html=readFileSync(new URL('../public/viewer.html',import.meta.url),'utf8');
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage();
 await page.setContent('<canvas id="surface"></canvas><div id="stage"></div><img id="cursor">');
 await page.addScriptTag({content:`const canvas=document.querySelector('#surface'),stage=document.querySelector('#stage'),cursorEl=document.querySelector('#cursor');
 let useBrowserCursors=true,nativeCursor='default',pointerOver=true,agentCursorVisible=true,cursorHx=1,cursorHy=1,cursorPosition=null;
 const DEFAULT_CURSOR_SVG='',DEFAULT_CURSOR_HX=1,DEFAULT_CURSOR_HY=1,parseJsonFrameObject=x=>x;
 ${html.slice(html.indexOf('function applyCursorMode('),html.indexOf('let sessionPaired='))}
 ${html.slice(html.indexOf('function cursorFromFrame('),html.indexOf('function contentBox('))}
 window.shape=css=>{const image=document.createElement('canvas');image.width=32;image.height=32;const ctx=image.getContext('2d');ctx.fillRect(2,2,8,24);const data=image.toDataURL('image/png').split(',')[1];applyCursorFrame(cursorFromFrame({t:'cursor',visible:true,mime:'image/png',data,hx:2,hy:3,css}));return {cursor:canvas.style.cursor,overlay:cursorEl.style.display,source:cursorEl.src};};
 window.drawn=()=>{useBrowserCursors=false;applyCursorMode();return cursorEl.style.display;};`});
 for(const css of ['text','pointer','ew-resize','ns-resize','wait','default'])assert.equal((await page.evaluate(css=>window.shape(css),css)).cursor,css);
 const custom=await page.evaluate(()=>window.shape());assert.match(custom.cursor,/^url\("data:image\/png;base64,/);assert.match(custom.cursor,/2 3, default$/);assert.equal(custom.overlay,'none');
 assert.equal(await page.evaluate(()=>window.drawn()),'block');
 const size=await page.evaluate(async()=>{const image=document.querySelector('#cursor');await image.decode();return [image.naturalWidth,image.naturalHeight];});assert.deepEqual(size,[32,32]);
 console.log('Edge stock shapes, bounded custom PNG/hotspot and unchanged drawn dimensions PASS; OS cursor/drag acceptance still requires installed session.');
}finally{await browser.close();}

