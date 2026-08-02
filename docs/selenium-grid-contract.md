# Selenium Grid contract proof

The full browser journeys exercise product behavior. The smaller Grid contract proof answers a different question: can this repository still establish a real RemoteWebDriver Chromium session against the same Selenium version deployed by `ORESoftware/k8s-cluster`?

GitHub Actions runs `scripts/selenium-grid-smoke.mjs` against `selenium/standalone-chromium:4.27.0`. The proof waits for `/status`, opens a WebDriver session, navigates a browser-owned `data:` document, verifies DOM execution and `navigator.webdriver`, records browser capabilities, takes a screenshot, and uploads the evidence for 14 days.

This job is deliberately independent of the composed Rust web stack. A failure therefore isolates Grid startup, WebDriver negotiation, Chromium launch, or the JavaScript client contract without waiting for three Rust services and scratch PostgreSQL.

## Endpoint rules

`FIDUCIA_E2E_SELENIUM_URL` and `SELENIUM_REMOTE_URL` must be HTTP(S) origins only. Credentials, paths, query strings, fragments, and non-HTTP schemes are rejected before a status probe or browser launch. This prevents accidental token leakage and ambiguous `/status` routing.

`FIDUCIA_E2E_PUBLIC_BASE_URL` follows the same origin-only rule. `publicUrlFor()` still preserves the composed stack's dynamic port when the override omits one, or uses the explicitly supplied port when present.

## Local run

```bash
docker run --rm -d --name fiducia-grid -p 4444:4444 --shm-size=2g \
  selenium/standalone-chromium:4.27.0
npm ci --ignore-scripts
FIDUCIA_E2E_SELENIUM_URL=http://127.0.0.1:4444 \
  npm run test:selenium-grid
```

Artifacts are written under `artifacts/selenium-grid/` by default. No production endpoint, account, cookie, API key, or application secret is used.
