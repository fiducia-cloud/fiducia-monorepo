# Browser automation: Selenium · Playwright · Puppeteer

The `tests/browser/`, `tests/chaos/`, and `tests/multicluster/` tiers drive the
product through **real browsers** instead of `fetch`. That is what makes them
worth having on top of the fetch-level specs: the browser enforces redirects,
form encoding, the cookie jar, `HttpOnly`/`SameSite`, and the pages' JS.

Three automation stacks each certify the same journeys, so a regression in the
product — or in any one driver's contract — is caught:

| Stack | How it gets a browser | Notes |
|-------|-----------------------|-------|
| **Playwright** | downloads + drives its own Chromium | `npx playwright install chromium` |
| **Puppeteer** | downloads Chrome for Testing during `npm ci` | bundled |
| **Selenium** | talks WebDriver to an **existing** Selenium Grid | needs a reachable Grid — see below |

## Layout: one folder per automation stack

Browser-automation specs live in a subfolder named for the framework that drives
them. Plain (fetch-level, no browser) specs stay directly under `tests/<tier>/`.

```
tests/
├── browser/                    # rides the composed web/auth stack (boots it locally)
│   ├── playwright/             #   login + customer/MFA happy paths, API-key lifecycle,
│   │                           #   account shells, admin dashboard content
│   ├── puppeteer/              #   separation/negative paths, API-key lifecycle,
│   │                           #   admin dashboard nav
│   └── selenium/               #   admin + customer login journeys, admin nav (over a Grid)
├── chaos/{selenium,playwright,puppeteer}/       # health surfaces through a browser,
│                                                #   across a disrupt→heal cycle
└── multicluster/{selenium,playwright,puppeteer}/ # every cluster serves a browser
```

Shared launch/gate helpers live in [`src/browser.mjs`](../src/browser.mjs); the
shared chaos/multicluster journeys live in
[`src/browser-endpoints.mjs`](../src/browser-endpoints.mjs).

## Two worlds: the composed stack vs. deployed endpoints

- **`tests/browser/`** boots the **composed web/auth stack** locally
  ([`src/webapps.mjs`](../src/webapps.mjs)): real `fiducia-auth` +
  `fiducia-admin` + `fiducia-customer` from sibling checkouts, a stub Supabase,
  and a scratch Postgres. The first boot compiles three Rust servers (≈15 min
  cold; the `before()` hooks allow 900 s), so each file boots the stack **once**
  and shares it. No external endpoint is involved.
- **`tests/chaos/` and `tests/multicluster/`** ride the **same deployed
  endpoints** as their fetch-level siblings (`endpoints()` / the validated proof
  topology), proving those already-running services through a browser transport.

## Running

```sh
npm run test:browser              # all three frameworks (recursive glob)
npm run test:browser:playwright   # one framework at a time
npm run test:browser:puppeteer
npm run test:browser:selenium

npm run test:chaos:browser         # browser-driven chaos (all three frameworks)
npm run test:multicluster:browser  # browser-driven multicluster (all three)
```

`npm run test:browser` sets `FIDUCIA_E2E_BROWSER=1` **and**
`FIDUCIA_E2E_WEBAPPS=1` (the composed-stack gate). Without the env gate every
browser suite **skips cleanly**, so plain `npm test` stays safe and offline.

## The Selenium Grid

Selenium does not download a browser — it drives an **existing** Selenium
server. Use the org's long-lived Grid deployed in `~/codes/ores/k8s-cluster`
(`dd-selenium-server`), or any local
`docker run -p 4444:4444 selenium/standalone-chromium`. The deployed Grid's
`:4444` is pod-internal (the Service only publishes the `:8105` Java API), so
forward the **deployment**, not the service:

```sh
KUBECTL_NO_CONFIRM=1 kubectl --context dd-ec2-admin \
  port-forward deploy/dd-selenium-server 4444:4444 -n default
npm run test:browser:selenium
```

See [remote-browser-servers.md](remote-browser-servers.md) for the full
AWS/Hetzner access story, the localhost-target caveat, and why only Selenium
(not Playwright/Puppeteer) works through a port-forwarded Grid.

| Var | Meaning |
|-----|---------|
| `FIDUCIA_E2E_SELENIUM_URL` | Grid endpoint (default `http://localhost:4444`; `SELENIUM_REMOTE_URL` is honored as a fallback) |
| `FIDUCIA_E2E_PUBLIC_BASE_URL` | origin-only HTTP(S) base used when a remote Grid cannot reach the runner's `127.0.0.1` stack; protocol/hostname are replaced and a dynamic stack port is preserved unless this value pins a port |

`FIDUCIA_E2E_PUBLIC_BASE_URL` is validated as an origin, not a general URL: credentials, paths, queries, fragments, relative values, and non-HTTP(S) schemes fail before a browser session is used.

`seleniumSkipReason()` probes the Grid's `/status` once — an **unreachable Grid
skips the suite cleanly with the reason**, it never hangs or hard-fails.

## Patterns you must follow (learned the hard way)

The composed apps are progressively enhanced with **htmx**. Two techniques keep
browser journeys deterministic and honest; mixing them up produces flaky or
false-green tests.

### 1. Neutralise htmx for deterministic top-level navigation

