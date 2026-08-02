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
import { publicUrlFor } from "./browser-url.mjs";
import { seleniumRemoteUrl } from "./selenium-url.mjs";
export { publicUrlFor } from "./browser-url.mjs";
export { seleniumRemoteUrl } from "./selenium-url.mjs";

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

/**
 * Launch Playwright Chromium — or connect to a REMOTE Playwright server when
 * `FIDUCIA_E2E_PLAYWRIGHT_WS` is set (a `playwright run-server` / browser
 * server, e.g. one deployed in the k8s cluster). Returns
 * `{ browser, context, page, close }`; `close` disconnects (not closes) a
 * shared remote browser so other callers keep it.
 *
 * NB: routing Playwright through the deployed **Selenium Grid** does NOT work
 * over a port-forward — the Grid hands back the node's pod-internal CDP address
 * which the runner cannot reach. Use Selenium (RemoteWebDriver) for the Grid;
 * use `FIDUCIA_E2E_PLAYWRIGHT_WS` for a dedicated Playwright server.
 */
export async function launchPlaywright() {
  const { chromium } = await import("playwright");
  const wsEndpoint = process.env.FIDUCIA_E2E_PLAYWRIGHT_WS?.trim();
  const browser = wsEndpoint ? await chromium.connect(wsEndpoint) : await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  // For a connected browser, close() disconnects the client and leaves the
  // remote server running; for a launched one it terminates the local browser.
  return {
    browser,
    context,
    page,
    close: () => browser.close(),
  };
}

/**
 * Launch Puppeteer Chrome — or connect to a REMOTE browser when
 * `FIDUCIA_E2E_PUPPETEER_WS` is set (a browserless / `chrome --remote-debugging`
 * CDP websocket). Returns `{ browser, page, close }`; `close` disconnects a
 * shared remote browser rather than terminating it.
 *
 * NB: a Selenium Grid is NOT a Puppeteer endpoint (Puppeteer speaks CDP, the
 * Grid speaks WebDriver). Point this at a dedicated browserless/Chrome server.
 */
export async function launchPuppeteer() {
  const { default: puppeteer } = await import("puppeteer");
  const wsEndpoint = process.env.FIDUCIA_E2E_PUPPETEER_WS?.trim();
  // Some nested CI containers cannot expose either Chromium's setuid sandbox
  // or unprivileged user namespaces. Keep the escape hatch explicit so normal
  // local and remote-browser runs retain Chrome's sandbox.
  const launchOptions =
    process.env.FIDUCIA_E2E_BROWSER_NO_SANDBOX === "1"
      ? { args: ["--no-sandbox", "--disable-setuid-sandbox"] }
      : {};
  const browser = wsEndpoint
    ? await puppeteer.connect({ browserWSEndpoint: wsEndpoint })
    : await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  return {
    browser,
    page,
    close: () => (wsEndpoint ? browser.disconnect() : browser.close()),
  };
}

// ── Selenium (RemoteWebDriver against a long-lived Selenium server) ─────────
//
// Unlike Playwright/Puppeteer (which download and drive their own local
// Chromium), the Selenium layer talks WebDriver to an EXISTING Selenium
// Grid — e.g. the `selenium/standalone-chromium` server deployed in
// ~/codes/ores/k8s-cluster (`dd-selenium-server`, Grid on :4444, pod-internal;
// port-forward it locally: `kubectl port-forward deploy/dd-selenium-server 4444:4444`).
//
//   FIDUCIA_E2E_SELENIUM_URL   Grid endpoint (default http://localhost:4444;
//                              SELENIUM_REMOTE_URL is honored as a fallback).
//   FIDUCIA_E2E_PUBLIC_BASE_URL  Optional base-URL rewrite: when the Grid runs
//                              remotely (in-cluster), its browser cannot reach
//                              the runner's 127.0.0.1 stack, so tests rewrite
//                              their target origin through this value.

/** Why the Selenium suite cannot run here, or `false` if it can. Reaches out
 *  to the Grid's /status once so an absent server skips instead of failing. */
export async function seleniumSkipReason({ requireStack = true } = {}) {
  if (process.env.FIDUCIA_E2E_BROWSER !== "1") {
    return "set FIDUCIA_E2E_BROWSER=1 (npm run test:browser) to drive the web apps through real Chromium";
  }
  if (!packageInstalled("selenium-webdriver")) {
    return "selenium-webdriver is not installed (run npm ci from fiducia-e2e)";
  }
  let grid;
  try {
    grid = seleniumRemoteUrl();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
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
 * Neutralize htmx on every enhanced form on the driver's CURRENT page so the
 * next submit performs a real top-level navigation instead of an in-place AJAX
 * swap. The fiducia forms are progressively enhanced — they carry both a native
 * `method="post" action=…` and `hx-post` — so once htmx is out of the way the
 * submit falls through to the browser's native form handling and the URL
 * changes (which the journeys assert on).
 *
 * This is the Selenium analogue of the `htmx.min.js` stub the Playwright and
 * Puppeteer suites install: WebDriver has no request interception, so instead
 * of blocking the script we disable htmx in the page. Removing `hx-post` is NOT
 * enough — htmx binds its `submit` handler DIRECTLY to the form during
 * processing, so the attribute is already internalized. We therefore also
 * replace each form with a clone, which drops htmx's listener; the clone has no
 * hx-* attributes, so htmx's MutationObserver won't re-process it.
 *
 * Because cloning a form does NOT carry over values typed into its inputs
 * (those are live properties, not attributes), call this BEFORE filling the
 * form, then locate and fill the inputs on the surviving clone.
 */
export async function neutralizeHtmxForms(driver) {
  await driver.executeScript(
    "for (const f of document.querySelectorAll('form[hx-post],form[hx-get]')) {" +
      " for (const a of ['hx-post','hx-get','hx-target','hx-swap','hx-push-url','hx-boost']) f.removeAttribute(a);" +
      " f.replaceWith(f.cloneNode(true)); }",
  );
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
