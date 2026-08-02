import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { launchSelenium } from "../src/browser.mjs";
import { seleniumRemoteUrl } from "../src/selenium-url.mjs";

const artifactDir = resolve(
  process.env.FIDUCIA_E2E_ARTIFACT_DIR || "artifacts/selenium-grid",
);
await mkdir(artifactDir, { recursive: true });

const grid = seleniumRemoteUrl();
let session;
try {
  const gridStatus = await waitForReadyGrid(grid);
  session = await launchSelenium();
  const { driver } = session;

  const document = `<!doctype html>
<meta charset="utf-8">
<title>Fiducia Selenium Grid smoke</title>
<main id="proof" data-contract="remote-webdriver">grid ready</main>`;
  await driver.get(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`);

  assert.equal(await driver.getTitle(), "Fiducia Selenium Grid smoke");
  assert.equal(
    await driver.executeScript("return document.querySelector('#proof')?.dataset.contract"),
    "remote-webdriver",
  );
  assert.equal(
    await driver.executeScript("return navigator.webdriver"),
    true,
    "browser session is not exposing the WebDriver automation contract",
  );

  const capabilities = await driver.getCapabilities();
  const screenshot = await driver.takeScreenshot();
  await writeFile(`${artifactDir}/grid-smoke.png`, screenshot, "base64");
  await writeFile(
    `${artifactDir}/summary.json`,
    `${JSON.stringify({
      ok: true,
      gridReady: gridStatus.value?.ready === true,
      browserName: capabilities.get("browserName") ?? null,
      browserVersion: capabilities.get("browserVersion") ?? null,
      platformName: capabilities.get("platformName") ?? null,
      acceptInsecureCerts: capabilities.get("acceptInsecureCerts") ?? null,
    }, null, 2)}\n`,
  );
  console.log("Selenium Grid smoke passed");
} catch (error) {
  await writeFile(
    `${artifactDir}/summary.json`,
    `${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`,
  );
  throw error;
} finally {
  await session?.close();
}

async function waitForReadyGrid(endpoint) {
  let lastReason = "Grid did not answer";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/status`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) {
        lastReason = `HTTP ${response.status}`;
      } else {
        const body = await response.json();
        if (body?.value?.ready === true) return body;
        lastReason = "value.ready was not true";
      }
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error(`Selenium Grid readiness failed: ${lastReason}`);
}
