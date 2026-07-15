// Conformance: TTL leases — the crash-safety half of every grant.
//
// Real-world framing: a worker that acquired a lock (or semaphore permit) and
// then DIED must not wedge the resource forever. Its lease expires, the grant
// is reclaimed, and the next requester proceeds — with a HIGHER fencing token,
// so anything the dead holder left behind is fenced off downstream.
//
// These are deliberately real-time tests (short TTLs + polling): they prove
// expiry through the full stack — HTTP → shard leader → replicated state
// machine TTL sweep — not just the state machine's unit tests
// (fiducia-node.rs state.rs `expired_lock_grant_promotes_waiter_with_new_token`
// and `expired_semaphore_permit_promotes_fifo_waiter` cover that layer).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { output } from "../../src/client.mjs";
import { makeClient } from "../../src/endpoints.mjs";
import { NO_ENDPOINT, uniqueKey, uniqueId, skipIfUndeployed } from "../helpers.mjs";

const SHORT_TTL = 1_500; // the dying holder's lease
const DEADLINE_MS = 15_000; // how long we allow the cluster to reclaim it
const POLL_MS = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `attempt` until it reports acquired or the deadline passes. */
async function acquireEventually(attempt, deadlineMs = DEADLINE_MS) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const res = await attempt();
    if (res?.acquired === true) return res;
    if (Date.now() > until) return res;
    await sleep(POLL_MS);
  }
}

describe("ttl leases", { skip: NO_ENDPOINT }, () => {
  it("a dead lock holder's lease expires; the next holder gets a higher fencing token", async (t) => {
    const c = makeClient();
    const key = uniqueKey("lease-lock");
    const dead = uniqueId("dead-worker");
    const heir = uniqueId("heir-worker");

    await skipIfUndeployed(t, "POST /v1/locks/acquire (ttl expiry)", async () => {
      const grant = output(await c.tryLock(key, { holder: dead, ttlMs: SHORT_TTL }));
      assert.equal(grant.acquired, true, "the doomed holder acquires first");
      const deadToken = grant.fencing_token;
      // `dead` now crashes: no renew, no release.

      // While the lease is still live, the heir must be refused.
      const early = output(await c.tryLock(key, { holder: heir, ttlMs: 30_000 }));
      assert.notEqual(early.acquired, true, "the lease must hold until it expires");

      // WRONG BEHAVIOR => FAIL: if the lease never expires, this times out.
      const inherited = output(
        await acquireEventually(async () =>
          output(await c.tryLock(key, { holder: heir, ttlMs: 30_000 })),
        ),
      );
      assert.equal(
        inherited.acquired,
        true,
        `the dead holder's lease (ttl=${SHORT_TTL}ms) must expire and free the key`,
      );
      assert.ok(
        inherited.fencing_token > deadToken,
        "the reclaimed grant must carry a HIGHER fencing token than the dead holder's " +
          `(${inherited.fencing_token} vs ${deadToken}) so downstream systems can fence the zombie`,
      );
      await c.lockRelease(key, { holder: heir, fencingToken: inherited.fencing_token });
    });
  });

  it("a dead semaphore holder's permit expires and readmits a new holder", async (t) => {
    const c = makeClient();
    const key = uniqueKey("lease-sem");
    const limit = 2;
    const dead = uniqueId("dead-worker");
    const live = uniqueId("live-worker");
    const heir = uniqueId("heir-worker");

    await skipIfUndeployed(t, "POST /v1/semaphores/acquire (ttl expiry)", async () => {
      const g1 = output(await c.semaphoreAcquire(key, { holder: dead, ttlMs: SHORT_TTL, limit }));
      assert.equal(g1.acquired, true);
      const g2 = output(await c.semaphoreAcquire(key, { holder: live, ttlMs: 60_000, limit }));
      assert.equal(g2.acquired, true);

      // Both permits live: the heir is over the limit right now.
      const early = output(await c.semaphoreAcquire(key, { holder: heir, ttlMs: 30_000, limit }));
      assert.notEqual(early.acquired, true, "count=2 with two live permits must refuse a third");

      // `dead` crashes without releasing. Its permit must expire and free
      // capacity while `live`'s long-TTL permit KEEPS holding.
      const readmitted = output(
        await acquireEventually(async () =>
          output(await c.semaphoreAcquire(key, { holder: heir, ttlMs: 30_000, limit })),
        ),
      );
      assert.equal(
        readmitted.acquired,
        true,
        "the dead holder's permit must expire and readmit a waiting holder",
      );

      await c.semaphoreRelease(key, { holder: live, fencingToken: g2.fencing_token });
      await c.semaphoreRelease(key, { holder: heir, fencingToken: readmitted.fencing_token });
    });
  });
});
