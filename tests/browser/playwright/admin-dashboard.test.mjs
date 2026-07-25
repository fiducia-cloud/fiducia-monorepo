// Real-browser admin dashboard content over the composed web/auth stack,
// driven through PLAYWRIGHT. The Puppeteer/Selenium siblings certify the nav
// gating; this file goes deeper — it asserts each operator page renders its
// real server-side content (the page's <h1>) under an authenticated session,
// so a regression that leaves a page blank or mis-routed is caught.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { browserSkipReason, launchPlaywright } from "../../../src/browser.mjs";
import { bootWebAppStack, OPERATOR } from "../../../src/webapps.mjs";

const SKIP = browserSkipReason();

// Each operator page and the server-rendered heading it must show (views.rs).
const ADMIN_PAGES = [
  { path: "/", h1: "Dashboard" },
  { path: "/infra", h1: "Cluster & infra" },
  { path: "/cluster", h1: "Cluster insight" },
  { path: "/audit", h1: "Operator audit" },
  { path: "/notices", h1: "Broadcast notices" },
];

describe("real-browser admin dashboard content (Playwright)", { skip: SKIP, concurrency: 1 }, () => {
  /** @type {Awaited<ReturnType<typeof bootWebAppStack>>} */
  let stack;
  /** @type {Awaited<ReturnType<typeof launchPlaywright>>} */
  let pw;

  before(async () => {
    stack = await bootWebAppStack();
    pw = await launchPlaywright();
  }, { timeout: 900_000 });

  after(async () => {
    await pw?.close();
    await stack?.stop();
  }, { timeout: 120_000 });

  const adminUrl = (path = "") => `${stack.admin.url}${path}`;

  async function signIn(page) {
    await page.goto(adminUrl("/login"), { waitUntil: "domcontentloaded" });
    await page.fill('input[name="email"]', OPERATOR.email);
    await page.fill('input[name="password"]', OPERATOR.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click('form[action="/login"] button'),
    ]);
    assert.equal(new URL(page.url()).pathname, "/", "operator sign-in lands on the dashboard");
  }

  it("each operator page renders its real server-side heading under session", { timeout: 120_000 }, async () => {
    const context = await pw.browser.newContext();
    const page = await context.newPage();
    try {
      await signIn(page);
      for (const { path, h1 } of ADMIN_PAGES) {
        const response = await page.goto(adminUrl(path), { waitUntil: "domcontentloaded" });
        assert.ok(response.ok(), `${path}: serves under session (HTTP ${response.status()})`);
        assert.equal(new URL(page.url()).pathname, path, `${path}: stays on the page`);
        const heading = (await page.textContent("h1"))?.trim();
        assert.equal(heading, h1, `${path}: renders the "${h1}" heading`);
        assert.ok(await page.$("nav.nav"), `${path}: renders the operator nav chrome`);
      }
    } finally {
      await context.close();
    }
  });

  it("the operator identity is shown and the sign-out control is present", { timeout: 60_000 }, async () => {
    const context = await pw.browser.newContext();
    const page = await context.newPage();
    try {
      await signIn(page);
      assert.match(await page.content(), /operator/i, "the dashboard names the signed-in operator");
      assert.ok(await page.$('form[action="/logout"] button'), "a sign-out control is offered");
    } finally {
      await context.close();
    }
  });
});
