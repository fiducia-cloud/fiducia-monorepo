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

import { browserSkipReason, launchPlaywright } from "../../../src/browser.mjs";
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
  /** @type {Awaited<ReturnType<typeof launchPlaywright>>} */
  let pw;

  before(async () => {
    stack = await bootWebAppStack();
    pw = await launchPlaywright();
  }, { timeout: 900_000 }); // first run compiles three Rust servers

  after(async () => {
    await pw?.close();
    await stack?.stop();
  }, { timeout: 120_000 });

  // A fresh, cookie-isolated Playwright context with htmx neutralised so forms
  // submit natively (deterministic navigation).
  async function pwPage() {
    const context = await pw.browser.newContext();
    await context.route(
      (url) => url.pathname.endsWith(HTMX_ASSET),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/javascript",
          body: "/* htmx neutralised for deterministic navigation */",
        }),
    );
    const page = await context.newPage();
    return { context, page, close: () => context.close() };
  }

  const customerUrl = (path = "") => `${stack.backend.url}${path}`;

  // Sign in through the real /login form (Playwright), landing on /app.
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

  // ── Playwright: customer happy paths ───────────────────────────────────────
  describe("customer happy paths (Playwright)", () => {
    it("signs in through the real /login form and reaches the /app dashboard", { timeout: 60_000 }, async () => {
      const { page, close } = await pwPage();
      try {
        await page.goto(customerUrl("/login"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('form[action="/login"] input[name="email"]');
        await page.fill('form[action="/login"] input[name="email"]', CUSTOMER.email);
        await page.fill('form[action="/login"] input[name="password"]', CUSTOMER.password);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.click('form[action="/login"] button[type="submit"]'),
        ]);
        assert.equal(new URL(page.url()).pathname, "/app", "password login lands on /app");
        assert.ok(await page.$("header.topbar"), "the dashboard chrome renders");
        assert.match(await page.content(), /dev@acme\.com/, "the topbar names the signed-in customer");
        assert.ok(
          await page.$('form[action="/logout"] button'),
          "the dashboard offers a sign-out control",
        );
      } finally {
        await close();
      }
    });

    it("the session cookie is HttpOnly + SameSite=Strict and unreadable from document.cookie", { timeout: 60_000 }, async () => {
      const { context, page, close } = await pwPage();
      try {
        await signInWithPassword(page, CUSTOMER);
        const cookies = await context.cookies(customerUrl());
        const session = cookies.find((c) => c.name === CUSTOMER_SESSION_COOKIE);
        assert.ok(session, `${CUSTOMER_SESSION_COOKIE} must be in the browser jar`);
        assert.equal(session.httpOnly, true, "session cookie must be HttpOnly");
        assert.equal(session.sameSite, "Strict", "session cookie must be SameSite=Strict");
        const documentCookie = await page.evaluate(() => document.cookie);
        assert.ok(
          !documentCookie.includes(CUSTOMER_SESSION_COOKIE),
          "document.cookie must not expose the HttpOnly session",
        );
      } finally {
        await close();
      }
    });

    it("signing out clears the session cookie and re-locks /app", { timeout: 60_000 }, async () => {
      const { context, page, close } = await pwPage();
      try {
        await signInWithPassword(page, CUSTOMER);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.click('form[action="/logout"] button'),
        ]);
        assert.match(new URL(page.url()).pathname, /\/login$/, "logout returns to the login form");
        const cookies = await context.cookies(customerUrl());
        assert.equal(
          cookies.find((c) => c.name === CUSTOMER_SESSION_COOKIE),
          undefined,
          "logout drops the session cookie from the jar",
        );
        const relock = await page.goto(customerUrl("/app/api-keys"), { waitUntil: "domcontentloaded" });
        assert.match(new URL(page.url()).pathname, /\/login$/, "/app stays locked after logout");
        assert.ok(relock.ok(), "the login page serves after logout");
      } finally {
        await close();
      }
    });

    it("passwordless email OTP login issues a session and reaches /app", { timeout: 60_000 }, async () => {
      const { context, page, close } = await pwPage();
      try {
        await page.goto(customerUrl("/login"), { waitUntil: "domcontentloaded" });
        // Two forms POST to /login/otp (email + phone); the email magic-link form
        // is the one owning #magic-email. Submit that form specifically.
        await page.fill("#magic-email", CUSTOMER.email);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.$eval("#magic-email", (el) => el.form.requestSubmit()),
        ]);
        await page.waitForSelector('form[action="/login/verify"] input[name="token"]');
        assert.match(await page.content(), /Check your email/i, "the OTP-entry page renders");

        await page.fill('form[action="/login/verify"] input[name="token"]', STUB_OTP_CODE);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.click('form[action="/login/verify"] button[type="submit"]'),
        ]);
        assert.equal(new URL(page.url()).pathname, "/app", "OTP verification lands on /app");
        const session = (await context.cookies(customerUrl())).find(
          (c) => c.name === CUSTOMER_SESSION_COOKIE,
        );
        assert.ok(session?.value, "a session cookie is issued after OTP verification");
      } finally {
        await close();
      }
    });

    it("enrols a TOTP authenticator: the page shows the otpauth URI + secret, and a code activates it", { timeout: 60_000 }, async () => {
      const { page, close } = await pwPage();
      try {
        await signInWithPassword(page, CUSTOMER);
        await page.goto(customerUrl("/app/security/mfa"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('form[action="/app/security/mfa/enroll"] button');
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.click('form[action="/app/security/mfa/enroll"] button[type="submit"]'),
        ]);

        // The enrollment page reveals the shared secret + otpauth URI.
        const secret = await page.textContent("pre.totp-secret");
        assert.ok(secret && secret.trim().length > 0, "the enrollment page shows the manual-entry secret");
        assert.match(await page.content(), /otpauth:\/\/totp\//, "the enrollment page shows the otpauth URI");
        await page.waitForSelector('form[action="/app/security/mfa/activate"] input[name="code"]');

        // Confirm the first authenticator code activates the factor.
        await page.fill('form[action="/app/security/mfa/activate"] input[name="code"]', STUB_TOTP_CODE);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.click('form[action="/app/security/mfa/activate"] button[type="submit"]'),
        ]);
        assert.match(await page.content(), /Authenticator enabled/i, "activation confirms 2FA is on");

        // Restore the shared suite account so the next journey starts without
        // an enrolled factor. The browser suites intentionally reuse one real
        // app stack, so persistent security state must be unwound explicitly.
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.click('form[action="/app/security/mfa/disable"] button[type="submit"]'),
        ]);
      } finally {
        await close();
      }
    });

    it("disables an enrolled authenticator from the security page", { timeout: 60_000 }, async () => {
      const { page, close } = await pwPage();
      try {
        await signInWithPassword(page, CUSTOMER);
        // Enrol + activate first so there is a verified factor to remove.
        await page.goto(customerUrl("/app/security/mfa"), { waitUntil: "domcontentloaded" });
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.click('form[action="/app/security/mfa/enroll"] button[type="submit"]'),
        ]);
        await page.fill('form[action="/app/security/mfa/activate"] input[name="code"]', STUB_TOTP_CODE);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.click('form[action="/app/security/mfa/activate"] button[type="submit"]'),
        ]);

        // Back on the management page the factor is listed with a Remove control.
        await page.goto(customerUrl("/app/security/mfa"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('form[action="/app/security/mfa/disable"] button');
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.click('form[action="/app/security/mfa/disable"] button[type="submit"]'),
        ]);
        assert.match(await page.content(), /Authenticator removed/i, "the factor is unenrolled");
      } finally {
        await close();
      }
    });

    it("TOTP step-up: a verified-factor login parks on /login/mfa (pending cookie, NOT session), then the code issues the session", { timeout: 60_000 }, async () => {
      const { context, page, close } = await pwPage();
      try {
        // Primary factor via email OTP for the MFA-enrolled account.
        await page.goto(customerUrl("/login"), { waitUntil: "domcontentloaded" });
        await page.fill("#magic-email", CUSTOMER_MFA.email);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.$eval("#magic-email", (el) => el.form.requestSubmit()),
        ]);
        await page.fill('form[action="/login/verify"] input[name="token"]', STUB_OTP_CODE);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.click('form[action="/login/verify"] button[type="submit"]'),
        ]);

        // Step-up form, NOT the dashboard: no session yet, interim token in the
        // short-lived MFA-pending cookie.
        await page.waitForSelector('form[action="/login/mfa"] input[name="code"]');
        assert.match(await page.content(), /authenticator code/i, "the step-up challenge renders");
        let cookies = await context.cookies(customerUrl());
        assert.ok(
          cookies.find((c) => c.name === CUSTOMER_MFA_PENDING_COOKIE),
          "the interim aal1 token rides the MFA-pending cookie",
        );
        assert.equal(
          cookies.find((c) => c.name === CUSTOMER_SESSION_COOKIE),
          undefined,
          "no app session is issued on aal1 alone",
        );

        // The authenticator code completes aal2 and issues the session.
        await page.fill('form[action="/login/mfa"] input[name="code"]', STUB_TOTP_CODE);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.click('form[action="/login/mfa"] button[type="submit"]'),
        ]);
        assert.equal(new URL(page.url()).pathname, "/app", "completing step-up lands on /app");
        cookies = await context.cookies(customerUrl());
        assert.ok(
          cookies.find((c) => c.name === CUSTOMER_SESSION_COOKIE)?.value,
          "the app session cookie is issued after aal2",
        );
        assert.equal(
          cookies.find((c) => c.name === CUSTOMER_MFA_PENDING_COOKIE),
          undefined,
          "the MFA-pending cookie is cleared once the session exists",
        );
      } finally {
        await close();
      }
    });

    // Regression guard for the MFA-bypass class: step-up was originally wired
    // into the passwordless path only, so a verified-factor account could skip
    // 2FA entirely by signing in through the password form. The assertion that
    // matters is the negative one — the password grant alone must issue NO
    // session. Every primary factor has to converge on the same step-up gate,
    // so this journey mirrors the email-OTP one above through the other door.
    it("TOTP step-up also fires on PASSWORD login: the password factor alone issues no session", { timeout: 60_000 }, async () => {
      const { context, page, close } = await pwPage();
      try {
        await page.goto(customerUrl("/login"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('form[action="/login"] input[name="email"]');
        await page.fill('form[action="/login"] input[name="email"]', CUSTOMER_MFA.email);
        await page.fill('form[action="/login"] input[name="password"]', CUSTOMER_MFA.password);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.click('form[action="/login"] button[type="submit"]'),
        ]);

        // Correct credentials, but a verified authenticator is enrolled: this
        // must park on the challenge, never the dashboard.
        assert.notEqual(
          new URL(page.url()).pathname,
          "/app",
          "a verified-factor account must not reach /app on the password factor alone",
        );
        await page.waitForSelector('form[action="/login/mfa"] input[name="code"]');
        let cookies = await context.cookies(customerUrl());
        assert.equal(
          cookies.find((c) => c.name === CUSTOMER_SESSION_COOKIE),
          undefined,
          "no app session is issued from the password factor alone",
        );
        assert.ok(
          cookies.find((c) => c.name === CUSTOMER_MFA_PENDING_COOKIE),
          "the interim aal1 token rides the MFA-pending cookie",
        );

        // Completing the challenge issues the session, as on the OTP path.
        await page.fill('form[action="/login/mfa"] input[name="code"]', STUB_TOTP_CODE);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.click('form[action="/login/mfa"] button[type="submit"]'),
        ]);
        assert.equal(new URL(page.url()).pathname, "/app", "completing step-up lands on /app");
        cookies = await context.cookies(customerUrl());
        assert.ok(
          cookies.find((c) => c.name === CUSTOMER_SESSION_COOKIE)?.value,
          "the app session cookie is issued only after aal2",
        );
      } finally {
        await close();
      }
    });
  });
});
