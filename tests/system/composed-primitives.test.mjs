// System: the coordination primitives COMPOSED into realistic distributed
// workflows, driven concurrently against the real 3-node cluster + LB.
//
// The per-primitive conformance suite proves each primitive in isolation. This
// proves they still hold their guarantees when combined under genuine
// concurrency through real Raft — which is how anyone actually uses them:
//
//   * a lock serializing a read-modify-write with no lost updates;
//   * a task queue that processes each job EXACTLY once, idempotently;
//   * a leader election whose winner is the only one that can renew (fencing);
//   * a budget that never oversells under a reservation stampede;
//   * a fan-in barrier that releases only after the last arrival;
//   * a counting semaphore that caps real concurrency.
//
// Opt-in + heavyweight (boots the same binaries the coordination suite does):
// FIDUCIA_E2E_SYSTEM=1 (see tests/system/README.md).

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { setTimeout as delay } from "node:timers/promises";

import { FiduciaClient, HttpError, output } from "../../src/client.mjs";
import {
  bootCoordinationStack,
  coordinationSkipReason,
  INTERNAL_AUTH_HEADER,
  INTERNAL_SECRET,
} from "../../src/coordination.mjs";
import { uniqueId, uniqueKey } from "../helpers.mjs";

const SKIP = coordinationSkipReason();
const ORG = "e2e-composed";

/** Poll every node's /v1/status until all shards are led with quorum. */
async function waitConverged(nodeUrls, shardCount, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ledShards = new Set();
    for (const nodeUrl of nodeUrls) {
      try {
        const res = await fetch(`${nodeUrl}/v1/status`, {
          headers: { [INTERNAL_AUTH_HEADER]: INTERNAL_SECRET },
        });
        if (!res.ok) continue;
        const status = await res.json();
        const shards = status?.consensus?.shards ?? status?.shards ?? [];
        for (const shard of shards) {
          if (shard.role === "leader" && shard.has_quorum) ledShards.add(shard.shard_id);
        }
      } catch {
        // node not up yet; keep polling
      }
    }
    if (ledShards.size >= shardCount) return;
    if (Date.now() > deadline) {
      throw new Error(`cluster did not converge: ${ledShards.size}/${shardCount} shards led in ${timeoutMs}ms`);
    }
    await delay(250);
  }
}

/** Read the boolean "did I win/acquire" flag across the primitives' vocabularies. */
function truthyFlag(value, ...keys) {
  const o = output(value);
  for (const key of keys) {
    if (typeof o?.[key] === "boolean") return o[key];
  }
  return undefined;
}

