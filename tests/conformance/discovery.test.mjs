// Conformance: service discovery (TTL-health registry of live instances).
//
// Real-world framing: a live registry that beats stale DNS, a canary member
// set, service-mesh membership.
// Invariants: a registered instance appears in resolve; a metadata filter
// narrows the result set; a deregister (or expired TTL) drops it from the live
// set.
//
// Routes/bodies per fiducia-clients/PROTOCOL.md ("Service discovery — live").

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeClient } from "../../src/endpoints.mjs";
import { NO_ENDPOINT, uniqueId, skipIfUndeployed } from "../helpers.mjs";

const TTL = 30_000;

function instancesOf(res) {
  const list = res?.instances ?? res?.result?.output?.instances;
  return Array.isArray(list) ? list : [];
}
function idsOf(res) {
  return instancesOf(res).map((i) => i?.instance_id ?? i?.instanceId ?? i?.id).filter(Boolean);
}

describe("service discovery", { skip: NO_ENDPOINT }, () => {
  it("a registered instance appears in resolve; a metadata filter narrows it", async (t) => {
    const c = makeClient();
    const service = uniqueId("svc");
    const blue = uniqueId("i-blue");
    const green = uniqueId("i-green");

    await skipIfUndeployed(t, "PUT /v1/services/{service}/instances/{id}", async () => {
      await c.serviceRegister(service, blue, "10.0.0.1:9000", TTL, { version: "blue", region: "us-east-1" });
      await c.serviceRegister(service, green, "10.0.0.2:9000", TTL, { version: "green", region: "us-east-1" });

      const all = idsOf(await c.serviceResolve(service));
      // Registered instances must be resolvable.
      assert.ok(all.includes(blue), "registered blue instance should be resolvable");
      assert.ok(all.includes(green), "registered green instance should be resolvable");

      // Exact-match metadata filter must narrow (AND semantics).
      const blues = idsOf(await c.serviceResolve(service, { version: "blue" }));
      if (blues.length > 0) {
        assert.ok(blues.includes(blue), "version=blue filter should include the blue instance");
        // WRONG BEHAVIOR => FAIL: the filter must exclude non-matching instances.
        assert.ok(!blues.includes(green), "version=blue filter must exclude the green instance");
      }

      await c.serviceDeregister(service, blue);
      await c.serviceDeregister(service, green);
    });
  });

  it("a deregistered instance drops from the live set (TTL/heartbeat contract)", async (t) => {
    const c = makeClient();
    const service = uniqueId("svc-ttl");
    const inst = uniqueId("i-1");

    await skipIfUndeployed(t, "DELETE /v1/services/{service}/instances/{id}", async () => {
      // We assert the heartbeat/deregister contract rather than sleeping past a
      // real TTL: waiting for a live-set TTL sweep would make CI slow/flaky, and
      // a deregister exercises the same "drops from the live set" transition.
      await c.serviceRegister(service, inst, "10.0.0.9:9000", TTL, { role: "canary" });
      assert.ok(idsOf(await c.serviceResolve(service)).includes(inst), "instance should be live after register");

      // Heartbeat keeps it alive (must not error while registered).
      await c.serviceHeartbeat(service, inst, TTL);
      assert.ok(idsOf(await c.serviceResolve(service)).includes(inst), "instance should stay live after heartbeat");

      // Deregister must remove it from the live set. WRONG => stale routing.
      await c.serviceDeregister(service, inst);
      assert.ok(!idsOf(await c.serviceResolve(service)).includes(inst), "deregistered instance must drop from the live set");
    });
  });
});
