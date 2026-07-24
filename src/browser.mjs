// Gate + launch helpers for the real-browser suite (tests/browser/).
//
// The browser layer rides the SAME composed stack as tests/webapps/ (real
// fiducia-auth / fiducia-admin / fiducia-customer from sibling checkouts,
// stub Supabase, scratch Postgres) but drives it through actual Chromium —
// once via Playwright, once via Puppeteer — instead of `fetch`. That is what
// makes it worth having on top of the fetch-level specs: the browser itself
// enforces redirects, form encoding, the cookie jar, HttpOnly/SameSite, and
// runs the pages' JS.
//
// Doubly heavyweight (cargo builds + browser binaries), so doubly opt-in:
// `npm run test:browser` sets FIDUCIA_E2E_BROWSER=1 *and* FIDUCIA_E2E_WEBAPPS=1
// (the stack preconditions are checked by webAppsSkipReason).

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { webAppsSkipReason } from "./webapps.mjs";

const E2E_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function packageInstalled(name) {
  return existsSync(join(E2E_ROOT, "node_modules", name, "package.json"));
}

/** Why the browser suite cannot run here, or `false` if it can (node:test
 *  `{ skip }` shape — never null, which would skip yet still run hooks). */
export function browserSkipReason({ requireStack = true } = {}) {
  if (process.env.FIDUCIA_E2E_BROWSER !== "1") {
    return "set FIDUCIA_E2E_BROWSER=1 (npm run test:browser) to drive the web apps through real Chromium";
  }
  for (const pkg of ["playwright", "puppeteer"]) {
    if (!packageInstalled(pkg)) {
      return `${pkg} is not installed (run npm ci from fiducia-e2e)`;
    }
  }
  // The rest of the preconditions are the web-app stack's own (sibling
  // checkouts, Postgres tools, test-config). `npm run test:browser` sets
  // FIDUCIA_E2E_WEBAPPS=1 so this reports those, not the env gate. Chaos and
  // multicluster browser suites target already-deployed endpoints instead and
  // pass `requireStack: false`.
  if (!requireStack) return false;
  return webAppsSkipReason() ?? false;
}

/** Launch Playwright Chromium; returns `{ browser, context, page, close }`. */
export async function launchPlaywright() {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    close: () => browser.close(),
  };
}

/** Launch Puppeteer Chrome; returns `{ browser, page, close }`. */
export async function launchPuppeteer() {
  const { default: puppeteer } = await import("puppeteer");
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  return {
    browser,
    page,
    close: () => browser.close(),
  };
}

// ── Selenium (RemoteWebDriver against a long-lived Selenium server) ─────────
//
// Unlike Playwright/Puppeteer (which download and drive their own local
// Chromium), the Selenium layer talks WebDriver to an EXISTING Selenium
// Grid — e.g. the `selenium/standalone-chromium` server deployed in
// ~/codes/ores/k8s-cluster (`dd-selenium-server`, Grid on :4444, pod-internal;
// port-forward it locally: `kubectl port-forward svc/dd-selenium-server 4444`).
//
//   FIDUCIA_E2E_SELENIUM_URL   Grid endpoint (default http://localhost:4444;
//                              SELENIUM_REMOTE_URL is honored as a fallback).
//   FIDUCIA_E2E_PUBLIC_BASE_URL  Optional base-URL rewrite: when the Grid runs
//                              remotely (in-cluster), its browser cannot reach
//                              the runner's 127.0.0.1 stack, so tests rewrite
//                              their target origin through this value.

/** The Selenium Grid endpoint under test. */
export function seleniumRemoteUrl() {
  return (
    process.env.FIDUCIA_E2E_SELENIUM_URL?.trim() ||
    process.env.SELENIUM_REMOTE_URL?.trim() ||
    "http://localhost:4444"
  );
}

/** Why the Selenium suite cannot run here, or `false` if it can. Reaches out
 *  to the Grid's /status once so an absent server skips instead of failing. */
export async function seleniumSkipReason({ requireStack = true } = {}) {
  if (process.env.FIDUCIA_E2E_BROWSER !== "1") {
    return "set FIDUCIA_E2E_BROWSER=1 (npm run test:browser) to drive the web apps through real Chromium";
  }
  if (!packageInstalled("selenium-webdriver")) {
    return "selenium-webdriver is not installed (run npm ci from fiducia-e2e)";
  }
  const grid = seleniumRemoteUrl();
  try {
    const res = await fetch(`${grid}/status`, { signal: AbortSignal.timeout(3_000) });
    const body = await res.json();
    if (body?.value?.ready !== true) {
      return `Selenium Grid at ${grid} is not ready (value.ready !== true)`;
    }
  } catch (error) {
    return `no Selenium Grid reachable at ${grid} (${error?.message ?? error}) — port-forward the k8s-cluster dd-selenium-server or run selenium/standalone-chromium locally`;
  }
  if (!requireStack) return false;
  return webAppsSkipReason() ?? false;
}

/**
 * Rewrite a stack-local URL for the Grid's browser. With a local Grid this is
 * the identity; with a remote Grid, FIDUCIA_E2E_PUBLIC_BASE_URL supplies the
 * origin the in-cluster browser can actually reach.
 */
export function publicUrlFor(stackUrl) {
  const override = process.env.FIDUCIA_E2E_PUBLIC_BASE_URL?.trim();
  if (!override) return stackUrl;
  const from = new URL(stackUrl);
  const to = new URL(override);
  from.protocol = to.protocol;
  from.host = to.host;
  return from.toString();
}

/** Connect a RemoteWebDriver Chrome session; returns `{ driver, By, until, Key, close }`. */
export async function launchSelenium() {
  const webdriver = await import("selenium-webdriver");
  const chrome = await import("selenium-webdriver/chrome.js");
  const options = new chrome.Options();
  options.addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage");
  const driver = await new webdriver.Builder()
    .usingServer(seleniumRemoteUrl())
    .forBrowser("chrome")
    .setChromeOptions(options)
    .build();
  return {
    driver,
    By: webdriver.By,
    until: webdriver.until,
    Key: webdriver.Key,
    close: () => driver.quit(),
  };
}
