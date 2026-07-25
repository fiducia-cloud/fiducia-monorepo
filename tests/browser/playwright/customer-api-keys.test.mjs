// Real-browser customer API-key lifecycle over the composed web/auth stack.
//
// The login/MFA journeys (customer-mfa-journeys.test.mjs) prove the customer
// can authenticate; this file proves the PRODUCT flow a signed-in customer
// actually performs — issuing, viewing, rotating, and revoking API keys — end
// to end through real Chromium against the real fiducia-customer.rs server
// (backed by a scratch Postgres with the customer schema + a live org).
//
// htmx is neutralised per page (like the sibling journeys) so the forms submit
// natively and navigation is deterministic; the server renders the same result
// fragments without JS.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { browserSkipReason, launchPlaywright } from "../../../src/browser.mjs";
import { bootWebAppStack, CUSTOMER } from "../../../src/webapps.mjs";

const SKIP = browserSkipReason();
const HTMX_ASSET = "/assets/htmx.min.js";

describe("real-browser customer API-key lifecycle (Playwright)", { skip: SKIP, concurrency: 1 }, () => {
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

  const customerUrl = (path = "") => `${stack.backend.url}${path}`;

  async function pwPage() {
    const context = await pw.browser.newContext();
    await context.route(
      (url) => url.pathname.endsWith(HTMX_ASSET),
      (route) =>
        route.fulfill({ status: 200, contentType: "application/javascript", body: "" }),
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

  it("the API-keys page renders the create form with named scopes", { timeout: 60_000 }, async () => {
    const { page, close } = await pwPage();
    try {
      await signInWithPassword(page, CUSTOMER);
      await page.goto(customerUrl("/app/api-keys"), { waitUntil: "domcontentloaded" });
      assert.equal(new URL(page.url()).pathname, "/app/api-keys", "the API-keys page serves");
      await page.waitForSelector('form[action="/app/api-keys"] input[name="name"]');
      assert.ok(
        await page.$('form[action="/app/api-keys"] select[name="scope"]'),
        "the create form offers a scope selector",
      );
      // The form must carry a CSRF token and an idempotency key (mutation safety).
      assert.ok(
        await page.$('form[action="/app/api-keys"] input[name="csrf_token"]'),
        "the create form carries a CSRF token",
      );
    } finally {
      await close();
    }
  });

  // The API-keys management surface is htmx-driven: the create form hx-POSTs to
  // /app/api-keys and the list hx-GETs /app/fragments/api-keys, both swapping
  // into #api-key-results. With htmx neutralised for deterministic login, we
  // drive those exact endpoints through the page's OWN authenticated fetch
  // (same cookie jar, same origin, same requests htmx would issue) and read the
  // real server fragments back.
  async function createKeyViaFragment(page, keyName) {
    return page.evaluate(async (name) => {
      // NB: the sidebar org-switcher also has action="/app/api-keys" (method
      // GET); the CREATE form is the method=POST one with hx-post.
      const form = document.querySelector('form[method="post"][action="/app/api-keys"]');
      const body = new URLSearchParams();
      body.set("csrf_token", form.querySelector('input[name="csrf_token"]').value);
      body.set("org_id", form.querySelector('input[name="org_id"]').value);
      body.set("idempotency_key", form.querySelector('input[name="idempotency_key"]').value);
      body.set("name", name);
      body.set("environment", "test");
      body.set("scope", "kv:read");
      const res = await fetch("/app/api-keys", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      return { status: res.status, html: await res.text() };
    }, keyName);
  }
  async function listKeysFragment(page) {
    return page.evaluate(async () => {
      const res = await fetch("/app/fragments/api-keys", { headers: { accept: "text/html" } });
      return { status: res.status, html: await res.text() };
    });
  }

  it("creating a key reveals the plaintext secret exactly once and lists the key", { timeout: 60_000 }, async () => {
    const { page, close } = await pwPage();
    const keyName = `e2e-checkout-${Date.now()}`;
    try {
      await signInWithPassword(page, CUSTOMER);
      await page.goto(customerUrl("/app/api-keys"), { waitUntil: "domcontentloaded" });
      await page.waitForSelector('form[action="/app/api-keys"] input[name="name"]');

      const created = await createKeyViaFragment(page, keyName);
      assert.equal(created.status, 200, `create should succeed (HTTP ${created.status})`);
      assert.match(created.html, new RegExp(keyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        "the create result fragment names the key just issued");
      // The create result reveals a real key secret exactly once — the plaintext
      // key format is `fdc_{env}_{key_id}.{secret}` (customer.rs). It must appear
      // in the create fragment but NOT on the plain list below.
      assert.match(created.html, /fdc_(test|live)_/,
        "the create result shows the one-time plaintext key secret");

      const listed = await listKeysFragment(page);
      assert.equal(listed.status, 200, "the list fragment serves");
      assert.match(listed.html, new RegExp(keyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        "the issued key appears in the list fragment");
    } finally {
      await close();
    }
  });

  it("the list fragment offers rotate and revoke controls for an existing key", { timeout: 60_000 }, async () => {
    const { page, close } = await pwPage();
    const keyName = `e2e-rotate-${Date.now()}`;
    try {
      await signInWithPassword(page, CUSTOMER);
      await page.goto(customerUrl("/app/api-keys"), { waitUntil: "domcontentloaded" });
      await page.waitForSelector('form[action="/app/api-keys"] input[name="name"]');

      const created = await createKeyViaFragment(page, keyName);
      assert.equal(created.status, 200, "the key is created for the management assertions");

      const listed = await listKeysFragment(page);
      assert.match(listed.html, /action="\/app\/api-keys\/rotate"/,
        "each key offers a rotate control");
      assert.match(listed.html, /action="\/app\/api-keys\/revoke"/,
        "each key offers a revoke control");
    } finally {
      await close();
    }
  });

  it("rotating a key issues a fresh secret; revoking removes it from the active list", { timeout: 60_000 }, async () => {
    const { page, close } = await pwPage();
    const keyName = `e2e-lifecycle-${Date.now()}`;
    try {
      await signInWithPassword(page, CUSTOMER);
      await page.goto(customerUrl("/app/api-keys"), { waitUntil: "domcontentloaded" });
      await page.waitForSelector('form[action="/app/api-keys"] input[name="name"]');

      const created = await createKeyViaFragment(page, keyName);
      const firstSecret = created.html.match(/fdc_(?:test|live)_[A-Za-z0-9]+\.[A-Za-z0-9_-]+/);
      assert.ok(firstSecret, "the create result exposes a full one-time secret");
      const prefix = firstSecret[0].split(".")[0]; // fdc_{env}_{key_id}

      // Rotate the key by submitting its rotate form (parsed from the live list).
      const rotated = await page.evaluate(async (keyPrefix) => {
        const listHtml = await (await fetch("/app/fragments/api-keys")).text();
        const doc = new DOMParser().parseFromString(listHtml, "text/html");
        const form = [...doc.querySelectorAll('form[action="/app/api-keys/rotate"]')].find(
          (f) => f.querySelector('input[name="prefix"]')?.value === keyPrefix,
        );
        if (!form) return { found: false };
        const body = new URLSearchParams();
        for (const input of form.querySelectorAll("input[name]")) body.set(input.name, input.value);
        const res = await fetch("/app/api-keys/rotate", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });
        return { found: true, status: res.status, html: await res.text() };
      }, prefix);
      assert.ok(rotated.found, "the rotate form for the created key is present");
      assert.equal(rotated.status, 200, `rotate should succeed (HTTP ${rotated.status})`);
      const secondSecret = rotated.html.match(/fdc_(?:test|live)_[A-Za-z0-9]+\.[A-Za-z0-9_-]+/);
      assert.ok(secondSecret, "rotation reveals a new one-time secret");
      assert.notEqual(secondSecret[0], firstSecret[0], "the rotated secret differs from the original");

      // Revoke the key; it must drop out of the ACTIVE key set (its rotate form
      // — only rendered for active keys — disappears).
      const revoked = await page.evaluate(async (keyPrefix) => {
        const listHtml = await (await fetch("/app/fragments/api-keys")).text();
        const doc = new DOMParser().parseFromString(listHtml, "text/html");
        const form = [...doc.querySelectorAll('form[action="/app/api-keys/revoke"]')].find(
          (f) => f.querySelector('input[name="prefix"]')?.value === keyPrefix,
        );
        if (!form) return { found: false };
        const body = new URLSearchParams();
        for (const input of form.querySelectorAll("input[name]")) body.set(input.name, input.value);
        const res = await fetch("/app/api-keys/revoke", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });
        return { found: true, status: res.status };
      }, prefix);
      assert.ok(revoked.found, "the revoke form for the created key is present");
      assert.equal(revoked.status, 200, "revoke should succeed");

      const afterHtml = (await listKeysFragment(page)).html;
      // The revoked key no longer offers a rotate control (active-only).
      const hasRotateForRevoked = new RegExp(
        `name="prefix" value="${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[\\s\\S]{0,400}?/app/api-keys/rotate`,
      ).test(afterHtml) ||
      new RegExp(
        `/app/api-keys/rotate[\\s\\S]{0,400}?name="prefix" value="${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
      ).test(afterHtml);
      assert.equal(hasRotateForRevoked, false, "a revoked key no longer offers a rotate control");
    } finally {
      await close();
    }
  });

  it("a create POST with a mismatched CSRF token is rejected and issues no key", { timeout: 60_000 }, async () => {
    const { page, close } = await pwPage();
    const keyName = `e2e-csrf-${Date.now()}`;
    try {
      await signInWithPassword(page, CUSTOMER);
      await page.goto(customerUrl("/app/api-keys"), { waitUntil: "domcontentloaded" });
      await page.waitForSelector('form[action="/app/api-keys"] input[name="name"]');

      const forged = await page.evaluate(async (name) => {
        const form = document.querySelector('form[method="post"][action="/app/api-keys"]');
        const body = new URLSearchParams();
        body.set("csrf_token", "forged-does-not-match-the-cookie");
        body.set("org_id", form.querySelector('input[name="org_id"]').value);
        body.set("idempotency_key", form.querySelector('input[name="idempotency_key"]').value);
        body.set("name", name);
        body.set("environment", "test");
        body.set("scope", "kv:read");
        const res = await fetch("/app/api-keys", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });
        return { status: res.status };
      }, keyName);
      assert.ok(forged.status >= 400 && forged.status < 500,
        `a forged CSRF token must be rejected (got HTTP ${forged.status})`);

      // The rejected create issued nothing: the key name is absent from the list.
      const listed = await listKeysFragment(page);
      assert.doesNotMatch(listed.html, new RegExp(keyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        "a CSRF-rejected create must not have issued a key");
    } finally {
      await close();
    }
  });

  it("a signed-out visit to /app/api-keys bounces to /login (no key data leaked)", { timeout: 60_000 }, async () => {
    const { page, close } = await pwPage();
    try {
      const response = await page.goto(customerUrl("/app/api-keys"), { waitUntil: "domcontentloaded" });
      assert.match(new URL(page.url()).pathname, /\/login$/, "unauthenticated API-key access is redirected");
      assert.ok(response.ok(), "the login page serves");
      assert.ok(
        !(await page.$('form[action="/app/api-keys"]')),
        "no API-key management form is served to an anonymous visitor",
      );
    } finally {
      await close();
    }
  });
});