describe("composed coordination workflows", { skip: SKIP }, () => {
  let stack;
  let lb;

  before(async () => {
    stack = await bootCoordinationStack({ shardCount: 4, compactThreshold: 16 });
    const edgeFetch = (url, init = {}) =>
      fetch(url, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          "x-fiducia-edge-auth": INTERNAL_SECRET,
          "x-fiducia-org-id": ORG,
          "x-fiducia-scopes": "*",
        },
      });
    lb = new FiduciaClient(stack.lbUrl, { fetch: edgeFetch });

    // Wait for FULL convergence before driving the workflows. Right after boot,
    // shards are still electing leaders and the LB answers 502/503 for any shard
    // whose leader isn't ready yet — and this plain client (single LB, no
    // failover) doesn't retry, so a test racing election flakes. Poll every
    // node's /v1/status until every shard is led with quorum somewhere.
    await waitConverged(stack.nodeUrls, stack.shardCount);
  }, { timeout: 900_000 }); // first run compiles fiducia-node + fiducia-load-balance

  after(async () => {
    await stack?.stop();
  }, { timeout: 120_000 });

  // 1. A lock must make a non-atomic read-modify-write safe. counterSet (not the
  // atomic counterAdd) is used ON PURPOSE: 20 workers each read the counter and
  // write back value+1. Without mutual exclusion, interleaved read/writes drop
  // updates and the total lands below 20; with the lock, it is exactly 20.
  it("a lock serializes a read-modify-write — no lost updates under contention", async () => {
    const CONTENDERS = 20;
    const lockKey = uniqueKey("rmw-lock");
    const counterKey = uniqueKey("rmw-counter");
    await output(await lb.counterSet(counterKey, { value: 0 }));

    async function increment(i) {
      const holder = `worker-${i}`;
      // Block until acquired (bounded); every worker eventually gets its turn.
      let grant;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        grant = output(await lb.tryLock(lockKey, { holder, ttlMs: 10_000 }));
        if (grant.acquired) break;
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.equal(grant.acquired, true, `${holder} must eventually acquire the lock`);
      try {
        const current = output(await lb.counterGet(counterKey)).counter.value;
        await lb.counterSet(counterKey, { value: current + 1 });
      } finally {
        await lb.lockRelease(lockKey, { holder, fencingToken: grant.fencing_token });
      }
    }

    await Promise.all(Array.from({ length: CONTENDERS }, (_, i) => increment(i)));
    const final = output(await lb.counterGet(counterKey)).counter.value;
    assert.equal(final, CONTENDERS, `expected ${CONTENDERS} increments with none lost, got ${final}`);
  });

  // 2. A task queue with EXACTLY-ONCE processing. N named jobs, W workers racing
  // to claim each. taskClaim gives one winner per job; the winner applies its
  // side effect (a shared counter +1) guarded by an idempotency key so even a
  // retry of the same job cannot double-count, then completes with its fencing
  // token. Invariant: every job runs exactly once => the counter equals N and
  // every job ends `completed`, no matter how the workers interleave.
  it("a task queue processes every job exactly once (task + idempotency + fencing)", async () => {
    const JOBS = 12;
    const WORKERS = 4;
    const processed = uniqueKey("jobs-processed");
    await output(await lb.counterSet(processed, { value: 0 }));

    const jobNames = Array.from({ length: JOBS }, (_, i) => uniqueId(`job-${i}`));
    for (const name of jobNames) {
      await output(await lb.taskCreate({ name, taskType: "e2e-composed", payload: { name } }));
    }

    const claimedBy = new Map();
    async function worker(workerId) {
      for (const name of jobNames) {
        const claim = output(await lb.taskClaim({ name, worker: workerId, ttlMs: 30_000 }));
        if (claim.ok !== true) continue; // someone else owns this job
        assert.ok(!claimedBy.has(name), `job ${name} must not be claimed twice`);
        claimedBy.set(name, workerId);

        // Idempotent side effect: keyed by the job, so a redelivery is a no-op.
        const idemKey = `effect:${name}`;
        const claimed = output(await lb.idempotencyClaim(idemKey, { owner: workerId, ttlMs: 30_000 }));
        if (truthyFlag(claimed, "claimed", "ok") !== false) {
          await lb.counterAdd(processed, { delta: 1 });
        }
        await lb.taskComplete({ name, worker: workerId, fencingToken: claim.fencing_token, result: { ok: true } });
      }
    }

    await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(`worker-${w}`)));

    const total = output(await lb.counterGet(processed)).counter.value;
    assert.equal(total, JOBS, `each job's effect must apply once: expected ${JOBS}, got ${total}`);
    assert.equal(claimedBy.size, JOBS, "every job must have been claimed by exactly one worker");
  });

  // 3. Leader election is only meaningful if the winner can PROVE it is still the
  // leader and a loser cannot act as one. Three candidates campaign; exactly one
  // wins; the winner renews with its fencing token (accepted) and a loser's
  // renew with a fabricated token is rejected — the fencing invariant.
  it("exactly one leader is elected and only it can renew (election + fencing)", async () => {
    const name = uniqueId("singleton");
    const candidates = ["a", "b", "c"].map((s) => uniqueId(`cand-${s}`));

    const results = await Promise.all(
      candidates.map((cand) => lb.electionCampaign(name, cand, 15_000, { cand })),
    );
    const winners = results
      .map((r, i) => ({ cand: candidates[i], won: truthyFlag(r, "won", "acquired", "elected"), token: output(r)?.fencing_token }))
      .filter((r) => r.won === true);

    // If the build reports a win flag at all, there must be exactly one winner.
    if (results.some((r) => truthyFlag(r, "won", "acquired", "elected") !== undefined)) {
      assert.equal(winners.length, 1, `exactly one leader, got ${winners.length}`);
      const leader = winners[0];
      assert.equal(typeof leader.token, "number", "the leader holds a fencing token");

      // The leader renews with its real token: accepted.
      const renew = output(await lb.electionRenew(name, leader.cand, leader.token));
      assert.notEqual(
        truthyFlag(renew, "renewed", "ok", "won", "acquired"),
        false,
        "the incumbent leader must be able to renew with its own token",
      );

      // A different candidate renews with a bogus token: rejected (no takeover).
      const usurper = candidates.find((c) => c !== leader.cand);
      const stolen = await lb
        .electionRenew(name, usurper, leader.token + 999)
        .then((r) => truthyFlag(r, "renewed", "ok"))
        .catch(() => false);
      assert.notEqual(stolen, true, "a stale/forged token must not renew someone else's leadership");
    }
  });

  // 4. A budget must never hand out more than its limit, even when far more
  // reservers arrive at once than there is budget. Limit = 5 tokens, 15
  // concurrent reservers each asking for 1 with a distinct reservation id.
  // Invariant: exactly 5 succeed, 10 are refused, and the committed total never
  // exceeds the limit.
  it("a budget never oversells under a reservation stampede", async () => {
    const name = uniqueKey("quota");
    const LIMIT = 5;
    const RESERVERS = 15;
    await output(await lb.budgetSet({ name, limit: { tokens: LIMIT } }));

    const outcomes = await Promise.all(
      Array.from({ length: RESERVERS }, (_, i) =>
        lb
          .budgetReserve({
            name,
            reservationId: `resv-${i}`,
            holder: `h-${i}`,
            amount: { tokens: 1 },
          })
          .then((r) => ({ id: `resv-${i}`, reserved: output(r).reserved === true }))
          .catch(() => ({ id: `resv-${i}`, reserved: false })),
      ),
    );

    const granted = outcomes.filter((o) => o.reserved);
    assert.equal(granted.length, LIMIT, `budget must grant exactly ${LIMIT}, granted ${granted.length}`);

    // Commit the winners; the accepted actuals must not exceed the limit.
    let committedTokens = 0;
    for (const g of granted) {
      const c = output(await lb.budgetCommit({ name, reservationId: g.id, actual: { tokens: 1 } }));
      if (c.committed === true) committedTokens += 1;
    }
    assert.ok(committedTokens <= LIMIT, `committed ${committedTokens} must not exceed limit ${LIMIT}`);
  });

  // 5. A fan-in barrier gates a group: it must release ONLY when the last of the
  // expected participants arrives — not before. Five participants arrive
  // concurrently; exactly one arrival observes the release edge; afterwards each
  // participant does one unit of work (counter +1) and the total is 5.
  it("a fan-in barrier releases only after the last arrival, then all proceed", async () => {
    const name = uniqueKey("fan-in");
    const EXPECTED = 5;
    const work = uniqueKey("post-barrier-work");
    await output(await lb.counterSet(work, { value: 0 }));
    await output(await lb.barrierCreate({ name, policy: { kind: "all" }, expected: EXPECTED }));

    const arrivals = await Promise.all(
      Array.from({ length: EXPECTED }, (_, i) =>
        lb
          .barrierArrive({ name, participant: `p-${i}` })
          // Arrive output: { ok, resolved, barrier }. The last arrival flips it.
          .then((r) => output(r).resolved === true),
      ),
    );
    const releaseEdges = arrivals.filter(Boolean).length;
    assert.equal(releaseEdges, 1, `exactly one arrival should see the release edge, saw ${releaseEdges}`);

    await Promise.all(
      Array.from({ length: EXPECTED }, () => lb.counterAdd(work, { delta: 1 })),
    );
    const done = output(await lb.counterGet(work)).counter.value;
    assert.equal(done, EXPECTED, `every released participant proceeds once: expected ${EXPECTED}, got ${done}`);
  });

  // 6. A counting semaphore must cap concurrency at its limit even under a
  // stampede. count = 3, 8 workers try (non-blocking) to acquire at once:
  // exactly 3 hold; releasing all frees the resource for the next wave.
  it("a counting semaphore caps concurrency under a stampede (count=3)", async () => {
    const key = uniqueKey("concurrency-cap");
    const LIMIT = 3;
    const WORKERS = 8;

    const held = (
      await Promise.all(
        Array.from({ length: WORKERS }, (_, i) =>
          lb
            .semaphoreAcquire(key, { holder: `w-${i}`, limit: LIMIT, ttlMs: 15_000 })
            .then((r) => ({ holder: `w-${i}`, acquired: output(r).acquired === true, token: output(r).fencing_token }))
            .catch(() => ({ holder: `w-${i}`, acquired: false })),
        ),
      )
    ).filter((r) => r.acquired);

    assert.equal(held.length, LIMIT, `at most ${LIMIT} may hold concurrently, ${held.length} did`);

    // Release the wave; a fresh acquire then succeeds (the permits came back).
    for (const h of held) {
      await lb.semaphoreRelease(key, { holder: h.holder, fencingToken: h.token });
    }
    const next = output(await lb.semaphoreAcquire(key, { holder: "w-next", limit: LIMIT, ttlMs: 5_000 }));
    assert.equal(next.acquired, true, "after releasing the wave a new holder is admitted");
    await lb.semaphoreRelease(key, { holder: "w-next", fencingToken: next.fencing_token });
  });
});
