// Conformance: counting semaphores (a mutex generalized to N holders).
//
// Real-world framing: capping concurrent calls to a rate-limited third-party
// API, license/seat pools, a GPU pool, a DB connection-pool ceiling.
// Invariant: up to `limit` holders succeed; holder limit+1 is refused; a
// release admits the next.
//
// Routes/bodies per fiducia-clients/PROTOCOL.md ("Semaphores — live").

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { output } from "../../src/client.mjs";
import { makeClient } from "../../src/endpoints.mjs";
import { NO_ENDPOINT, uniqueKey, uniqueId, skipIfUndeployed } from "../helpers.mjs";

const TTL = 30_000;

describe("semaphores / counting leases", { skip: NO_ENDPOINT }, () => {
  it("admits up to `limit` holders, refuses limit+1, release admits the next", async (t) => {
    const c = makeClient();
    const key = uniqueKey("sem");
    const limit = 2;
    const h1 = uniqueId("h1");
    const h2 = uniqueId("h2");
    const h3 = uniqueId("h3");

    await skipIfUndeployed(t, "POST /v1/semaphores/acquire", async () => {
      const a1 = output(await c.semaphoreAcquire(key, { holder: h1, ttlMs: TTL, limit }));
      assert.equal(a1.acquired, true, "1st holder within limit should acquire");

      const a2 = output(await c.semaphoreAcquire(key, { holder: h2, ttlMs: TTL, limit }));
      assert.equal(a2.acquired, true, "2nd holder within limit should acquire");

      // WRONG BEHAVIOR => FAIL: the (limit+1)th concurrent holder must not get a permit.
      const a3 = output(await c.semaphoreAcquire(key, { holder: h3, ttlMs: TTL, limit }));
      assert.notEqual(a3.acquired, true, "holder over the limit must be refused/queued");

      // Releasing one permit should admit the waiting holder.
      await c.semaphoreRelease(key, { holder: h1, fencingToken: a1.fencing_token });
      const a3b = output(await c.semaphoreAcquire(key, { holder: h3, ttlMs: TTL, limit }));
      assert.equal(a3b.acquired, true, "after a release, the next holder should be admitted");

      await c.semaphoreRelease(key, { holder: h2, fencingToken: a2.fencing_token });
      await c.semaphoreRelease(key, { holder: h3, fencingToken: a3b.fencing_token });
    });
  });

  it("each holder gets a distinct fencing token", async (t) => {
    const c = makeClient();
    const key = uniqueKey("sem-tokens");
    const limit = 2;
    const h1 = uniqueId("h1");
    const h2 = uniqueId("h2");

    await skipIfUndeployed(t, "POST /v1/semaphores/acquire (tokens)", async () => {
      const a1 = output(await c.semaphoreAcquire(key, { holder: h1, ttlMs: TTL, limit }));
      const a2 = output(await c.semaphoreAcquire(key, { holder: h2, ttlMs: TTL, limit }));
      assert.equal(a1.acquired, true);
      assert.equal(a2.acquired, true);
      if (typeof a1.fencing_token === "number" && typeof a2.fencing_token === "number") {
        assert.notEqual(a1.fencing_token, a2.fencing_token, "concurrent holders need distinct tokens");
      } else {
        t.skip("endpoint did not return numeric fencing tokens");
      }
      await c.semaphoreRelease(key, { holder: h1, fencingToken: a1.fencing_token });
      await c.semaphoreRelease(key, { holder: h2, fencingToken: a2.fencing_token });
    });
  });
});
