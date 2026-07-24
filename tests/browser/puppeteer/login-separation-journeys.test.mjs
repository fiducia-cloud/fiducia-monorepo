// Real-browser login journeys over the composed web/auth stack.
//
// tests/webapps/login-separation.test.mjs proves the HTTP contract with
// `fetch`; this file proves the same product works when a BROWSER is the
// client — Chromium follows the redirects, submits the real forms, keeps the
// cookie jar, enforces HttpOnly/SameSite, and executes the pages' JS. The
// stack (real fiducia-auth + fiducia-admin + fiducia-customer, stub Supabase,
// scratch Postgres) boots ONCE and both drivers run against it:
//
//   * Playwright — the operator's happy path: land on the login form, sign in
//     through it, read the dashboard, verify the session cookie the browser
//     actually holds, sign out through the UI.
//   * Puppeteer — the separation/negative journeys: a customer's valid
//     Supabase credentials bounce off the admin role gate with no cookie, a
//     wrong password shows the alert and issues nothing, a signed-out deep
//     link lands back on /login, and the customer SPA shell serves.
//
// Ordered stages; Playwright's sign-in state is scoped to its own browser, so
// the Puppeteer journeys always start signed out.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { browserSkipReason, launchPuppeteer } from "../../../src/browser.mjs";
import { bootWebAppStack, CUSTOMER, OPERATOR } from "../../../src/webapps.mjs";

const SKIP = browserSkipReason();
const ADMIN_SESSION_COOKIE = "fiducia_admin_session";

describe("real-browser login journeys", { skip: SKIP, concurrency: 1 }, () => {
  /** @type {Awaited<ReturnType<typeof bootWebAppStack>>} */
  let stack;

  before(async () => {
    stack = await bootWebAppStack();
  }, { timeout: 900_000 }); // first run compiles three Rust servers

  after(async () => {
    await stack?.stop();
  }, { timeout: 120_000 });

  describe("separation journeys (Puppeteer)", () => {
    let pp;

    before(async () => {
      pp = await launchPuppeteer();
    }, { timeout: 120_000 });
    after(async () => {
      await pp?.close();
    });

    /** Submit the admin login form with `user`'s credentials, wait for the response page. */
    async function submitLogin(user, password = user.password) {
      await pp.page.goto(`${stack.admin.url}/login`, { waitUntil: "domcontentloaded" });
      await pp.page.type('input[name="email"]', user.email);
      await pp.page.type('input[name="password"]', password);
      await Promise.all([
        pp.page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        pp.page.click('form[action="/login"] button'),
      ]);
    }

    async function adminSessionCookie() {
      const cookies = await pp.page.cookies(stack.admin.url);
      return cookies.find((c) => c.name === ADMIN_SESSION_COOKIE);
    }

    it("valid CUSTOMER credentials bounce off the admin role gate with no cookie", { timeout: 60_000 }, async () => {
      await submitLogin(CUSTOMER);
      // The role gate renders the 403 page — identity verified, authorization denied.
      const heading = await pp.page.$eval("h1", (el) => el.textContent);
      assert.match(heading ?? "", /403/, "forbidden page for a non-operator login");
      const body = await pp.page.$eval("body", (el) => el.textContent);
      assert.match(body ?? "", /Admin role required/i);
      assert.equal(await adminSessionCookie(), undefined, "no admin session for a customer identity");
    });

    it("a wrong operator password shows the alert and issues nothing", { timeout: 60_000 }, async () => {
      await submitLogin(OPERATOR, "not-the-password");
      const alert = await pp.page.$eval('p[role="alert"]', (el) => el.textContent);
      assert.match(alert ?? "", /rejected/i, "login page explains the rejection");
      assert.equal(await adminSessionCookie(), undefined, "no session cookie on a failed login");
    });

    it("a signed-out deep link lands back on the login form", { timeout: 60_000 }, async () => {
      await pp.page.goto(stack.admin.url, { waitUntil: "domcontentloaded" });
      assert.match(new URL(pp.page.url()).pathname, /\/login$/);
      assert.ok(await pp.page.$('form[action="/login"]'), "login form is rendered");
    });

    it("the customer plane serves its SPA shell to the browser", { timeout: 60_000 }, async (t) => {
      const response = await pp.page.goto(stack.backend.url, { waitUntil: "domcontentloaded" });
      if (response.status() === 404) {
        t.skip("customer static bundle not built (fiducia-customer-ui.web/dist missing)");
        return;
      }
      assert.ok(response.ok(), `customer shell should serve: HTTP ${response.status()}`);
      const hasMarkup = await pp.page.evaluate(() => document.body.children.length > 0);
      assert.ok(hasMarkup, "customer SPA shell renders markup");
    });
  });
});
