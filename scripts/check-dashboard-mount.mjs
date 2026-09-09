import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Exercise the shipped bundle, not the Vite development module graph. This
// fixture has no agent, credentials, microphone permission or remote session.
const bundle = await readFile(new URL('../public/dashboard/dashboard.js', import.meta.url));
const css = await readFile(new URL('../public/dashboard/dashboard.css', import.meta.url));
const shell = '<!doctype html><html><head><link rel="stylesheet" href="/dashboard.css"></head>'
  + '<body><div id="root"></div><iframe id="jolee-core" src="/core"></iframe>'
  + '<script type="module" src="/dashboard.js"></script></body></html>';
const server = createServer((req, res) => {
  const routes = {
    '/': ['text/html', shell], '/core': ['text/html', '<!doctype html><title>Inert core fixture</title>'],
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
  console.log('Built dashboard mount, screen panel and reset PASS (no remote session).');
} finally {
  try {
    await browser?.close();
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
