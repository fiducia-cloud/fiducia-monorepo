import assert from 'node:assert/strict';
import test from 'node:test';
import {
  artifactPath,
  assertInPageBoundaries,
  assertMainResponse,
  assertNoBrowserErrors,
  contractEnabled,
  harnessHtml,
  startHarnessServer,
  writeArtifact,
} from '../support/harness-contract.mjs';

test('local harness enforces HTTP and security boundaries', { timeout: 10_000 }, async () => {
  const harness = await startHarnessServer();
  try {
    const response = await fetch(harness.origin, { redirect: 'error' });
    assertMainResponse(response.status, Object.fromEntries(response.headers.entries()));
    assert.equal(await response.text(), harnessHtml);

    const head = await fetch(harness.origin, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    const rejected = await fetch(`${harness.origin}/healthz`, { method: 'POST' });
    assert.equal(rejected.status, 405);
    assert.equal(rejected.headers.get('allow'), 'GET, HEAD');

    const missing = await fetch(`${harness.origin}/missing`);
    assert.equal(missing.status, 404);
  } finally {
    await harness.close();
  }
});

test('Playwright satisfies the browser harness contract', { skip: !contractEnabled, timeout: 45_000 }, async () => {
  const { chromium } = await import('playwright');
  const harness = await startHarnessServer();
  let browser;
  let page;
  const errors = [];

  try {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

    const response = await page.goto(harness.origin, { waitUntil: 'networkidle', timeout: 15_000 });
    assert(response, 'navigation did not return a response');
    assertMainResponse(response.status(), await response.allHeaders());
    await page.waitForFunction(() => document.querySelector('#state')?.textContent === 'ready');
    assert.equal(await page.title(), 'E2E Harness Contract');
    await page.click('#increment');
    await page.click('#increment');
    assert.equal(await page.textContent('#count'), '2');
    await assertInPageBoundaries((fn) => page.evaluate(fn));
    assertNoBrowserErrors(errors);
  } finally {
    if (page) {
      await Promise.allSettled([
        page.screenshot({ path: await artifactPath('playwright', 'harness-contract.png'), fullPage: true }),
        page.content().then((content) => writeArtifact('playwright', 'page.html', content)),
        writeArtifact('playwright', 'browser-errors.json', JSON.stringify(errors, null, 2)),
      ]);
      await page.close().catch(() => {});
    }
    await browser?.close().catch(() => {});
    await harness.close();
  }
});
