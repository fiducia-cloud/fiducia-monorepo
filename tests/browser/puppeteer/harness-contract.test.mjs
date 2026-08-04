import assert from 'node:assert/strict';
import test from 'node:test';
import {
  artifactPath,
  assertInPageBoundaries,
  assertMainResponse,
  assertNoBrowserErrors,
  contractEnabled,
  startHarnessServer,
  writeArtifact,
} from '../support/harness-contract.mjs';

test('Puppeteer satisfies the browser harness contract', { skip: !contractEnabled, timeout: 45_000 }, async () => {
  const { default: puppeteer } = await import('puppeteer');
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  assert(executablePath, 'PUPPETEER_EXECUTABLE_PATH must identify the CI Chrome binary');

  const harness = await startHarnessServer();
  let browser;
  let page;
  const errors = [];

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    page.setDefaultNavigationTimeout(15_000);
    page.setDefaultTimeout(15_000);
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

    const response = await page.goto(harness.origin, { waitUntil: 'networkidle0' });
    assert(response, 'navigation did not return a response');
    assertMainResponse(response.status(), response.headers());
    await page.waitForFunction(() => document.querySelector('#state')?.textContent === 'ready');
    assert.equal(await page.title(), 'E2E Harness Contract');
    await page.click('#increment');
    await page.click('#increment');
    assert.equal(await page.$eval('#count', (element) => element.textContent), '2');
    await assertInPageBoundaries((fn) => page.evaluate(fn));
    assertNoBrowserErrors(errors);
  } finally {
    if (page) {
      await Promise.allSettled([
        page.screenshot({ path: await artifactPath('puppeteer', 'harness-contract.png'), fullPage: true }),
        page.content().then((content) => writeArtifact('puppeteer', 'page.html', content)),
        writeArtifact('puppeteer', 'browser-errors.json', JSON.stringify(errors, null, 2)),
      ]);
      await page.close().catch(() => {});
    }
    await browser?.close().catch(() => {});
    await harness.close();
  }
});
