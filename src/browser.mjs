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
export function browserSkipReason() {
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
  // FIDUCIA_E2E_WEBAPPS=1 so this reports those, not the env gate.
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
