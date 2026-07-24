// Browser-driven multicluster: every cluster in the validated topology must
// serve its health surface to a REAL browser (Playwright). The journey is
// shared (src/browser-endpoints.mjs) so all three automation stacks certify
// identical cross-cluster behavior.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { browserSkipReason, launchPlaywright } from "../../../src/browser.mjs";
import { browserMulticlusterJourney, multiclusterSkip } from "../../../src/browser-endpoints.mjs";

const SKIP = browserSkipReason({ requireStack: false }) || multiclusterSkip();

describe("browser multicluster (Playwright)", { skip: SKIP, concurrency: 1 }, () => {
  let session;

  before(async () => {
    session = await launchPlaywright();
  }, { timeout: 120_000 });
  after(async () => {
    await session?.close();
  });

  async function navigate(url) {
    const response = await session.page.goto(url, { waitUntil: "domcontentloaded" });
    assert.ok(response.ok(), `${url}: HTTP ${response.status()} through the browser`);
    return (await session.page.textContent("body")) ?? "";
  }

  it("every cluster serves its health surface to the browser", { timeout: 300_000 }, async () => {
    const outcome = await browserMulticlusterJourney(navigate);
    assert.ok(outcome.clusters >= 2, "journey must cover every topology cluster");
  });
});
