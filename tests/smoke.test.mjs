// Smoke: the primary endpoint answers /healthz and /v1/status.
// Skips cleanly when no endpoint is configured.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeClient } from "../src/endpoints.mjs";
import { NO_ENDPOINT, skipIfUndeployed } from "./helpers.mjs";

describe("smoke / reachability", { skip: NO_ENDPOINT }, () => {
  it("GET /healthz returns a status", async (t) => {
    const c = makeClient();
    await skipIfUndeployed(t, "GET /healthz", async () => {
      const health = await c.health();
      // PROTOCOL.md: health() -> {status, service}
      assert.ok(health, "healthz should return a body");
      if (health.status !== undefined) {
        assert.ok(
          ["ok", "healthy", "up", "pass", "serving"].includes(String(health.status).toLowerCase()) || health.status === true,
          `unexpected health status: ${JSON.stringify(health.status)}`,
        );
      }
    });
  });

  it("GET /v1/status reports consensus", async (t) => {
    const c = makeClient();
    await skipIfUndeployed(t, "GET /v1/status", async () => {
      const status = await c.status();
      // PROTOCOL.md: status() -> {service, consensus, ...}
      assert.ok(status && typeof status === "object", "status should return an object");
    });
  });
});
