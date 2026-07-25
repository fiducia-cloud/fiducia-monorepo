// Real-browser admin dashboard navigation over the composed web/auth stack,
// driven through SELENIUM (RemoteWebDriver against a long-lived Grid — see
// src/browser.mjs). The Puppeteer sibling proves the same nav surface; this
// certifies the third automation stack drives it: a signed-in operator reaches
// every dashboard page, and every deep link is gated when signed out.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { launchSelenium, publicUrlFor, seleniumSkipReason } from "../../../src/browser.mjs";
import { bootWebAppStack, OPERATOR } from "../../../src/webapps.mjs";

const SKIP = await seleniumSkipReason();
const ADMIN_PAGES = ["/", "/infra", "/cluster", "/notices", "/audit"];

describe("real-browser admin dashboard navigation (Selenium)", { skip: SKIP, concurrency: 1 }, () => {
  /** @type {Awaited<ReturnType<typeof bootWebAppStack>>} */
  let stack;
  /** @type {Awaited<ReturnType<typeof launchSelenium>>} */
  let se;
  let adminBase;

  before(async () => {
    stack = await bootWebAppStack();
    adminBase = publicUrlFor(stack.admin.url);
    se = await launchSelenium();
  }, { timeout: 900_000 });

  after(async () => {
    await se?.close();
    await stack?.stop();
  }, { timeout: 120_000 });

  const adminUrl = (path = "") => `${adminBase.replace(/\/+$/, "")}${path}`;
  const pathnameOf = async () => new URL(await se.driver.getCurrentUrl()).pathname;

  async function signIn() {
    await se.driver.get(adminUrl("/login"));
    await se.driver.wait(
      se.until.elementLocated(se.By.css('form[action="/login"] input[name="email"]')), 15_000);
    await se.driver.findElement(se.By.css('input[name="email"]')).sendKeys(OPERATOR.email);
    await se.driver.findElement(se.By.css('input[name="password"]')).sendKeys(OPERATOR.password);
    await se.driver.findElement(se.By.css('form[action="/login"] button')).click();
    await se.driver.wait(async () => (await pathnameOf()) === "/", 15_000, "sign-in reaches the dashboard");
  }

  it("a signed-in operator reaches every dashboard nav page", { timeout: 120_000 }, async () => {
    await signIn();
    for (const path of ADMIN_PAGES) {
      await se.driver.get(adminUrl(path));
      // Each authenticated page renders the dashboard chrome and is NOT bounced.
      await se.driver.wait(
        se.until.elementLocated(se.By.css("header.topbar, nav, .app-shell")), 15_000,
        `${path}: authenticated page renders dashboard markup`);
      assert.doesNotMatch(await pathnameOf(), /\/login$/,
        `${path}: a signed-in operator must not be bounced to /login`);
    }
  });

  it("every deep link is gated: signed-out visits bounce to /login", { timeout: 120_000 }, async () => {
    // A fresh driver session (never signed in) via a cleared cookie jar.
    await se.driver.manage().deleteAllCookies();
    for (const path of ADMIN_PAGES.filter((p) => p !== "/")) {
      await se.driver.get(adminUrl(path));
      await se.driver.wait(async () => /\/login$/.test(await pathnameOf()), 15_000,
        `${path}: an unauthenticated deep link must redirect to /login`);
      assert.match(await pathnameOf(), /\/login$/, `${path}: gated to /login`);
    }
  });
});
