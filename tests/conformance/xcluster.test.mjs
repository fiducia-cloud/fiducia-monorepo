// Conformance: invariants that ONLY hold if coordination is genuinely global.
//
// The single-endpoint specs (locks/leases/semaphores) prove each primitive is
// correct when one cluster serves the whole exchange. These prove the harder
// property: the guarantee survives when contenders arrive through DIFFERENT
// clusters at once. A mutex that admits one holder per region is not a mutex.
//
// Real-world framing: a deploy lock taken by CI in fsn1 must block a human
// running the same deploy through the hel1 endpoint; a semaphore capping
// concurrent migrations at 3 must cap them fleet-wide, not 3-per-region.
//
// Requires >= 2 configured endpoints; skips cleanly on a single-endpoint run.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { output } from "../../src/client.mjs";
import { endpoints, makeClient } from "../../src/endpoints.mjs";
import { NO_ENDPOINT, uniqueKey, uniqueId, skipIfUndeployed } from "../helpers.mjs";

const eps = endpoints();
const MULTI = eps.length >= 2 ? false : "cross-cluster specs need >= 2 endpoints";
const clientFor = (index) => makeClient(eps[index % eps.length]);
const TTL = 30_000;

/** Poll until `fn()` returns truthy or the budget elapses. */
async function until(fn, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last;
}

