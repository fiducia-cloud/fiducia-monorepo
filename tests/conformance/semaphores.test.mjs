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

import { HttpError, output } from "../../src/client.mjs";
import { makeClient } from "../../src/endpoints.mjs";
import {
  capabilityOrSkip,
  NO_ENDPOINT,
  uniqueKey,
  uniqueId,
  skipIfUndeployed,
} from "../helpers.mjs";

const TTL = 30_000;

describe("semaphores / counting leases", { skip: NO_ENDPOINT }, () => {
  it("requires an explicit nonempty holder and a positive ttl_ms", async (t) => {
    const c = makeClient();
    const key = uniqueKey("sem-validation");
    const rejectsBadRequest = (promise, label) => assert.rejects(
      promise,
      (error) => error instanceof HttpError && error.status === 400,
      label,
    );
    await skipIfUndeployed(t, "POST /v1/semaphores/acquire (required fields)", async () => {
      await rejectsBadRequest(
        c.semaphoreAcquire(key, { ttlMs: TTL, limit: 1 }),
        "missing holder must be rejected",
      );
      await rejectsBadRequest(
        c.semaphoreAcquire(key, { holder: "", ttlMs: TTL, limit: 1 }),
        "empty holder must be rejected",
      );
      await rejectsBadRequest(
        c.semaphoreAcquire(key, { holder: uniqueId("holder"), ttlMs: 0, limit: 1 }),
        "ttl_ms=0 must be rejected",
      );
    });
  });

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

  it("treats the initial limit as immutable and reports exact limit_mismatch", async (t) => {
    const c = makeClient();
    const key = uniqueKey("sem-immutable-limit");
    const firstHolder = uniqueId("limit-owner");
    const secondHolder = uniqueId("limit-contender");

    await skipIfUndeployed(t, "POST /v1/semaphores/acquire (immutable limit)", async () => {
      const first = output(await c.semaphoreAcquire(key, {
        holder: firstHolder,
        ttlMs: TTL,
        limit: 1,
        requestId: uniqueId("limit-owner-attempt"),
      }));
      assert.equal(first.acquired, true, "first acquisition fixes the semaphore limit");

      const mismatch = output(await c.semaphoreAcquire(key, {
        holder: secondHolder,
        ttlMs: TTL,
        limit: 2,
        requestId: uniqueId("limit-mismatch-attempt"),
      }));
      assert.equal(mismatch.acquired, false, "a later caller cannot silently raise capacity");
      assert.equal(mismatch.queued, false, "a mismatched limit is not a valid waiter");
      assert.equal(mismatch.reason, "limit_mismatch", "capacity mismatch is explicit");
      assert.equal(mismatch.limit, 1, "response preserves the authoritative limit");
      assert.equal(mismatch.requested_limit, 2, "response reports the rejected limit");

      await c.semaphoreRelease(key, {
        holder: firstHolder,
        fencingToken: first.fencing_token,
      });
    });
  });

  it("a count-3 semaphore holds exactly 3 concurrent holders — no fewer, no more", async (t) => {
    const c = makeClient();
    const key = uniqueKey("sem-three");
    const limit = 3;
    const holders = [uniqueId("w1"), uniqueId("w2"), uniqueId("w3")];

    await skipIfUndeployed(t, "POST /v1/semaphores/acquire (limit=3)", async () => {
      // All three distinct workers must hold permits SIMULTANEOUSLY (no
      // releases in between) — a semaphore of 3 is three concurrent mutexes'
      // worth of capacity on one key.
      const grants = [];
      for (const holder of holders) {
        const g = output(await c.semaphoreAcquire(key, { holder, ttlMs: TTL, limit }));
        assert.equal(g.acquired, true, `${holder} within count=3 must acquire`);
        grants.push(g);
      }

      // WRONG BEHAVIOR => FAIL: the 4th concurrent holder must be refused
      // while all three permits are live.
      const fourth = output(
        await c.semaphoreAcquire(key, { holder: uniqueId("w4"), ttlMs: TTL, limit }),
      );
      assert.notEqual(fourth.acquired, true, "4th concurrent holder must not exceed count=3");

      // The semaphore's own state confirms 3 live holders at once.
      const state = output(await c.semaphoreGet(key));
      const live =
        state?.holders?.length ?? state?.semaphore?.holders?.length ?? state?.held_count;
      if (live !== undefined) {
        assert.equal(Number(live), 3, "exactly 3 permits must be live concurrently");
      }

      for (let i = 0; i < holders.length; i += 1) {
        await c.semaphoreRelease(key, {
          holder: holders[i],
          fencingToken: grants[i].fencing_token,
        });
      }
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
      if (capabilityOrSkip(
        t,
        typeof a1.fencing_token === "number" && typeof a2.fencing_token === "number",
        "endpoint did not return numeric fencing tokens",
      )) {
        assert.notEqual(a1.fencing_token, a2.fencing_token, "concurrent holders need distinct tokens");
      }
      await c.semaphoreRelease(key, { holder: h1, fencingToken: a1.fencing_token });
      await c.semaphoreRelease(key, { holder: h2, fencingToken: a2.fencing_token });
    });
  });

  it("explicit same-holder renew preserves its permit token and extends expiry", async (t) => {
    const c = makeClient();
    const key = uniqueKey("sem-renew");
    const holder = uniqueId("renewing-holder");

    await skipIfUndeployed(t, "POST /v1/semaphores/renew (token-bound renewal)", async () => {
      const first = output(await c.semaphoreAcquire(key, {
        holder,
        ttlMs: 5_000,
        limit: 1,
      }));
      assert.equal(first.acquired, true, "initial permit is granted");
      assert.equal(typeof first.fencing_token, "number", "initial permit has a fencing token");
      assert.equal(typeof first.lease_expires_ms, "number", "initial permit has an expiry");

      await new Promise((resolve) => setTimeout(resolve, 25));
      const renewed = output(await c.semaphoreRenew(key, {
        holder,
        fencingToken: first.fencing_token,
        ttlMs: 30_000,
      }));
      assert.equal(renewed.renewed, true, "response explicitly reports renewal");
      assert.equal(
        renewed.fencing_token,
        first.fencing_token,
        "renewal must preserve the permit fencing token",
      );
      assert.ok(
        renewed.lease_expires_ms > first.lease_expires_ms,
        "renewal must extend lease_expires_ms",
      );
      await c.semaphoreRelease(key, { holder, fencingToken: first.fencing_token });
    });
  });
});
