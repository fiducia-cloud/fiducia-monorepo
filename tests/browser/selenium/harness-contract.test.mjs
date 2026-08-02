import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import {
  contractEnabled,
  screenshotPath,
  startHarnessServer,
} from '../support/harness-contract.mjs';

test('Selenium satisfies the browser harness contract', { skip: !contractEnabled, timeout: 45_000 }, async () => {
  const [{ Builder, By, until }, { default: chrome }] = await Promise.all([
    import('selenium-webdriver'),
    import('selenium-webdriver/chrome.js'),
  ]);
  const harness = await startHarnessServer();
  const options = new chrome.Options();
  options.addArguments(
    '--headless=new',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1280,720',
  );
  const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();

  try {
    await driver.manage().setTimeouts({ implicit: 0, pageLoad: 15_000, script: 15_000 });
    await driver.get(harness.origin);
    const state = await driver.wait(until.elementLocated(By.id('state')), 10_000);
    await driver.wait(until.elementTextIs(state, 'ready'), 10_000);
    assert.equal(await driver.getTitle(), 'E2E Harness Contract');
    const increment = await driver.findElement(By.id('increment'));
    await increment.click();
    await increment.click();
    assert.equal(await driver.findElement(By.id('count')).getText(), '2');
    assert.equal(await driver.executeScript('return document.cookie'), '', 'HttpOnly cookie leaked into document.cookie');
    const health = await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      fetch('/healthz').then((response) => response.text()).then(done, (error) => done('ERROR:' + error.message));
    `);
    assert.equal(health, 'ok');
    await writeFile(await screenshotPath('selenium'), await driver.takeScreenshot(), 'base64');
  } finally {
    await driver.quit().catch(() => {});
    await harness.close();
  }
});
