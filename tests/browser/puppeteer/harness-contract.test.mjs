import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertNoBrowserErrors,
  contractEnabled,
  screenshotPath,
  startHarnessServer,
} from '../support/harness-contract.mjs';

test('Puppeteer satisfies the browser harness contract', { skip: !contractEnabled, timeout: 30_000 }, async () => {
  const { default: puppeteer } = await import('puppeteer');
  const harness = await startHarnessServer();
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

  try {
    const response = await page.goto(harness.origin, { waitUntil: 'networkidle0' });
    assert.equal(response?.status(), 200);
    await page.waitForFunction(() => document.querySelector('#state')?.textContent === 'ready');
    assert.equal(await page.title(), 'E2E Harness Contract');
    await page.click('#increment');
    await page.click('#increment');
    assert.equal(await page.$eval('#count', (element) => element.textContent), '2');
    assert.equal(await page.evaluate(() => document.cookie), '', 'HttpOnly cookie leaked into document.cookie');
    assert.equal(await page.evaluate(() => fetch('/healthz').then((result) => result.text())), 'ok');
    await page.screenshot({ path: await screenshotPath('puppeteer'), fullPage: true });
    assertNoBrowserErrors(errors);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    await harness.close();
  }
});
