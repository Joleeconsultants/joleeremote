import {chromium} from 'playwright';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const html=readFileSync(new URL('../public/viewer.html',import.meta.url),'utf8');
const browser=await chromium.launch({headless:true,...(process.env.DASHBOARD_BROWSER_CHANNEL?{channel:process.env.DASHBOARD_BROWSER_CHANNEL}:{})});
try{
  const page=await browser.newPage({viewport:{width:800,height:600}});
  await page.setContent(html.slice(0,html.indexOf('<script type="module">')));
  await page.addScriptTag({content:`const canvas=document.getElementById('surface'),stage=document.getElementById('stage');let scaleLocally=false;
    ${html.slice(html.indexOf('function applyScale('),html.indexOf('function applySmoothing('))}
    ${html.slice(html.indexOf('function contentBox('),html.indexOf('function moveOverlay('))}
    window.configure=(w,h,fit)=>{canvas.width=w;canvas.height=h;scaleLocally=fit;applyScale();};
    window.normalized=pointerNorm;`});
  await page.evaluate(()=>window.configure(1920,1080,false));
  const large=await page.evaluate(()=>{const s=document.getElementById('stage'),c=document.getElementById('surface');return {sw:s.scrollWidth,sh:s.scrollHeight,cw:s.clientWidth,ch:s.clientHeight,left:c.getBoundingClientRect().left,top:c.getBoundingClientRect().top};});
  assert.equal(large.sw,1920);assert.equal(large.sh,1080);assert.ok(large.sw>large.cw&&large.sh>large.ch);assert.equal(large.left,0);assert.equal(large.top,0);
  const edge=await page.evaluate(()=>{const s=document.getElementById('stage');s.scrollLeft=s.scrollWidth;s.scrollTop=s.scrollHeight;return window.normalized({clientX:s.clientWidth,clientY:s.clientHeight});});
  assert.equal(edge.x,1);assert.equal(edge.y,1);
  await page.evaluate(()=>window.configure(320,240,false));
  const small=await page.locator('#surface').boundingBox();assert.equal(small.x,240);assert.equal(small.y,180);
  await page.evaluate(()=>window.configure(1920,1080,true));
  const fit=await page.evaluate(()=>{const s=document.getElementById('stage');return {x:s.scrollLeft,y:s.scrollTop,sw:s.scrollWidth,cw:s.clientWidth,sh:s.scrollHeight,ch:s.clientHeight};});
  assert.equal(fit.x,0);assert.equal(fit.y,0);assert.equal(fit.sw,fit.cw);assert.equal(fit.sh,fit.ch);
  console.log('Exact-resolution overflow, centering, scrolled input mapping and fit reset PASS.');
}finally{await browser.close();}