describe("cross-cluster coordination", { skip: NO_ENDPOINT || MULTI }, () => {
  it("a simultaneous stampede across every cluster yields exactly one holder", async (t) => {
    const key = uniqueKey("xcluster-stampede");
    // Three contenders per endpoint, all released into the race together. If any
    // cluster could grant locally without global consensus, two would win.
    const contenders = Array.from({ length: eps.length * 3 }, (_, index) => ({
      index,
      holder: uniqueId(`contender-${index % eps.length}`),
      client: clientFor(index),
    }));

    await skipIfUndeployed(t, "POST /v1/locks/acquire (multi-cluster stampede)", async () => {
      const settled = await Promise.all(contenders.map(async (c) => {
        try {
          return { ...c, grant: output(await c.client.tryLock(key, { holder: c.holder, ttlMs: TTL })) };
        } catch (error) {
          // A losing racer may be refused with a non-2xx; that is still "did not acquire".
          return { ...c, grant: { acquired: false }, error };
        }
      }));

      const winners = settled.filter((s) => s.grant?.acquired === true);
      assert.equal(
        winners.length,
        1,
        `exactly one contender may hold the mutex; ${winners.length} acquired `
          + `(${winners.map((w) => w.holder).join(", ")})`,
      );

      const winner = winners[0];
      assert.ok(
        Number.isFinite(Number(winner.grant.fencing_token)),
        "the winning grant must carry a fencing token",
      );

      // Every other cluster must agree on WHO won — a split view is as bad as a
      // double grant, because downstream fencing decisions read this record.
      for (let i = 0; i < eps.length; i += 1) {
        const view = await clientFor(i).lockGet(key);
        const lock = view?.lock ?? output(view);
        assert.equal(
          lock.holder,
          winner.holder,
          `endpoint ${i} must observe the single winning holder`,
        );
      }

      await winner.client.lockRelease(key, {
        holder: winner.holder,
        fencingToken: winner.grant.fencing_token,
      });
    });
  });

  it("an expired holder is fenced from EVERY cluster, not just the one it used", async (t) => {
    const key = uniqueKey("xcluster-zombie");
    const zombie = uniqueId("zombie");
    const heir = uniqueId("heir");
    const SHORT_TTL = 3_000;

    await skipIfUndeployed(t, "POST /v1/locks/acquire (cross-cluster zombie fencing)", async () => {
      // 1. The zombie takes the lock through cluster 0, then "dies": no renew,
      //    no release. Only its TTL can free the key.
      const dead = output(await clientFor(0).tryLock(key, { holder: zombie, ttlMs: SHORT_TTL }));
      assert.equal(dead.acquired, true, "the zombie acquires first");
      const deadToken = Number(dead.fencing_token);

      // 2. A different cluster reclaims it after expiry with a HIGHER token.
      const inherited = await until(async () => {
        const attempt = output(await clientFor(1).tryLock(key, { holder: heir, ttlMs: TTL }));
        return attempt.acquired === true ? attempt : null;
      });
      assert.ok(inherited, `the dead holder's ${SHORT_TTL}ms lease must expire and free the key`);
      assert.ok(
        Number(inherited.fencing_token) > deadToken,
        `the heir must carry a higher fencing token (${inherited.fencing_token} vs ${deadToken})`,
      );

      // 3. The zombie wakes up and tries to release through a THIRD cluster,
      //    still brandishing its stale token. Fencing authority must be global:
      //    no endpoint may honour it, or the heir's grant is silently destroyed.
      for (let i = 0; i < eps.length; i += 1) {
        const stale = output(await clientFor(i).lockRelease(key, {
          holder: zombie,
          fencingToken: deadToken,
        }).catch((error) => error.body ?? { released: false }));
        assert.notEqual(
          stale.released,
          true,
          `endpoint ${i} must reject the expired holder's stale-token release`,
        );
      }

      // 4. The heir must still hold it, seen from every cluster.
      for (let i = 0; i < eps.length; i += 1) {
        const view = await clientFor(i).lockGet(key);
        const lock = view?.lock ?? output(view);
        assert.equal(lock.holder, heir, `endpoint ${i} must still see the heir holding the lock`);
      }

      await clientFor(1).lockRelease(key, { holder: heir, fencingToken: inherited.fencing_token });
    });
  });

  it("semaphore capacity is a fleet-wide budget, not a per-cluster one", async (t) => {
    const key = uniqueKey("xcluster-semaphore");
    const limit = eps.length; // one permit per cluster, so the (limit+1)th must cross a boundary

    await skipIfUndeployed(t, "POST /v1/semaphores/acquire (fleet-wide capacity)", async () => {
      // Take every permit, one through each cluster.
      const held = [];
      for (let i = 0; i < limit; i += 1) {
        const holder = uniqueId(`permit-${i}`);
        const grant = output(await clientFor(i).semaphoreAcquire(key, { holder, limit, ttlMs: TTL }));
        assert.equal(grant.acquired, true, `permit ${i} acquired through endpoint ${i}`);
        held.push({ holder, token: grant.fencing_token, client: clientFor(i) });
      }

      // Distinct tokens: two holders sharing a token cannot be fenced apart.
      const tokens = new Set(held.map((h) => String(h.token)));
      assert.equal(tokens.size, held.length, "each concurrent permit holder gets a distinct token");

      // The (limit+1)th request must be refused no matter which cluster it uses.
      for (let i = 0; i < eps.length; i += 1) {
        const over = output(await clientFor(i).semaphoreAcquire(key, {
          holder: uniqueId(`overflow-${i}`),
          limit,
          ttlMs: TTL,
        }));
        assert.notEqual(
          over.acquired,
          true,
          `endpoint ${i} must refuse permit ${limit + 1} — capacity is fleet-wide`,
        );
      }

      // Freeing one permit readmits exactly one, through a different cluster.
      const releasing = held.pop();
      await releasing.client.semaphoreRelease(key, {
        holder: releasing.holder,
        fencingToken: releasing.token,
      });
      const readmitted = await until(async () => {
        const attempt = output(await clientFor(eps.length - 1).semaphoreAcquire(key, {
          holder: uniqueId("readmitted"),
          limit,
          ttlMs: TTL,
        }));
        return attempt.acquired === true ? attempt : null;
      }, { timeoutMs: 30_000 });
      assert.ok(readmitted, "releasing one permit must readmit exactly one waiter fleet-wide");

      await clientFor(eps.length - 1).semaphoreRelease(key, {
        holder: readmitted.holder ?? readmitted.holders?.[0],
        fencingToken: readmitted.fencing_token,
      }).catch(() => {});
      for (const h of held) {
        await h.client.semaphoreRelease(key, { holder: h.holder, fencingToken: h.token }).catch(() => {});
      }
    });
  });
});
