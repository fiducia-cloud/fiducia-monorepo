// Browser-driven multicluster: every cluster in the validated topology must
// serve its health surface to a REAL browser (Selenium). The journey is
// shared (src/browser-endpoints.mjs) so all three automation stacks certify
// identical cross-cluster behavior.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { launchSelenium, seleniumSkipReason } from "../../../src/browser.mjs";
import { browserMulticlusterJourney, multiclusterSkip } from "../../../src/browser-endpoints.mjs";

const SKIP = await seleniumSkipReason({ requireStack: false }) || multiclusterSkip();

describe("browser multicluster (Selenium)", { skip: SKIP, concurrency: 1 }, () => {
  let session;

  before(async () => {
    session = await launchSelenium();
  }, { timeout: 120_000 });
  after(async () => {
    await session?.close();
  });

  async function navigate(url) {
    await session.driver.get(url);
    return session.driver.findElement(session.By.css("body")).getText();
  }

  it("every cluster serves its health surface to the browser", { timeout: 300_000 }, async () => {
    const outcome = await browserMulticlusterJourney(navigate);
    assert.ok(outcome.clusters >= 2, "journey must cover every topology cluster");
  });
});
