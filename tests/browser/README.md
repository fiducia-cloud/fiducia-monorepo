# tests/browser — real-Chromium login journeys

Drives the composed web/auth stack (the same one `tests/webapps/` boots: real
`fiducia-auth` + `fiducia-admin` + `fiducia-customer` from sibling checkouts,
stub Supabase, scratch Postgres) through **actual browsers** instead of
`fetch`. The browser is what makes it new coverage: Chromium follows the
redirects, submits the real HTML forms, keeps the cookie jar, enforces
HttpOnly/SameSite, and executes the pages' JS.

## Layout: one folder per automation stack

Browser-automation specs live in a subfolder named for the framework that
drives them (plain, fetch-level specs stay directly under `tests/<tier>/`):

```
tests/browser/
├── playwright/   # operator happy path + customer/MFA happy paths
├── puppeteer/    # separation & negative paths + customer/MFA negatives
└── selenium/     # operator journey over RemoteWebDriver (a real Grid)
```

| Driver | Journey |
|--------|---------|
| **Playwright** | the operator happy path — land on `/login`, sign in through the form, read the dashboard, verify the jar's `fiducia_admin_session` is HttpOnly + SameSite=Strict (and invisible to `document.cookie`), sign out through the UI and stay locked out; plus the customer + MFA happy paths |
| **Puppeteer** | the separation/negative paths — a customer's *valid* Supabase credentials bounce off the admin role gate (403 page, empty jar), a wrong password renders the alert with no cookie, a signed-out deep link lands back on `/login`, and the customer SPA shell serves; plus the customer/MFA negatives |
| **Selenium** | the operator journey again, but through **RemoteWebDriver against a long-lived Selenium Grid** — proving the product and the Grid-based automation path used elsewhere in the org |

The same tiered layout exists for the deployed-endpoint suites:
`tests/chaos/{selenium,playwright,puppeteer}/` and
`tests/multicluster/{selenium,playwright,puppeteer}/` (shared journeys in
`src/browser-endpoints.mjs`).

## Running

```sh
npm run test:browser             # all three frameworks (recursive glob)
npm run test:browser:playwright  # one framework at a time
npm run test:browser:puppeteer
npm run test:browser:selenium
```

Preconditions on top of the web-app stack's own (sibling checkouts, Postgres
tools): `playwright`, `puppeteer`, and `selenium-webdriver` installed
(`npm ci`), plus browser binaries — `npx playwright install chromium`;
Puppeteer downloads Chrome for Testing during `npm ci`. Without the env gate
the suites skip cleanly, so plain `npm test` stays safe.

### The Selenium Grid

Selenium does not download a browser; it drives an EXISTING Selenium server.
Use the org's long-lived Grid from `~/codes/ores/k8s-cluster`
(`dd-selenium-server`, `selenium/standalone-chromium`, Grid on `:4444`,
pod-internal):

```sh
kubectl port-forward svc/dd-selenium-server 4444   # then npm run test:browser:selenium
```

or any local `selenium/standalone-chromium` container. Configuration:

- `FIDUCIA_E2E_SELENIUM_URL` — Grid endpoint (default `http://localhost:4444`;
  `SELENIUM_REMOTE_URL` honored as a fallback).
- `FIDUCIA_E2E_PUBLIC_BASE_URL` — when the Grid runs remotely (in-cluster), its
  browser cannot reach the runner's `127.0.0.1` stack; this rewrites the
  target origin to one the Grid can reach.

An unreachable Grid skips the Selenium suite cleanly (with the reason).
