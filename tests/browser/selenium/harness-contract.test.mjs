import assert from "node:assert/strict";
import test from "node:test";
import {
  assertInPageBoundaries,
  assertNoBrowserErrors,
  contractEnabled,
  startHarnessServer,
  writeArtifact,
} from "../support/harness-contract.mjs";

test(
  "Selenium satisfies the browser harness contract",
  { skip: !contractEnabled, timeout: 45_000 },
  async () => {
    const [webdriver, chromeModule, loggingModule] = await Promise.all([
      import("selenium-webdriver"),
      import("selenium-webdriver/chrome.js"),
      import("selenium-webdriver/lib/logging.js"),
    ]);
    const { Builder, By, until } = webdriver;
    const chrome = chromeModule.default ?? chromeModule;
    const logging = loggingModule.default ?? loggingModule;
    const chromeBinary = process.env.E2E_BROWSER_CHROME_PATH;
    const chromeDriver = process.env.E2E_BROWSER_CHROMEDRIVER_PATH;
    assert(chromeBinary, "E2E_BROWSER_CHROME_PATH must identify CI Chrome");
    assert(
      chromeDriver,
      "E2E_BROWSER_CHROMEDRIVER_PATH must identify CI ChromeDriver",
    );

    const preferences = new logging.Preferences();
    preferences.setLevel(logging.Type.BROWSER, logging.Level.ALL);

    const harness = await startHarnessServer();
    const options = new chrome.Options();
    options.setChromeBinaryPath(chromeBinary);
    options.addArguments(
      "--headless=new",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1280,720",
    );
    const service = new chrome.ServiceBuilder(chromeDriver);

    let driver;
    let testError;
    const browserErrors = [];

    try {
      driver = await new Builder()
        .forBrowser("chrome")
        .setLoggingPrefs(preferences)
        .setChromeOptions(options)
        .setChromeService(service)
        .build();
      await driver.manage().setTimeouts({
        implicit: 0,
        pageLoad: 15_000,
        script: 15_000,
      });
      await driver.get(harness.origin);
      const state = await driver.wait(
        until.elementLocated(By.id("state")),
        10_000,
      );
      await driver.wait(until.elementTextIs(state, "ready"), 10_000);
      assert.equal(await driver.getTitle(), "E2E Harness Contract");
      const increment = await driver.findElement(By.id("increment"));
      await increment.click();
      await increment.click();
      assert.equal(await driver.findElement(By.id("count")).getText(), "2");
      await assertInPageBoundaries((fn) =>
        driver.executeAsyncScript(`
          const done = arguments[arguments.length - 1];
          (${fn.toString()})().then(done, (error) => done({ contractError: error.message }));
        `),
      );
    } catch (error) {
      testError = error;
    } finally {
      if (driver) {
        const entries = await driver
          .manage()
          .logs()
          .get(logging.Type.BROWSER)
          .catch((error) => {
            browserErrors.push(`webdriver-log: ${error.message}`);
            return [];
          });
        browserErrors.push(
          ...entries
            .filter(
              (entry) => entry.level.value >= logging.Level.SEVERE.value,
            )
            .map((entry) => `${entry.level.name}: ${entry.message}`),
        );
        await Promise.allSettled([
          driver
            .takeScreenshot()
            .then((png) =>
              writeArtifact(
                "selenium",
                "harness-contract.png",
                png,
                "base64",
              ),
            ),
          driver
            .getPageSource()
            .then((source) =>
              writeArtifact("selenium", "page.html", source),
            ),
          writeArtifact(
            "selenium",
            "browser-errors.json",
            JSON.stringify(browserErrors, null, 2),
          ),
        ]);
        await driver.quit().catch(() => {});
      } else {
        await writeArtifact(
          "selenium",
          "browser-errors.json",
          JSON.stringify(browserErrors, null, 2),
        );
      }
      await harness.close();
    }

    if (testError) throw testError;
    assertNoBrowserErrors(browserErrors);
  },
);
