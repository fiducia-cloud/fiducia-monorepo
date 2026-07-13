import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateEndpoint } from "./endpoints.mjs";

describe("endpoint validation", () => {
  it("normalizes a credential-free HTTPS origin", () => {
    assert.equal(validateEndpoint("https://api.example.test/"), "https://api.example.test");
  });

  it("rejects authority-confusing URL components", () => {
    for (const value of [
      "https://user@api.example.test",
      "https://api.example.test?target=elsewhere",
      "https://api.example.test#fragment",
    ]) {
      assert.throws(() => validateEndpoint(value), /must not contain/);
    }
  });

  it("requires HTTPS except for an explicitly enabled localhost harness", () => {
    assert.throws(() => validateEndpoint("http://api.example.test"), /require HTTPS/);
    assert.throws(() => validateEndpoint("http://127.0.0.1:8090"), /require HTTPS/);
    assert.equal(validateEndpoint("http://127.0.0.1:8090", true), "http://127.0.0.1:8090");
    assert.throws(() => validateEndpoint("http://api.example.test", true), /require HTTPS/);
  });
});
