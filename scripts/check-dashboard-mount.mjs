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
<script>
const sizes={current:{width:1920,height:1200},custom:{width:3440,height:1440},unknown:null};
for(const id of Object.keys(sizes))document.getElementById(id).onclick=()=>parent.postMessage({type:'statsUpdate',screen:{effective:sizes[id]},microphone_supported:false,webcam_supported:false},location.origin);
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
  await page.getByText('Screen Settings', { exact: true }).click();
  await page.locator('#uiScalingSelect').waitFor({ state: 'visible' });
  assert(await page.locator('#uiScalingSelect').isDisabled(), 'unknown DPI capability stays disabled');
  await page.getByRole('button', { name: 'Reset to Window', exact: true }).click();
  await page.waitForTimeout(600);
  assert.deepEqual(errors, [], 'screen reset must not throw');
  assert(await page.locator('#uiScalingSelect').isDisabled());
  // Reported PC geometry, including a non-preset ultrawide mode, must be visible
  // without sending a resolution change or overwriting a manual draft.
  await page.locator('#manualWidthInput').fill('1555');
  await page.frameLocator('#jolee-core').locator('#current').click();
  await page.waitForFunction(()=>document.querySelector('#resolutionPresetSelect').value==='1920x1200');
  assert.match(await page.locator('#resolutionPresetSelect option:checked').innerText(),/Current/);
  assert.equal(await page.locator('#manualWidthInput').inputValue(),'1555');
  await page.frameLocator('#jolee-core').locator('#custom').click();
  await page.waitForFunction(()=>document.querySelector('#resolutionPresetSelect').value==='3440x1440');
  await page.frameLocator('#jolee-core').locator('#unknown').click();
  await page.waitForFunction(()=>document.querySelector('#resolutionPresetSelect').value==='');
  // Touch users need an actual notice: a hover-only disabled title cannot help.
  await page.setViewportSize({width:390,height:844});
  await page.getByTitle('Microphone forwarding requires a connected PC with confirmed support.',{exact:true}).first().click();
  assert.match(await page.locator('.notification-item').filter({hasText:'Microphone'}).last().innerText(),/cannot send it to Windows yet/);
  await page.getByTitle('The PC has not confirmed webcam forwarding support.',{exact:true}).click();
  assert.match(await page.locator('.notification-item').filter({hasText:'Camera'}).last().innerText(),/cannot send it to Windows yet/);
  assert.deepEqual(errors,[]);
  console.log('Built dashboard mount/reset, effective presets, preserved draft and mobile media notices PASS (no remote session).');
} finally {
  try {
    await browser?.close();
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