For login and page-to-page navigation, stub out `/assets/htmx.min.js` so the
forms submit **natively** (`POST /login → 303 /app`) and there is a real
navigation to wait on. This also exercises the no-JS baseline the servers fully
support.

- Playwright: `context.route(url => url.pathname.endsWith("/assets/htmx.min.js"), route => route.fulfill({ body: "" }))`
- Puppeteer: `page.setRequestInterception(true)` + `request.respond({ body: "" })` for that asset
- **Selenium: `neutralizeHtmxForms(driver)`** (from `src/browser.mjs`). WebDriver
  has no request interception, so instead of blocking the asset it disables htmx
  **in the page**: it strips the `hx-*` attributes AND replaces each enhanced
  form with a clone. The clone matters — htmx binds its `submit` handler
  *directly* to the form during processing, so `removeAttribute("hx-post")` alone
  leaves that listener attached and the submit still AJAX-swaps. Because cloning
  drops the values typed into a form's inputs, call it **before** filling the
  form, then locate and fill the surviving clone. (The admin `/login` is a plain
  `method="post"` form and needs none of this; only the customer `/login` does.)

**Origin guard (non-loopback browsers).** The admin/customer servers enforce
`require_host` + `require_same_origin` on state-changing POSTs. Over a Grid whose
browser reaches the stack through a non-loopback host (`FIDUCIA_E2E_PUBLIC_BASE_URL`,
e.g. `host.docker.internal`), the debug-default origin `http://127.0.0.1:PORT` no
longer matches and sign-in is rejected with `reason:"mismatched_host"`.
`bootWebAppStack()` (`src/webapps.mjs` → `originForwarding`) pins each server's
port and advertises the matching public origin so `Host`/`Origin` line up. Local
Playwright/Puppeteer drive `http://127.0.0.1` directly and need no rewrite.

### 2. Drive htmx **fragment** endpoints through the page's own `fetch`

Management surfaces (API keys, preferences, activity) render their content into
an `#…-results` div via `hx-post`/`hx-get`. With htmx neutralised that content
never loads, so drive the **exact endpoint htmx would call** from the page
context — same cookie jar, same origin:

```js
const created = await page.evaluate(async (name) => {
  const form = document.querySelector('form[method="post"][action="/app/api-keys"]');
  const body = new URLSearchParams();
  for (const el of form.querySelectorAll("input[name]")) body.set(el.name, el.value);
  body.set("name", name);
  const res = await fetch("/app/api-keys", { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
  return { status: res.status, html: await res.text() };
}, keyName);
```

### Gotchas that will bite you

- **Hidden inputs are never "visible".** `page.waitForSelector` defaults to the
  visible state and will time out on `input[type=hidden]`. Wait for a visible
  field (e.g. `input[name="name"]`) instead, or pass `{ state: "attached" }`.
- **Duplicate `action` attributes.** The customer sidebar org-switcher and the
  API-key create form **both** have `action="/app/api-keys"`. Disambiguate by
  method: `form[method="post"][action="/app/api-keys"]`.
- **DB-backed fragments 503 in the stub stack.** The auth-backed API-key
  fragment round-trips fully, but the preference/activity/notification fragments
  query the customer DB, which the composed stub stack does not seed — they
  return **503**. Certify what the stack supports for those: the authenticated
  page shell + active-tab nav, the fragment's auth boundary, and signed-out
  gating (see `customer-account-journeys.test.mjs`).
- **Admin vs. customer chrome differ.** The customer app uses
  `header.topbar`; the admin app uses `nav.nav`. Don't assert one on the other.
- **Preconditions.** The composed stack needs the sibling `.rs` checkouts, a
  rustup toolchain matching the servers' pin, and Postgres tools
  (`initdb`/`pg_ctl`) on `PATH`. `webAppsSkipReason()` / `browserSkipReason()`
  report exactly what's missing.

## What each browser suite certifies

- **Login/auth** — land on `/login`, sign in through the real form, reach the
  dashboard, prove the session cookie is `HttpOnly` + `SameSite=Strict` and
  unreadable from `document.cookie`, sign out and stay locked out; passwordless
  email-OTP; TOTP enrol/activate and the aal1→aal2 login step-up (interim state
  rides the MFA-pending cookie, never the session cookie).
- **Separation** — a customer credential cannot enter admin and an admin cookie
  carries no authority on `/app`; a forged login CSRF token is rejected with no
  cookie; the anonymous origin leaks no session/PII.
- **Customer API keys** — full lifecycle: create reveals a one-time
  `fdc_{env}_{key_id}.{secret}` exactly once, list shows the key, **rotate**
  issues a fresh secret, **revoke** drops it from the active set, a **forged
  CSRF token** is rejected with no key issued, signed-out access bounces.
- **Customer account** — the Settings/Activity/Notifications shells + active-tab
  nav, the data fragments' auth boundary, signed-out gating.
- **Admin dashboard** — the operator reaches every nav page and each renders its
  real server `<h1>` (Dashboard / Cluster & infra / Cluster insight / Operator
  audit / Broadcast notices); every deep link is gated when signed out.
- **Chaos / multicluster** — every configured endpoint's health surface serves
  and renders in a real browser, keeps serving the survivors while one cluster
  is disrupted (only with `FIDUCIA_E2E_ALLOW_DISRUPTIVE=1` + a validated
  topology), and recovers after heal.
