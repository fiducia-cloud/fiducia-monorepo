// Smoke: the primary endpoint answers /healthz and /v1/status.
// Skips cleanly when no endpoint is configured.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeClient } from "../src/endpoints.mjs";
import { assertHealthyNodeStatus, NO_ENDPOINT, skipIfUndeployed } from "./helpers.mjs";

describe("smoke / reachability", { skip: NO_ENDPOINT }, () => {
  it("GET /healthz returns a status", async (t) => {
    const c = makeClient();
    await skipIfUndeployed(t, "GET /healthz", async () => {
      const health = await c.health();
      // PROTOCOL.md: health() -> {status, service}
      assert.deepEqual(health, { status: "ok", service: "fiducia-node" });
    });
  });

  it("GET /v1/status reports consensus", async (t) => {
    const c = makeClient();
    await skipIfUndeployed(t, "GET /v1/status", async () => {
      const status = await c.status();
      assertHealthyNodeStatus(status);
    });
  });
});
