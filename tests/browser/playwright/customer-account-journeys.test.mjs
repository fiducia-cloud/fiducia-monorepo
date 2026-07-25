// Real-browser customer account journeys over the composed web/auth stack:
// the Settings/preferences, Activity, and Notifications surfaces a signed-in
// customer manages, exercised end to end through Chromium against the real
// fiducia-customer.rs server. Complements the login/MFA (auth) and API-key
// (integration) journeys with the account-management product flows.
//
// These surfaces are htmx-enhanced shells; htmx is neutralised for
// deterministic navigation. The data fragments (preferences/activity/notices)
// are DB-backed and need a seeded customer DB the composed stub stack does not
// provide, so this file certifies what the stack robustly supports: the
// authenticated page shell + active-tab nav, the fragments' auth boundary, and
// signed-out gating. (The API-key journeys cover an auth-backed fragment that
// does round-trip fully.)

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { browserSkipReason, launchPlaywright } from "../../../src/browser.mjs";
import { bootWebAppStack, CUSTOMER } from "../../../src/webapps.mjs";

const SKIP = browserSkipReason();
const HTMX_ASSET = "/assets/htmx.min.js";

describe("real-browser customer account journeys (Playwright)", { skip: SKIP, concurrency: 1 }, () => {
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

  const customerUrl = (path = "") => `${stack.backend.url}${path}`;

  async function pwPage() {
    const context = await pw.browser.newContext();
    await context.route(
      (url) => url.pathname.endsWith(HTMX_ASSET),
      (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "" }),
    );
    const page = await context.newPage();
    return { context, page, close: () => context.close() };
  }

  async function signInWithPassword(page, user) {
    await page.goto(customerUrl("/login"), { waitUntil: "domcontentloaded" });
    await page.waitForSelector('form[action="/login"] input[name="email"]');
    await page.fill('form[action="/login"] input[name="email"]', user.email);
    await page.fill('form[action="/login"] input[name="password"]', user.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click('form[action="/login"] button[type="submit"]'),
    ]);
    assert.equal(new URL(page.url()).pathname, "/app", "sign-in lands on /app");
  }

  // The account pages (Settings/Activity/Notifications) are shells whose data
  // fragments are DB-backed; in the composed stub stack those fragments need a
  // seeded customer DB, so we certify what the stack robustly supports: the
  // authenticated shell + nav, and the security boundary on the fragments.
  const ACCOUNT_PAGES = [
    { path: "/app/settings", title: "Settings" },
    { path: "/app/activity", title: "Activity" },
    { path: "/app/notifications", title: "Notifications" },
  ];

  it("each account page serves the authenticated dashboard shell with its active tab", { timeout: 90_000 }, async () => {
    const { page, close } = await pwPage();
    try {
      await signInWithPassword(page, CUSTOMER);
      for (const { path, title } of ACCOUNT_PAGES) {
        const response = await page.goto(customerUrl(path), { waitUntil: "domcontentloaded" });
        assert.ok(response.ok(), `${path}: serves under session (HTTP ${response.status()})`);
        assert.equal(new URL(page.url()).pathname, path, `${path}: stays on the page, not bounced`);
        assert.ok(await page.$("header.topbar"), `${path}: renders the dashboard chrome`);
        // The nav marks the current tab active (aria-current="page").
        const current = await page.$eval("nav", (nav) => {
          const active = nav.querySelector('a[aria-current="page"]');
          return active ? active.textContent.trim() : null;
        }).catch(() => null);
        assert.equal(current, title, `${path}: the nav highlights the ${title} tab`);
      }
    } finally {
      await close();
    }
  });

  it("account data fragments are auth-gated: an anonymous fetch is refused customer data", { timeout: 60_000 }, async () => {
    const { page, close } = await pwPage();
    try {
      // A fresh (never-signed-in) page: fetching the fragment endpoints directly
      // must NOT serve customer data — the server redirects/denies.
      await page.goto(customerUrl("/login"), { waitUntil: "domcontentloaded" });
      for (const frag of ["/app/fragments/preferences", "/app/fragments/activity", "/app/fragments/notifications"]) {
        const probe = await page.evaluate(async (url) => {
          const res = await fetch(url, { redirect: "manual" });
          return { status: res.status, type: res.type };
        }, frag);
        // Either an explicit auth failure, or an opaque redirect to /login — never a 2xx data fragment.
        assert.ok(
          probe.status === 0 || probe.type === "opaqueredirect" || probe.status === 401 ||
            probe.status === 403 || (probe.status >= 300 && probe.status < 400),
          `${frag}: an anonymous fetch must not return a 2xx data fragment (got ${probe.status}/${probe.type})`,
        );
      }
    } finally {
      await close();
    }
  });

  it("account deep links are gated: signed-out visits bounce to /login", { timeout: 60_000 }, async () => {
    const { page, close } = await pwPage();
    try {
      for (const path of ["/app/settings", "/app/activity", "/app/notifications"]) {
        await page.goto(customerUrl(path), { waitUntil: "domcontentloaded" });
        assert.match(new URL(page.url()).pathname, /\/login$/, `${path} redirects an anonymous visitor to /login`);
      }
    } finally {
      await close();
    }
  });
});
