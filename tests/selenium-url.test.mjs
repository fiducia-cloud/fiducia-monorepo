import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSeleniumOrigin,
  seleniumRemoteUrl,
} from "../src/selenium-url.mjs";

test("normalizes explicit HTTP and HTTPS Grid origins", () => {
  assert.equal(
    normalizeSeleniumOrigin(" https://grid.example.test:4444/ "),
    "https://grid.example.test:4444",
  );
  assert.equal(
    seleniumRemoteUrl("http://127.0.0.1:4444/"),
    "http://127.0.0.1:4444",
  );
});

test("rejects credentials, suffixes, relative values, and non-web schemes", () => {
  for (const value of [
    "http://user:secret@localhost:4444",
    "http://localhost:4444/wd/hub",
    "http://localhost:4444?token=secret",
    "http://localhost:4444#fragment",
    "file:///tmp/selenium.sock",
    "localhost:4444",
    "",
  ]) {
    assert.throws(() => seleniumRemoteUrl(value), /Selenium Grid endpoint/);
  }
});

test("uses the explicit Fiducia variable before the Selenium fallback", () => {
  const originalFiducia = process.env.FIDUCIA_E2E_SELENIUM_URL;
  const originalFallback = process.env.SELENIUM_REMOTE_URL;
  try {
    process.env.FIDUCIA_E2E_SELENIUM_URL = "https://fiducia-grid.example.test:4444";
    process.env.SELENIUM_REMOTE_URL = "https://fallback-grid.example.test:4444";
    assert.equal(
      seleniumRemoteUrl(),
      "https://fiducia-grid.example.test:4444",
    );
  } finally {
    if (originalFiducia === undefined) delete process.env.FIDUCIA_E2E_SELENIUM_URL;
    else process.env.FIDUCIA_E2E_SELENIUM_URL = originalFiducia;
    if (originalFallback === undefined) delete process.env.SELENIUM_REMOTE_URL;
    else process.env.SELENIUM_REMOTE_URL = originalFallback;
  }
});
