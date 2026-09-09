import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Exercise the shipped bundle, not the Vite development module graph. This
// fixture has no agent, credentials, microphone permission or remote session.
const bundle = await readFile(new URL('../public/dashboard/dashboard.js', import.meta.url));
const css = await readFile(new URL('../public/dashboard/dashboard.css', import.meta.url));
const core = `<!doctype html><title>Inert core fixture</title>
<button id="current">Current</button><button id="custom">Custom</button><button id="unknown">Unknown</button>
<button id="camera">Camera status</button><button id="encoders">Encoders</button><button id="lost">Lost</button>
<button id="securefail">Secure failure</button><button id="sasnext">Next command</button>
<button id="removed">Monitor removed</button>
<script>
window.cursorMode=null;
window.addEventListener('message',e=>{if(e.origin===location.origin&&e.data?.type==='setUseBrowserCursors')window.cursorMode=e.data.value;});
const sizes={current:{width:1920,height:1200},custom:{width:3440,height:1440},unknown:null};
const opaque=n=>String(n).padStart(32,'0');
function publish(id){
  const size=sizes[id];
  const modes=[{id:opaque(2),width:1920,height:1200,refresh_hz:60,selectable:true,reason:null},
    {id:opaque(3),width:3440,height:1440,refresh_hz:60,selectable:true,reason:null},
    {id:opaque(4),width:7680,height:4320,refresh_hz:60,selectable:false,reason:'capture_limit'}];
  const display={id:opaque(1),label:'Test monitor',primary:true,x:0,y:0,width:size?.width||1920,height:size?.height||1200,current_mode_id:opaque(id==='custom'?3:2),modes,can_resize:true,reason:null};
  parent.postMessage({type:'statsUpdate',screen:{effective:size,catalog:size?{revision:opaque(9),selected_display_id:id==='removed'?null:opaque(1),displays:[display]}:null},microphone_supported:false,webcam_supported:false},location.origin);
}
sizes.removed=sizes.current;
for(const id of Object.keys(sizes))document.getElementById(id).onclick=()=>publish(id);
window.displayRequests=[];
window.addEventListener('message',e=>{
  if(e.origin!==location.origin || !['setBestFit','setDisplayMode','selectRemoteDisplay'].includes(e.data?.type))return;
  window.displayRequests.push(e.data);
  parent.postMessage({type:'screenResult',status:'applied',effective:sizes.current},location.origin);
  publish('current');
});
document.getElementById('encoders').onclick=()=>parent.postMessage({type:'statsUpdate',supported_encoders:['h264enc','jpeg'],active_encoder:'jpeg'},location.origin);
document.getElementById('lost').onclick=()=>parent.postMessage({type:'status',state:'waiting'},location.origin);
document.getElementById('camera').onclick=()=>parent.postMessage({type:'statsUpdate',webcam_supported:true,webcam_capture:{supported:true,state:'waiting'}},location.origin);
document.getElementById('securefail').onclick=()=>{
  parent.postMessage({type:'secureDesktopResult',status:'warning',code:'input_rejected'},location.origin);
  parent.postMessage({type:'secureDesktopResult',status:'failed',code:'helper_lost'},location.origin);
  parent.postMessage({type:'sasState',available:false,pending:false},location.origin);
};
document.getElementById('sasnext').onclick=()=>parent.postMessage({type:'sasState',available:false,pending:true},location.origin);
</script>`;
const shell = '<!doctype html><html><head><link rel="stylesheet" href="/dashboard.css"></head>'
  + '<body><div id="root"></div><iframe id="jolee-core" src="/core" style="position:fixed;right:0;bottom:0;width:80px;height:100px;z-index:9999"></iframe>'
  + '<script type="module" src="/dashboard.js"></script></body></html>';
