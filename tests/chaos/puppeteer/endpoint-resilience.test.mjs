// Browser-driven chaos: every deployed endpoint must serve its health surface
// to a REAL browser (Puppeteer), and — when disruptive chaos is allowed —
// keep serving the surviving endpoints while one cluster is down, then
// recover. The journey itself lives in src/browser-endpoints.mjs so Selenium,
// Playwright, and Puppeteer certify identical behavior.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { browserSkipReason, launchPuppeteer } from "../../../src/browser.mjs";
import { browserChaosJourney, chaosEndpointSkip } from "../../../src/browser-endpoints.mjs";

const SKIP = browserSkipReason({ requireStack: false }) || chaosEndpointSkip();

describe("browser chaos (Puppeteer)", { skip: SKIP, concurrency: 1 }, () => {
  let session;

  before(async () => {
    session = await launchPuppeteer();
  }, { timeout: 120_000 });
  after(async () => {
    await session?.close();
  });

  async function navigate(url) {
    const response = await session.page.goto(url, { waitUntil: "domcontentloaded" });
    assert.ok(response.ok(), `${url}: HTTP ${response.status()} through the browser`);
    return session.page.$eval("body", (el) => el.textContent ?? "");
  }

  it("health surfaces stay browser-servable across disruption", { timeout: 600_000 }, async (t) => {
    const outcome = await browserChaosJourney(t, navigate);
    assert.ok(outcome.endpoints >= 2, "journey must cover the configured endpoints");
  });
});
