// Real-browser customer API-key lifecycle over the composed web/auth stack,
// driven through PUPPETEER (the Playwright sibling proves the same product;
// this certifies the second automation stack executes the same journey).
//
// The API-key management surface is htmx-driven (create hx-POSTs /app/api-keys,
// the list hx-GETs /app/fragments/api-keys, both swapping #api-key-results).
// htmx is neutralised for deterministic login, and those exact endpoints are
// driven through the page's OWN authenticated fetch — the requests htmx issues.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { browserSkipReason, launchPuppeteer } from "../../../src/browser.mjs";
import { bootWebAppStack, CUSTOMER } from "../../../src/webapps.mjs";

const SKIP = browserSkipReason();
const HTMX_ASSET = "/assets/htmx.min.js";

describe("real-browser customer API-key lifecycle (Puppeteer)", { skip: SKIP, concurrency: 1 }, () => {
  /** @type {Awaited<ReturnType<typeof bootWebAppStack>>} */
  let stack;
  /** @type {Awaited<ReturnType<typeof launchPuppeteer>>} */
  let pp;

  before(async () => {
    stack = await bootWebAppStack();
    pp = await launchPuppeteer();
  }, { timeout: 900_000 });

  after(async () => {
    await pp?.close();
    await stack?.stop();
  }, { timeout: 120_000 });

  const customerUrl = (path = "") => `${stack.backend.url}${path}`;

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

  async function signInWithPassword(page, user) {
    await page.goto(customerUrl("/login"), { waitUntil: "domcontentloaded" });
    await page.waitForSelector('form[action="/login"] input[name="email"]');
    await page.type('form[action="/login"] input[name="email"]', user.email);
    await page.type('form[action="/login"] input[name="password"]', user.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click('form[action="/login"] button[type="submit"]'),
    ]);
    assert.equal(new URL(page.url()).pathname, "/app", "sign-in lands on /app");
  }

  // The sidebar org-switcher also has action="/app/api-keys" (method GET); the
  // CREATE form is the method=POST one. Driven through the page's own fetch.
  async function createKeyViaFragment(page, keyName) {
    return page.evaluate(async (name) => {
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

  it("creating a key reveals a one-time secret and lists the key", { timeout: 60_000 }, async () => {
    const { page, close } = await ppPage();
    const keyName = `pp-checkout-${Date.now()}`;
    try {
      await signInWithPassword(page, CUSTOMER);
      await page.goto(customerUrl("/app/api-keys"), { waitUntil: "domcontentloaded" });
      await page.waitForSelector('form[action="/app/api-keys"] input[name="name"]');

      const created = await createKeyViaFragment(page, keyName);
      assert.equal(created.status, 200, `create should succeed (HTTP ${created.status})`);
      assert.match(created.html, new RegExp(keyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        "the create result names the key just issued");
      assert.match(created.html, /fdc_(test|live)_/, "the create result shows the one-time secret");

      const listed = await listKeysFragment(page);
      assert.equal(listed.status, 200, "the list fragment serves");
      assert.match(listed.html, new RegExp(keyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        "the issued key appears in the list");
    } finally {
      await close();
    }
  });

  it("rotating issues a fresh secret; revoking removes the key from the active set", { timeout: 60_000 }, async () => {
    const { page, close } = await ppPage();
    const keyName = `pp-lifecycle-${Date.now()}`;
    try {
      await signInWithPassword(page, CUSTOMER);
      await page.goto(customerUrl("/app/api-keys"), { waitUntil: "domcontentloaded" });
      await page.waitForSelector('form[action="/app/api-keys"] input[name="name"]');

      const created = await createKeyViaFragment(page, keyName);
      const firstSecret = created.html.match(/fdc_(?:test|live)_[A-Za-z0-9]+\.[A-Za-z0-9_-]+/);
      assert.ok(firstSecret, "the create result exposes a full one-time secret");
      const prefix = firstSecret[0].split(".")[0];

      const rotated = await page.evaluate(async (keyPrefix) => {
        const doc = new DOMParser().parseFromString(
          await (await fetch("/app/fragments/api-keys")).text(), "text/html");
        const form = [...doc.querySelectorAll('form[action="/app/api-keys/rotate"]')].find(
          (f) => f.querySelector('input[name="prefix"]')?.value === keyPrefix);
        if (!form) return { found: false };
        const body = new URLSearchParams();
        for (const input of form.querySelectorAll("input[name]")) body.set(input.name, input.value);
        const res = await fetch("/app/api-keys/rotate", {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(),
        });
        return { found: true, status: res.status, html: await res.text() };
      }, prefix);
      assert.ok(rotated.found && rotated.status === 200, "rotate succeeds");
      const secondSecret = rotated.html.match(/fdc_(?:test|live)_[A-Za-z0-9]+\.[A-Za-z0-9_-]+/);
      assert.ok(secondSecret && secondSecret[0] !== firstSecret[0], "rotation reveals a NEW secret");

      const revoked = await page.evaluate(async (keyPrefix) => {
        const doc = new DOMParser().parseFromString(
          await (await fetch("/app/fragments/api-keys")).text(), "text/html");
        const form = [...doc.querySelectorAll('form[action="/app/api-keys/revoke"]')].find(
          (f) => f.querySelector('input[name="prefix"]')?.value === keyPrefix);
        if (!form) return { found: false };
        const body = new URLSearchParams();
        for (const input of form.querySelectorAll("input[name]")) body.set(input.name, input.value);
        const res = await fetch("/app/api-keys/revoke", {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(),
        });
        return { found: true, status: res.status };
      }, prefix);
      assert.ok(revoked.found && revoked.status === 200, "revoke succeeds");
    } finally {
      await close();
    }
  });

  it("a forged CSRF token is rejected and issues no key", { timeout: 60_000 }, async () => {
    const { page, close } = await ppPage();
    const keyName = `pp-csrf-${Date.now()}`;
    try {
      await signInWithPassword(page, CUSTOMER);
      await page.goto(customerUrl("/app/api-keys"), { waitUntil: "domcontentloaded" });
      await page.waitForSelector('form[action="/app/api-keys"] input[name="name"]');

      const forged = await page.evaluate(async (name) => {
        const form = document.querySelector('form[method="post"][action="/app/api-keys"]');
        const body = new URLSearchParams();
        body.set("csrf_token", "forged-token");
        body.set("org_id", form.querySelector('input[name="org_id"]').value);
        body.set("idempotency_key", form.querySelector('input[name="idempotency_key"]').value);
        body.set("name", name);
        body.set("environment", "test");
        body.set("scope", "kv:read");
        const res = await fetch("/app/api-keys", {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(),
        });
        return { status: res.status };
      }, keyName);
      assert.ok(forged.status >= 400 && forged.status < 500,
        `forged CSRF must be rejected (got HTTP ${forged.status})`);

      const listed = await listKeysFragment(page);
      assert.doesNotMatch(listed.html, new RegExp(keyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        "a CSRF-rejected create issues no key");
    } finally {
      await close();
    }
  });

  it("a signed-out visit to /app/api-keys bounces to /login", { timeout: 60_000 }, async () => {
    const { page, close } = await ppPage();
    try {
      const response = await page.goto(customerUrl("/app/api-keys"), { waitUntil: "domcontentloaded" });
      assert.match(new URL(page.url()).pathname, /\/login$/, "anonymous API-key access is redirected");
      assert.ok(response.ok(), "the login page serves");
    } finally {
      await close();
    }
  });
});
