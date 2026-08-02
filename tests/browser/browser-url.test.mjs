import assert from "node:assert/strict";
import test from "node:test";

import { publicUrlFor } from "../../src/browser-url.mjs";

test("publicUrlFor is identity when no public origin is configured", () => {
  const local = "http://127.0.0.1:19421/login?next=%2Fapp#top";
  assert.equal(publicUrlFor(local, undefined), local);
});

test("publicUrlFor swaps protocol and hostname but preserves an allocated port", () => {
  assert.equal(
    publicUrlFor("http://127.0.0.1:19421/login?next=%2Fapp", "http://host.docker.internal"),
    "http://host.docker.internal:19421/login?next=%2Fapp",
  );
});

test("an explicitly pinned public port overrides the stack port", () => {
  assert.equal(
    publicUrlFor("http://127.0.0.1:19421/app", "https://grid-tunnel.example.test:8443"),
    "https://grid-tunnel.example.test:8443/app",
  );
});

for (const [label, value] of [
  ["credentials", "http://user:secret@grid.example.test"],
  ["path", "http://grid.example.test/base"],
  ["query", "http://grid.example.test/?tenant=one"],
  ["fragment", "http://grid.example.test/#test"],
  ["non-web scheme", "file:///tmp/browser"],
  ["relative value", "grid.example.test"],
]) {
  test(`public origin rejects ${label}`, () => {
    assert.throws(
      () => publicUrlFor("http://127.0.0.1:19421/app", value),
      /FIDUCIA_E2E_PUBLIC_BASE_URL/,
    );
  });
}

test("stack URL rejects non-web schemes even without an override", () => {
  assert.throws(() => publicUrlFor("file:///tmp/app", undefined), /stackUrl/);
});
