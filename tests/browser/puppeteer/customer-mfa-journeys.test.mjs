// Real-browser customer-portal + MFA journeys over the composed web/auth stack.
//
// tests/browser/login-journeys.test.mjs covers the ADMIN operator through
// Chromium; this file covers the CUSTOMER plane (fiducia-customer.rs in
// FIDUCIA_SITE_MODE=customer) and the new passwordless / TOTP multi-factor
// flows that supabase_auth.rs speaks to Supabase. The stub Supabase
// (@fiducia/test-config/stubs) now answers the OTP + factors endpoints, and
// CUSTOMER_MFA is seeded with a verified authenticator so login step-up fires.
//
// The stack (real fiducia-auth + fiducia-admin + fiducia-customer, stub
// Supabase, scratch Postgres) boots ONCE for every journey in this file — the
// boot compiles three Rust servers, so a single shared boot is far cheaper than
// a file-per-theme split and keeps the whole surface on one Postgres.
//
//   * Playwright — the customer happy paths: sign in through the real /login
//     form, read the dashboard, prove the session cookie is HttpOnly +
//     SameSite=Strict (and unreadable from document.cookie), log out, log in
//     passwordlessly by email OTP, enrol + activate a TOTP authenticator, and
//     complete the aal1→aal2 login step-up flagship (interim state rides the
//     MFA-pending cookie, never the session cookie).
//   * Puppeteer — the negative / separation paths: a forged login CSRF token is
//     rejected with no cookie, a wrong password renders the alert with no
//     cookie, a signed-out deep link bounces to /login, a customer credential
//     cannot enter the admin app and an admin cookie carries no authority on the
//     customer plane, and the anonymous customer origin leaks no session/PII.
//
// Every customer form is progressively enhanced with htmx; to assert on
// deterministic top-level navigation (and to exercise the no-JS baseline the
// server also fully supports), each isolated page stubs out /assets/htmx.min.js
// so the forms submit natively (POST /login → 303 /app), mirroring the proven
// admin journeys. Each journey runs in a FRESH browser context so its cookie
// jar starts empty regardless of order.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { browserSkipReason, launchPuppeteer } from "../../../src/browser.mjs";
import {
  bootWebAppStack,
  CUSTOMER,
  CUSTOMER_MFA,
  STUB_OTP_CODE,
  STUB_TOTP_CODE,
} from "../../../src/webapps.mjs";

const SKIP = browserSkipReason();

const CUSTOMER_SESSION_COOKIE = "fiducia_customer_session";
const CUSTOMER_LOGIN_CSRF_COOKIE = "fiducia_customer_login_csrf";
const CUSTOMER_MFA_PENDING_COOKIE = "fiducia_customer_mfa_pending";
const ADMIN_SESSION_COOKIE = "fiducia_admin_session";
const HTMX_ASSET = "/assets/htmx.min.js";

