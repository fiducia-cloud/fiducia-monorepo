// Real-browser admin login journey, driven through SELENIUM (RemoteWebDriver
// against a long-lived Selenium Grid — see src/browser.mjs for the Grid
// endpoint contract). Mirrors the Playwright operator journey so all three
// automation stacks prove the same product behavior:
//
//   land on /login → sign in through the real form → dashboard names the
//   operator → sign out through the UI → dashboard locked again.
//
// The Grid may be remote (the k8s-cluster dd-selenium-server); when it is, set
// FIDUCIA_E2E_PUBLIC_BASE_URL so the in-cluster browser can reach the stack.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { launchSelenium, publicUrlFor, seleniumSkipReason } from "../../../src/browser.mjs";
import { bootWebAppStack, OPERATOR } from "../../../src/webapps.mjs";

const SKIP = await seleniumSkipReason();

describe("real-browser login journeys (Selenium)", { skip: SKIP, concurrency: 1 }, () => {
  /** @type {Awaited<ReturnType<typeof bootWebAppStack>>} */
  let stack;
  /** @type {Awaited<ReturnType<typeof launchSelenium>>} */
  let se;
  let adminUrl;

  before(async () => {
    stack = await bootWebAppStack();
    adminUrl = publicUrlFor(stack.admin.url);
    se = await launchSelenium();
  }, { timeout: 900_000 }); // first run compiles three Rust servers

  after(async () => {
    await se?.close();
    await stack?.stop();
  }, { timeout: 120_000 });

  const pathnameOf = async () => new URL(await se.driver.getCurrentUrl()).pathname;

  it("a signed-out visit is redirected to the login form", { timeout: 60_000 }, async () => {
    await se.driver.get(adminUrl);
    await se.driver.wait(se.until.elementLocated(se.By.css('form[action="/login"] input[name="email"]')), 15_000);
    assert.match(await pathnameOf(), /\/login$/, "browser must land on /login");
  });

  it("the operator signs in through the real form and reaches the dashboard", { timeout: 60_000 }, async () => {
    await se.driver.findElement(se.By.css('input[name="email"]')).sendKeys(OPERATOR.email);
    await se.driver.findElement(se.By.css('input[name="password"]')).sendKeys(OPERATOR.password);
    await se.driver.findElement(se.By.css('form[action="/login"] button')).click();
    await se.driver.wait(async () => (await pathnameOf()) === "/", 15_000, "dashboard should load");
    const who = await se.driver.findElement(se.By.css(".who")).getText();
    assert.match(who, /operator/i, "dashboard header names the signed-in operator");
  });

  it("the session cookie the browser holds is HttpOnly (invisible to page JS)", { timeout: 60_000 }, async () => {
    // WebDriver's cookie API deliberately omits HttpOnly cookies' httpOnly bit
    // in some drivers, so assert the property that matters: page JS can't see it.
    const documentCookie = await se.driver.executeScript("return document.cookie");
    assert.ok(
      !String(documentCookie).includes("fiducia_admin_session"),
      "document.cookie must not expose the HttpOnly session",
    );
  });

  it("signing out through the UI locks the dashboard again", { timeout: 60_000 }, async () => {
    await se.driver.findElement(se.By.css('form[action="/logout"] button')).click();
    await se.driver.wait(async () => /\/login$/.test(await pathnameOf()), 15_000);
    await se.driver.get(adminUrl);
    await se.driver.wait(async () => /\/login$/.test(await pathnameOf()), 15_000);
    assert.match(await pathnameOf(), /\/login$/, "dashboard stays locked after logout");
  });
});
