import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeBrowserOrigin,
  publicUrlFor,
  seleniumRemoteUrl,
} from "../src/browser.mjs";

test("normalizes explicit browser-control origins", () => {
  assert.equal(
    normalizeBrowserOrigin(" https://grid.example.test:4444/ "),
    "https://grid.example.test:4444",
  );
  assert.equal(seleniumRemoteUrl("http://127.0.0.1:4444/"), "http://127.0.0.1:4444");
});

test("rejects browser-control endpoints with credentials or URL suffixes", () => {
  for (const value of [
    "http://user:secret@localhost:4444",
    "http://localhost:4444/wd/hub",
    "http://localhost:4444?token=secret",
    "http://localhost:4444#fragment",
    "file:///tmp/selenium.sock",
  ]) {
    assert.throws(() => seleniumRemoteUrl(value), /Selenium Grid endpoint/);
  }
});

test("publicUrlFor swaps the origin while preserving the composed stack port", () => {
  assert.equal(
    publicUrlFor(
      "http://127.0.0.1:19753/login?next=%2Fapp",
      "http://host.docker.internal",
    ),
    "http://host.docker.internal:19753/login?next=%2Fapp",
  );
  assert.equal(
    publicUrlFor(
      "http://127.0.0.1:19753/login",
      "https://browser-tunnel.example.test:8443",
    ),
    "https://browser-tunnel.example.test:8443/login",
  );
});

test("publicUrlFor rejects credential-bearing or path-bearing overrides", () => {
  for (const value of [
    "https://user:secret@browser.example.test",
    "https://browser.example.test/tunnel",
    "https://browser.example.test?token=secret",
    "javascript:alert(1)",
  ]) {
    assert.throws(
      () => publicUrlFor("http://127.0.0.1:19753/login", value),
      /FIDUCIA_E2E_PUBLIC_BASE_URL/,
    );
  }
});

test("publicUrlFor remains an identity when no override is configured", () => {
  const url = "http://127.0.0.1:19753/login";
  assert.equal(publicUrlFor(url, ""), url);
});
