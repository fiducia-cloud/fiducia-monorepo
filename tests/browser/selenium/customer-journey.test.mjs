// Real-browser CUSTOMER sign-in journey, driven through SELENIUM
// (RemoteWebDriver against a long-lived Selenium Grid — see src/browser.mjs).
//
// The Selenium login journey (login-journeys.test.mjs) certifies the ADMIN
// plane over WebDriver; this file certifies the CUSTOMER plane through the same
// third automation stack, so all three (Playwright/Puppeteer/Selenium) prove
// both planes: sign in through the real /login form, reach /app, confirm the
// session cookie is HttpOnly (invisible to page JS), and that /app re-locks
// after sign-out.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { launchSelenium, publicUrlFor, seleniumSkipReason } from "../../../src/browser.mjs";
import { bootWebAppStack, CUSTOMER } from "../../../src/webapps.mjs";

const SKIP = await seleniumSkipReason();
const CUSTOMER_SESSION_COOKIE = "fiducia_customer_session";

describe("real-browser customer journey (Selenium)", { skip: SKIP, concurrency: 1 }, () => {
  /** @type {Awaited<ReturnType<typeof bootWebAppStack>>} */
  let stack;
  /** @type {Awaited<ReturnType<typeof launchSelenium>>} */
  let se;
  let customerBase;

  before(async () => {
    stack = await bootWebAppStack();
    customerBase = publicUrlFor(stack.backend.url);
    se = await launchSelenium();
  }, { timeout: 900_000 }); // first run compiles three Rust servers

  after(async () => {
    await se?.close();
    await stack?.stop();
  }, { timeout: 120_000 });

  const pathnameOf = async () => new URL(await se.driver.getCurrentUrl()).pathname;
  const customerUrl = (path = "") => `${customerBase.replace(/\/+$/, "")}${path}`;

  async function signIn() {
    await se.driver.get(customerUrl("/login"));
    await se.driver.wait(
      se.until.elementLocated(se.By.css('form[action="/login"] input[name="email"]')),
      15_000,
    );
    await se.driver.findElement(se.By.css('input[name="email"]')).sendKeys(CUSTOMER.email);
    await se.driver.findElement(se.By.css('input[name="password"]')).sendKeys(CUSTOMER.password);
    await se.driver.findElement(se.By.css('form[action="/login"] button[type="submit"]')).click();
    await se.driver.wait(async () => (await pathnameOf()) === "/app", 15_000, "sign-in should reach /app");
  }

  it("signs in through the real /login form and reaches /app", { timeout: 60_000 }, async () => {
    await signIn();
    assert.equal(await pathnameOf(), "/app", "password login lands on /app");
    assert.ok(
      await se.driver.findElement(se.By.css("header.topbar")).isDisplayed(),
      "the dashboard chrome renders",
    );
  });

  it("the session cookie is HttpOnly — invisible to page JS", { timeout: 60_000 }, async () => {
    const documentCookie = await se.driver.executeScript("return document.cookie");
    assert.ok(
      !String(documentCookie).includes(CUSTOMER_SESSION_COOKIE),
      "document.cookie must not expose the HttpOnly customer session",
    );
  });

  it("signing out re-locks /app", { timeout: 60_000 }, async () => {
    await se.driver.findElement(se.By.css('form[action="/logout"] button')).click();
    await se.driver.wait(async () => /\/login$/.test(await pathnameOf()), 15_000);
    await se.driver.get(customerUrl("/app/api-keys"));
    await se.driver.wait(async () => /\/login$/.test(await pathnameOf()), 15_000);
    assert.match(await pathnameOf(), /\/login$/, "/app stays locked after sign-out");
  });
});