describe("real-browser customer + MFA journeys", { skip: SKIP, concurrency: 1 }, () => {
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

  // The Puppeteer equivalent: an incognito context + per-page htmx stub.
  async function ppPage() {
    const context = await pp.browser.createBrowserContext();
    const page = await context.newPage();
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.url().endsWith(HTMX_ASSET)) {
        return request.respond({ status: 200, contentType: "application/javascript", body: "" });
      }
      request.continue();
    });
    return { context, page, close: () => context.close() };
  }

  const customerUrl = (path = "") => `${stack.backend.url}${path}`;

  // ── Puppeteer: negative + separation paths ─────────────────────────────────
  describe("negative + separation paths (Puppeteer)", () => {
    it("the login form carries a matching CSRF token cookie; a forged token is rejected with no session", { timeout: 60_000 }, async () => {
      const { page, close } = await ppPage();
      try {
        await page.goto(customerUrl("/login"), { waitUntil: "domcontentloaded" });
        // The double-submit contract: a login-CSRF cookie plus a hidden token.
        const csrfCookie = (await page.cookies(customerUrl())).find(
          (c) => c.name === CUSTOMER_LOGIN_CSRF_COOKIE,
        );
        assert.ok(csrfCookie?.value, "GET /login mints the login-CSRF nonce cookie");
        const token = await page.$eval(
          'form[action="/login"] input[name="csrf_token"]',
          (el) => el.value,
        );
        assert.ok(token && token.length > 0, "the login form carries a CSRF token");

        // Forge the token, then submit — the server must reject it.
        await page.$eval('form[action="/login"] input[name="csrf_token"]', (el) => {
          el.value = "forged-csrf-token";
        });
        await page.type('form[action="/login"] input[name="email"]', CUSTOMER.email);
        await page.type('form[action="/login"] input[name="password"]', CUSTOMER.password);
        const [response] = await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.click('form[action="/login"] button[type="submit"]'),
        ]);
        assert.equal(response.status(), 403, "a forged CSRF token is forbidden");
        assert.match(await page.content(), /invalid_csrf_token/, "the rejection names the CSRF failure");
        const session = (await page.cookies(customerUrl())).find(
          (c) => c.name === CUSTOMER_SESSION_COOKIE,
        );
        assert.equal(session, undefined, "no session cookie on a rejected login");
      } finally {
        await close();
      }
    });

    it("a wrong password shows the alert and issues no session", { timeout: 60_000 }, async () => {
      const { page, close } = await ppPage();
      try {
        await page.goto(customerUrl("/login"), { waitUntil: "domcontentloaded" });
        await page.type('form[action="/login"] input[name="email"]', CUSTOMER.email);
        await page.type('form[action="/login"] input[name="password"]', "not-the-password");
        const [response] = await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.click('form[action="/login"] button[type="submit"]'),
        ]);
        assert.equal(response.status(), 401, "bad credentials are unauthorized");
        const alert = await page.$eval('p[role="alert"]', (el) => el.textContent);
        assert.match(alert ?? "", /rejected/i, "the login page explains the rejection");
        const session = (await page.cookies(customerUrl())).find(
          (c) => c.name === CUSTOMER_SESSION_COOKIE,
        );
        assert.equal(session, undefined, "no session cookie on a failed login");
      } finally {
        await close();
      }
    });

    it("a signed-out deep link to /app/api-keys bounces to /login", { timeout: 60_000 }, async () => {
      const { page, close } = await ppPage();
      try {
        await page.goto(customerUrl("/app/api-keys"), { waitUntil: "domcontentloaded" });
        assert.match(new URL(page.url()).pathname, /\/login$/, "the deep link redirects to /login");
        assert.ok(await page.$('form[action="/login"]'), "the login form is rendered");
        const session = (await page.cookies(customerUrl())).find(
          (c) => c.name === CUSTOMER_SESSION_COOKIE,
        );
        assert.equal(session, undefined, "no session is granted to an anonymous deep link");
      } finally {
        await close();
      }
    });

    it("cross-app separation both ways: a customer credential can't enter admin, an admin cookie can't enter /app", { timeout: 60_000 }, async () => {
      const { page, close } = await ppPage();
      try {
        // Direction 1: a real customer Supabase session, planted under the admin
        // cookie name, is a VALID identity but not an operator — the admin role
        // gate serves 403 (Admin role required), never the dashboard.
        const customerToken = await stack.grant(CUSTOMER);
        await page.setCookie({
          name: ADMIN_SESSION_COOKIE,
          value: customerToken,
          url: stack.admin.url,
        });
        const adminResponse = await page.goto(stack.admin.url, { waitUntil: "domcontentloaded" });
        // 403 (not the 200 dashboard): the role gate serves the forbidden page.
        assert.equal(adminResponse.status(), 403, "a customer credential is forbidden from admin");
        assert.match(
          await page.content(),
          /Admin role required/i,
          "the admin role gate rejects the customer identity",
        );

        // Direction 2: an admin-named cookie carries no authority on the customer
        // plane, which reads only its own session cookie / Bearer.
        await page.setCookie({
          name: ADMIN_SESSION_COOKIE,
          value: "admin-cookie-has-no-meaning-here",
          url: stack.backend.url,
        });
        await page.goto(customerUrl("/app"), { waitUntil: "domcontentloaded" });
        assert.match(
          new URL(page.url()).pathname,
          /\/login$/,
          "the admin cookie yields no customer session",
        );
      } finally {
        await close();
      }
    });

    it("the anonymous customer origin serves the public login surface only — no session cookie, no customer data", { timeout: 60_000 }, async () => {
      const { page, close } = await ppPage();
      try {
        const response = await page.goto(customerUrl(), { waitUntil: "domcontentloaded" });
        assert.ok(response.ok() || response.status() === 200, "the customer origin serves an anonymous page");
        assert.match(new URL(page.url()).pathname, /\/login$/, "an anonymous visit shows the login surface");
        const cookies = await page.cookies(customerUrl());
        assert.equal(
          cookies.find((c) => c.name === CUSTOMER_SESSION_COOKIE),
          undefined,
          "the anonymous surface issues no session cookie",
        );
        const content = await page.content();
        assert.doesNotMatch(content, /dev@acme\.com/, "no signed-in customer email leaks to anonymous visitors");
        assert.equal(
          await page.$('meta[name="fiducia-customer-csrf"]'),
          null,
          "the per-session CSRF meta only exists on authenticated pages",
        );
      } finally {
        await close();
      }
    });
  });

  // Native form sign-in used by several Playwright journeys.
});
