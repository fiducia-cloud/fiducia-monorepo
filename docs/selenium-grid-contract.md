# Selenium Grid contract proof

The full browser journeys exercise product behavior. This smaller proof answers a different question: can the repository still establish a real RemoteWebDriver Chromium session against the Selenium version deployed by `ORESoftware/k8s-cluster`?

GitHub Actions runs `scripts/selenium-grid-smoke.mjs` against the immutable `selenium/standalone-chromium:4.27.0` image digest previously proven by the hosted runner. The proof waits for `/status`, opens a WebDriver session, navigates a browser-owned `data:` document, verifies DOM execution and `navigator.webdriver`, records browser capabilities, takes a screenshot, and uploads evidence for 14 days.

This job is deliberately independent of the composed Rust web stack. A failure isolates Grid startup, WebDriver negotiation, Chromium launch, or the JavaScript binding without waiting for three Rust services and scratch PostgreSQL.

## Endpoint rules

`FIDUCIA_E2E_SELENIUM_URL` and `SELENIUM_REMOTE_URL` must be absolute HTTP(S) origins. Credentials, paths, query strings, fragments, relative values, and non-web schemes are rejected before a status probe or browser launch. The dedicated Selenium rule lives in `src/selenium-url.mjs`.

`FIDUCIA_E2E_PUBLIC_BASE_URL` remains governed separately by `src/browser-url.mjs`. The Grid proof does not duplicate or weaken that already-merged routing contract.

## Local run

```bash
docker run --rm -d --name fiducia-grid -p 4444:4444 --shm-size=2g \
  selenium/standalone-chromium@sha256:29fef1e6cd5eca4ccad32d399d3b6177c44305ea31d59f18dff7500ea7d03809
npm ci --ignore-scripts
FIDUCIA_E2E_SELENIUM_URL=http://127.0.0.1:4444 \
  npm run test:selenium-grid
```

Artifacts are written under `artifacts/selenium-grid/` by default. No production endpoint, account, cookie, API key, or application secret is used.