const server = createServer((req, res) => {
  const routes = {
    '/': ['text/html', shell], '/core': ['text/html', core],
    '/dashboard.js': ['text/javascript', bundle], '/dashboard.css': ['text/css', css],
  };
  const entry = routes[req.url];
  res.writeHead(entry ? 200 : 404, { 'content-type': entry?.[0] ?? 'text/plain' });
  res.end(entry?.[1] ?? 'Not found');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.DASHBOARD_BROWSER_CHANNEL ? { channel: process.env.DASHBOARD_BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext();
  await context.route('**/*', route => route.request().url().startsWith(`${origin}/`)
    ? route.continue() : route.abort());
  await context.addInitScript(() => { window.VideoDecoder = undefined; });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.locator('#dashboard-root .toggle-handle').waitFor({ state: 'attached' }).catch(error => {
    throw new Error(`Dashboard did not mount. Browser errors: ${errors.join('; ')}`, { cause: error });
  });
  // Include asynchronous startup effects and delayed settings delivery.
  await page.waitForTimeout(600);
  assert.deepEqual(errors, [], 'dashboard startup must not throw');
  assert(await page.locator('#dashboard-root button').count() >= 5, 'original controls must mount');
  await page.locator('.toggle-handle').click();
  await page.getByText('Video Settings', { exact: true }).click();
  assert(await page.locator('#encoderSelect').isDisabled());
  assert.deepEqual(await page.locator('#encoderSelect option').evaluateAll(options=>options.map(o=>o.value)), ['']);
  await page.frameLocator('#jolee-core').locator('#encoders').click();
  await page.waitForFunction(()=>document.querySelector('#encoderSelect').value==='jpeg');
  assert.deepEqual(await page.locator('#encoderSelect option').evaluateAll(options=>options.map(o=>o.value)), ['jpeg']);
  await page.frameLocator('#jolee-core').locator('#lost').click();
  await page.waitForFunction(()=>document.querySelector('#encoderSelect').value==='');
  assert.deepEqual(await page.locator('#encoderSelect option').evaluateAll(options=>options.map(o=>o.value)), ['']);
  await page.getByText('Screen Settings', { exact: true }).click();
  await page.locator('#uiScalingSelect').waitFor({ state: 'visible' });
  assert(await page.locator('#uiScalingSelect').isDisabled(), 'unknown DPI capability stays disabled');
  assert.equal(await page.locator('#useBrowserCursorsToggle').getAttribute('aria-pressed'),'false','desktop starts with drawn cursors');
  await page.waitForFunction(()=>document.querySelector('#jolee-core').contentWindow.cursorMode===false);
  assert(await page.getByRole('button', { name: 'Set to Best Fit', exact: true }).isDisabled());
  assert(await page.locator('#resolutionPresetSelect').isDisabled());
  await page.waitForTimeout(100);
  assert.deepEqual(errors, [], 'screen reset must not throw');
  assert(await page.locator('#uiScalingSelect').isDisabled());
  // Reported PC geometry, including a non-preset ultrawide mode, must be visible
  // without sending a resolution change or overwriting a manual draft.
  await page.frameLocator('#jolee-core').locator('#custom').click();
  await page.waitForFunction(()=>document.querySelector('#manualWidthInput').value==='3440');
  assert.equal(await page.locator('#manualHeightInput').inputValue(),'1440');
  await page.locator('#manualWidthInput').fill('1555');
  await page.frameLocator('#jolee-core').locator('#current').click();
  await page.waitForFunction(()=>document.querySelector('#resolutionPresetSelect').value==='1920x1200');
  assert.match(await page.locator('#resolutionPresetSelect option:checked').innerText(),/Current/);
  assert.equal(await page.locator('#manualWidthInput').inputValue(),'1555');
  await page.frameLocator('#jolee-core').locator('#custom').click();
  await page.waitForFunction(()=>document.querySelector('#resolutionPresetSelect').value==='3440x1440');
  await page.frameLocator('#jolee-core').locator('#unknown').click();
  await page.waitForFunction(()=>document.querySelector('#resolutionPresetSelect').value==='');
  assert(await page.getByRole('button', {name:'Set to Best Fit',exact:true}).isDisabled());
  await page.frameLocator('#jolee-core').locator('#current').click();
  await page.getByRole('button', {name:'Set to Best Fit',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#manualWidthInput').value==='1920');
  assert.equal(await page.locator('#manualHeightInput').inputValue(),'1200');
  assert(await page.locator('#resolutionPresetSelect option[value="7680x4320"]').isDisabled());
  assert.match(await page.locator('#resolutionPresetSelect option[value="7680x4320"]').innerText(),/capture limit/);
  await page.waitForFunction(()=>document.querySelector('#jolee-core').contentWindow.displayRequests.length===1);
  assert.equal(await page.frameLocator('#jolee-core').locator('body').evaluate(()=>window.displayRequests[0].type),'setBestFit');
  await page.frameLocator('#jolee-core').locator('#removed').click();
  await page.getByText('The selected monitor is disconnected. Select an available monitor.',{exact:true}).waitFor();
  assert(await page.getByRole('button',{name:'Set to Best Fit',exact:true}).isDisabled());
  assert.equal(await page.locator('#remoteDisplaySelect').isDisabled(),false);
  await page.locator('#remoteDisplaySelect').selectOption('1'.padStart(32,'0'));
  await page.waitForFunction(()=>document.querySelector('#jolee-core').contentWindow.displayRequests.length===2);
  assert.equal(await page.frameLocator('#jolee-core').locator('body').evaluate(()=>window.displayRequests[1].type),'selectRemoteDisplay');
  // Touch users need an actual notice: a hover-only disabled title cannot help.
  await page.setViewportSize({width:390,height:844});
  await page.getByTitle('Microphone forwarding requires a connected PC with confirmed support.',{exact:true}).first().click();
  assert.match(await page.locator('.notification-item').filter({hasText:'Microphone'}).last().innerText(),/cannot send it to Windows yet/);
  await page.getByTitle('The PC has not confirmed webcam forwarding support.',{exact:true}).click();
  assert.match(await page.locator('.notification-item').filter({hasText:'Camera'}).last().innerText(),/cannot send it to Windows yet/);
  await page.frameLocator('#jolee-core').locator('#camera').click();
  await page.locator('[data-webcam-state="waiting"]').waitFor();
  assert.match(await page.locator('[data-webcam-state="waiting"]').getAttribute('title'),/PC camera: waiting/);
  await page.frameLocator('#jolee-core').locator('#unknown').click();
  await page.locator('[data-webcam-state="unknown"]').waitFor();
  await page.getByText('Shortcuts',{exact:true}).click();
  await page.frameLocator('#jolee-core').locator('#securefail').click();
  const shortcut=page.getByRole('button',{name:'Ctrl + Alt + Del',exact:true});
  await page.waitForFunction(()=>document.querySelector('#shortcuts-content button').title.includes('stopped unexpectedly'));
  assert(await shortcut.isDisabled());
  await page.waitForTimeout(11000);
  const failure=page.locator('.notification-item').filter({hasText:'The secure-screen helper stopped unexpectedly.'});
  assert.equal(await failure.count(),1,'failure must survive the previous warning timer');
  assert.match(await shortcut.getAttribute('title'),/Return to the normal desktop was not verified/);
  await page.frameLocator('#jolee-core').locator('#sasnext').click();
  await page.waitForFunction(()=>document.querySelector('#shortcuts-content button').title==='Waiting for the PC response');
  assert.equal(await failure.count(),0,'new command clears previous failure');
  assert.deepEqual(errors,[]);
  // Explicit choices survive reload; touch clients get a drawn default until
  // they choose otherwise. Only a preference is replayed into the core.
  await page.locator('#useBrowserCursorsToggle').click();
  await page.waitForFunction(()=>document.querySelector('#jolee-core').contentWindow.cursorMode===true);
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#jolee-core').contentWindow.cursorMode===true);
  const mobileContext=await browser.newContext({hasTouch:true,isMobile:true,viewport:{width:390,height:844}});
  try {
    await mobileContext.route('**/*',route=>route.request().url().startsWith(`${origin}/`)?route.continue():route.abort());
    const mobile=await mobileContext.newPage();mobile.setDefaultTimeout(10000);
    mobile.on('pageerror',error=>errors.push(error.message));
    await mobile.goto(origin);
    await mobile.waitForFunction(()=>document.querySelector('#jolee-core').contentWindow.cursorMode===false);
    await mobile.locator('.toggle-handle').click();
    await mobile.getByText('Screen Settings',{exact:true}).click();
    assert.equal(await mobile.locator('#useBrowserCursorsToggle').getAttribute('aria-pressed'),'false');
    await mobile.locator('#useBrowserCursorsToggle').click();
    await mobile.waitForFunction(()=>document.querySelector('#jolee-core').contentWindow.cursorMode===true);
    await mobile.reload();
    await mobile.waitForFunction(()=>document.querySelector('#jolee-core').contentWindow.cursorMode===true);
  } finally {await mobileContext.close();}
  assert.deepEqual(errors,[]);
  console.log('Built dashboard mount/reset, effective presets, preserved draft and mobile media notices PASS (no remote session).');
} finally {
  try {
    await browser?.close();
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
