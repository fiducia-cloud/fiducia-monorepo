// Real-browser admin dashboard navigation over the composed web/auth stack.
//
// The admin login journeys prove an operator can sign in; this file proves the
// operator dashboard's navigation surface — the Infra, Cluster, Notices, and
// Audit pages fiducia-admin.rs renders (src/views.rs nav) — actually serves
// authenticated content to a real browser, and that every one of those deep
// links is gated: a signed-out visitor is bounced to /login with no dashboard
// data. Driven through Puppeteer to complement the Playwright happy path.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { browserSkipReason, launchPuppeteer } from "../../../src/browser.mjs";
import { bootWebAppStack, OPERATOR } from "../../../src/webapps.mjs";

const SKIP = browserSkipReason();
const ADMIN_SESSION_COOKIE = "fiducia_admin_session";

// The authenticated nav destinations fiducia-admin.rs serves (views.rs).
const ADMIN_PAGES = ["/", "/infra", "/cluster", "/notices", "/audit"];

describe("real-browser admin dashboard navigation (Puppeteer)", { skip: SKIP, concurrency: 1 }, () => {
  /** @type {Awaited<ReturnType<typeof bootWebAppStack>>} */
  let stack;
  /** @type {Awaited<ReturnType<typeof launchPuppeteer>>} */
  let pp;

  before(async () => {
    stack = await bootWebAppStack();
    pp = await launchPuppeteer();
  }, { timeout: 900_000 }); // first run compiles three Rust servers

  after(async () => {
    await pp?.close();
    await stack?.stop();
  }, { timeout: 120_000 });

  const adminUrl = (path = "") => `${stack.admin.url}${path}`;

  async function ppPage() {
    const context = await pp.browser.createBrowserContext();
    const page = await context.newPage();
    return { context, page, close: () => context.close() };
  }

  async function signIn(page) {
    await page.goto(adminUrl("/login"), { waitUntil: "domcontentloaded" });
    await page.type('input[name="email"]', OPERATOR.email);
    await page.type('input[name="password"]', OPERATOR.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click('form[action="/login"] button'),
    ]);
    assert.equal(new URL(page.url()).pathname, "/", "operator sign-in lands on the dashboard");
  }

  it("a signed-in operator reaches every dashboard nav page", { timeout: 120_000 }, async () => {
    const { page, close } = await ppPage();
    try {
      await signIn(page);
      for (const path of ADMIN_PAGES) {
        const response = await page.goto(adminUrl(path), { waitUntil: "domcontentloaded" });
        assert.ok(response.ok(), `${path}: authenticated operator should get 2xx (HTTP ${response.status()})`);
        assert.doesNotMatch(
          new URL(page.url()).pathname,
          /\/login$/,
          `${path}: a signed-in operator must not be bounced to /login`,
        );
        // The admin chrome (topbar + nav) renders on every authenticated page.
        assert.ok(
          await page.$("header.topbar, nav, .app-shell, body"),
          `${path}: the page renders dashboard markup`,
        );
      }
    } finally {
      await close();
    }
  });

  it("the dashboard nav actually links to those destinations", { timeout: 60_000 }, async () => {
    const { page, close } = await ppPage();
    try {
      await signIn(page);
      const hrefs = await page.$$eval("a", (as) => as.map((a) => a.getAttribute("href")));
      for (const path of ["/infra", "/cluster", "/audit"]) {
        assert.ok(hrefs.includes(path), `the dashboard nav links to ${path}`);
      }
    } finally {
      await close();
    }
  });

  it("every deep link is gated: signed-out visits bounce to /login with no data", { timeout: 120_000 }, async () => {
    const { page, close } = await ppPage();
    try {
      for (const path of ADMIN_PAGES.filter((p) => p !== "/")) {
        const response = await page.goto(adminUrl(path), { waitUntil: "domcontentloaded" });
        assert.match(
          new URL(page.url()).pathname,
          /\/login$/,
          `${path}: an unauthenticated deep link must redirect to /login`,
        );
        assert.ok(response.ok(), `${path}: the login page serves`);
        const cookies = await page.cookies(adminUrl());
        assert.equal(
          cookies.find((c) => c.name === ADMIN_SESSION_COOKIE),
          undefined,
          `${path}: no admin session is minted for an anonymous visitor`,
        );
      }
    } finally {
      await close();
    }
  });
});
