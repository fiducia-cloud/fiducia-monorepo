# tests/browser — real-Chromium login journeys

Drives the composed web/auth stack (the same one `tests/webapps/` boots: real
`fiducia-auth` + `fiducia-admin` + `fiducia-customer` from sibling checkouts,
stub Supabase, scratch Postgres) through **actual browsers** instead of
`fetch`. The browser is what makes it new coverage: Chromium follows the
redirects, submits the real HTML forms, keeps the cookie jar, enforces
HttpOnly/SameSite, and executes the pages' JS.

The stack boots once; two drivers run against it:

| Driver | Journey |
|--------|---------|
| **Playwright** | the operator happy path — land on `/login`, sign in through the form, read the dashboard, verify the jar's `fiducia_admin_session` is HttpOnly + SameSite=Strict (and invisible to `document.cookie`), sign out through the UI and stay locked out |
| **Puppeteer** | the separation/negative paths — a customer's *valid* Supabase credentials bounce off the admin role gate (403 page, empty jar), a wrong password renders the alert with no cookie, a signed-out deep link lands back on `/login`, and the customer SPA shell serves |

## Running

```sh
npm run test:browser        # sets FIDUCIA_E2E_BROWSER=1 + FIDUCIA_E2E_WEBAPPS=1
```

Preconditions on top of the web-app stack's own (sibling checkouts, Postgres
tools): `playwright` and `puppeteer` installed (`npm ci`), plus their browser
binaries — `npx playwright install chromium`; Puppeteer downloads Chrome for
Testing during `npm ci`. Without the env gate the suite skips cleanly, so
plain `npm test` stays safe.
