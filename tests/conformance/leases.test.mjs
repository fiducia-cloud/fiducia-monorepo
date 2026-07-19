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
      const stale = output(await c.lockRelease(key, {
        holder: dead,
        fencingToken: deadToken,
      }));
      assert.equal(stale.released, false, "the expired holder's stale release must be rejected");
      const afterStale = (await c.lockGet(key))?.lock;
      assert.equal(afterStale?.holder, heir, "stale release must not evict the higher-token heir");
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

  it("a queued successor progresses after dead-holder expiry by re-POSTing acquire", async (t) => {
    const c = makeClient();
    const key = uniqueKey("lease-queued-repost");
    const dead = uniqueId("dead-holder");
    const successor = uniqueId("queued-successor");
    const successorRequestId = uniqueId("queued-successor-attempt");

    await skipIfUndeployed(t, "POST /v1/locks/acquire (queued expiry progress)", async () => {
      const first = output(await c.tryLock(key, { holder: dead, ttlMs: SHORT_TTL }));
      assert.equal(first.acquired, true, "dead holder acquires first");
      const queued = output(await c.tryLock(key, {
        holder: successor,
        ttlMs: 30_000,
        wait: true,
        requestId: successorRequestId,
      }));
      assert.equal(queued.acquired, false, "successor cannot overlap the live holder");
      assert.equal(queued.queued, true, "successor reserves a FIFO queue position");

      await sleep(SHORT_TTL + 300);
      const promoted = output(
        await acquireEventually(async () => output(await c.tryLock(key, {
          holder: successor,
          ttlMs: 30_000,
          wait: true,
          requestId: successorRequestId,
        }))),
      );
      assert.equal(promoted.acquired, true, "successor re-POST triggers expiry sweep and observes promotion");
      assert.ok(
        promoted.fencing_token > first.fencing_token,
        "promoted successor receives a strictly higher fencing token",
      );
      await c.lockRelease(key, { holder: successor, fencingToken: promoted.fencing_token });
    });
  });

  it("durable cancellation removes a queued waiter without leaving a zombie grant", async (t) => {
    const c = makeClient();
    const key = uniqueKey("lease-cancel-no-zombie");
    const owner = uniqueId("owner");
    const cancelled = uniqueId("cancelled-waiter");
    const successor = uniqueId("post-cancel-successor");
    const cancelledRequestId = uniqueId("cancelled-attempt");

    await skipIfUndeployed(t, "POST /v1/locks/cancel (durable cancellation)", async () => {
      const held = output(await c.tryLock(key, { holder: owner, ttlMs: 30_000 }));
      assert.equal(held.acquired, true);
      const queued = output(await c.tryLock(key, {
        holder: cancelled,
        ttlMs: 30_000,
        wait: true,
        waitTimeoutMs: 30_000,
        requestId: cancelledRequestId,
      }));
      assert.equal(queued.queued, true, "the soon-cancelled client first enters the queue");
      assert.equal(typeof queued.wait_expires_ms, "number", "queued request has a bounded wait lease");

      const result = output(await c.lockCancel(key, {
        holder: cancelled,
        requestId: cancelledRequestId,
      }));
      assert.equal(result.cancelled, true, "cancellation is durably committed");
      assert.equal(result.acquired, false, "the cancelled waiter did not race into ownership");
      const afterCancel = (await c.lockGet(key))?.lock;
      assert.equal(afterCancel?.holder, owner, "cancellation never releases the active owner");
      assert.equal(
        afterCancel?.wait_queue?.some((waiter) => waiter.holder === cancelled),
        false,
        "cancelled identity is absent from the durable queue",
      );

      await c.lockRelease(key, {
        holder: owner,
        fencingToken: held.fencing_token,
      });
      const next = output(await c.tryLock(key, { holder: successor, ttlMs: 30_000 }));
      assert.equal(next.acquired, true, "a later requester progresses immediately after owner release");
      assert.equal((await c.lockGet(key))?.lock?.holder, successor, "cancelled waiter never becomes a zombie owner");
      await c.lockRelease(key, { holder: successor, fencingToken: next.fencing_token });
    });
  });

  it("cancellation reports the fencing authority if expiry promotion wins the race", async (t) => {
    const c = makeClient();
    const key = uniqueKey("lease-cancel-race");
    const owner = uniqueId("expiring-owner");
    const waiter = uniqueId("racing-waiter");
    const waiterRequestId = uniqueId("racing-attempt");

    await skipIfUndeployed(t, "POST /v1/locks/cancel (promotion race)", async () => {
      const held = output(await c.tryLock(key, { holder: owner, ttlMs: SHORT_TTL }));
      assert.equal(held.acquired, true);
      const queued = output(await c.tryLock(key, {
        holder: waiter,
        ttlMs: 30_000,
        wait: true,
        waitTimeoutMs: 30_000,
        requestId: waiterRequestId,
      }));
      assert.equal(queued.queued, true);

      await sleep(SHORT_TTL + 300);
      const raced = output(await c.lockCancel(key, {
        holder: waiter,
        requestId: waiterRequestId,
      }));
      assert.equal(raced.cancelled, false, "an active grant is never cancelled behind its holder");
      assert.equal(raced.acquired, true, "the response reports that promotion won the race");
      assert.ok(
        raced.fencing_token > held.fencing_token,
        "the raced authority carries a higher fencing token than the expired owner",
      );
      assert.equal((await c.lockGet(key))?.lock?.holder, waiter, "reported authority matches live state");
      await c.lockRelease(key, { holder: waiter, fencingToken: raced.fencing_token });
    });
  });

  it("cancel-before-late-acquire suppresses only the same unique request_id", async (t) => {
    const c = makeClient();
    const lockKey = uniqueKey("lease-cancel-before-lock");
    const semaphoreKey = uniqueKey("lease-cancel-before-semaphore");
    const lockHolder = uniqueId("late-lock-holder");
    const semaphoreHolder = uniqueId("late-semaphore-holder");
    const lockRequestId = uniqueId("late-lock-attempt");
    const semaphoreRequestId = uniqueId("late-semaphore-attempt");

    await skipIfUndeployed(t, "attempt-scoped cancel-before-acquire", async () => {
      const lockCancel = output(await c.lockCancel(lockKey, {
        holder: lockHolder,
        requestId: lockRequestId,
      }));
      assert.equal(lockCancel.cancelled, true, "lock cancellation commits before the request arrives");
      assert.equal(lockCancel.acquired, false);
      const lateLock = output(await c.tryLock(lockKey, {
        holder: lockHolder,
        ttlMs: 30_000,
        wait: true,
        requestId: lockRequestId,
      }));
      assert.equal(lateLock.acquired, false, "the cancelled lock attempt cannot arrive late and win");
      assert.equal(lateLock.queued, false, "the cancelled lock attempt cannot become a zombie waiter");

      const freshLock = output(await c.tryLock(lockKey, {
        holder: lockHolder,
        ttlMs: 30_000,
        requestId: uniqueId("fresh-lock-attempt"),
      }));
      assert.equal(freshLock.acquired, true, "a new lock attempt from the same holder is not tombstoned");
      await c.lockRelease(lockKey, {
        holder: lockHolder,
        fencingToken: freshLock.fencing_token,
      });

      const semaphoreCancel = output(await c.semaphoreCancel(semaphoreKey, {
        holder: semaphoreHolder,
        requestId: semaphoreRequestId,
      }));
      assert.equal(
        semaphoreCancel.cancelled,
        true,
        "semaphore cancellation commits before the request arrives",
      );
      assert.equal(semaphoreCancel.acquired, false);
      const latePermit = output(await c.semaphoreAcquire(semaphoreKey, {
        holder: semaphoreHolder,
        ttlMs: 30_000,
        limit: 1,
        wait: true,
        requestId: semaphoreRequestId,
      }));
      assert.equal(latePermit.acquired, false, "the cancelled permit attempt cannot arrive late and win");
      assert.equal(latePermit.queued, false, "the cancelled permit attempt cannot become a zombie waiter");

      const freshPermit = output(await c.semaphoreAcquire(semaphoreKey, {
        holder: semaphoreHolder,
        ttlMs: 30_000,
        limit: 1,
        requestId: uniqueId("fresh-semaphore-attempt"),
      }));
      assert.equal(
        freshPermit.acquired,
        true,
        "a new permit attempt from the same holder is not tombstoned",
      );
      await c.semaphoreRelease(semaphoreKey, {
        holder: semaphoreHolder,
        fencingToken: freshPermit.fencing_token,
      });
    });
  });
});
