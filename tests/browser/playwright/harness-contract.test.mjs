import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertNoBrowserErrors,
  contractEnabled,
  screenshotPath,
  startHarnessServer,
} from '../support/harness-contract.mjs';

test('Playwright satisfies the browser harness contract', { skip: !contractEnabled, timeout: 30_000 }, async () => {
  const { chromium } = await import('playwright');
  const harness = await startHarnessServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

  try {
    const response = await page.goto(harness.origin, { waitUntil: 'networkidle', timeout: 15_000 });
    assert.equal(response?.status(), 200);
    await page.waitForFunction(() => document.querySelector('#state')?.textContent === 'ready');
    assert.equal(await page.title(), 'E2E Harness Contract');
    await page.click('#increment');
    await page.click('#increment');
    assert.equal(await page.textContent('#count'), '2');
    assert.equal(await page.evaluate(() => document.cookie), '', 'HttpOnly cookie leaked into document.cookie');
    assert.equal(await page.evaluate(() => fetch('/healthz').then((result) => result.text())), 'ok');
    await page.screenshot({ path: await screenshotPath('playwright'), fullPage: true });
    assertNoBrowserErrors(errors);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    await harness.close();
  }
});
