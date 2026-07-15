// Conformance: multi-key UNION locks (the flagship primitive).
//
// Real-world framing for these invariants:
//   - Terraform/OpenTofu state lock, deploy lock, DB migration guard,
//     single-writer serialization, staging-slot checkout.
// The one non-negotiable: a mutex must never have two simultaneous holders.
//
// Routes/bodies per fiducia-clients/PROTOCOL.md ("Locks — live").

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { output } from "../../src/client.mjs";
import { makeClient } from "../../src/endpoints.mjs";
import { NO_ENDPOINT, uniqueKey, uniqueId, skipIfUndeployed } from "../helpers.mjs";

const TTL = 30_000;

describe("locks / mutual exclusion", { skip: NO_ENDPOINT }, () => {
  it("a second try-lock on a held key is refused, release frees it", async (t) => {
    const c = makeClient();
    const key = uniqueKey("locks-mutex");
    const a = uniqueId("holder-a");
    const b = uniqueId("holder-b");

    await skipIfUndeployed(t, "POST /v1/locks/acquire", async () => {
      const first = output(await c.tryLock(key, { holder: a, ttlMs: TTL }));
      assert.equal(first.acquired, true, "first holder should acquire the lock");
      const token = first.fencing_token;

      // WRONG BEHAVIOR => FAIL: a mutex must not admit a second holder.
      const second = output(await c.tryLock(key, { holder: b, ttlMs: TTL }));
      assert.notEqual(second.acquired, true, "held mutex must refuse a second holder");

      await c.lockRelease(key, { holder: a, fencingToken: token });

      const third = output(await c.tryLock(key, { holder: b, ttlMs: TTL }));
      assert.equal(third.acquired, true, "released lock should be acquirable again");
      await c.lockRelease(key, { holder: b, fencingToken: third.fencing_token });
    });
  });

  it("locks on DIFFERENT keys never compete (independent grants coexist)", async (t) => {
    const c = makeClient();
    const k1 = uniqueKey("locks-indep-1");
    const k2 = uniqueKey("locks-indep-2");
    const a = uniqueId("holder-a");
    const b = uniqueId("holder-b");

    await skipIfUndeployed(t, "POST /v1/locks/acquire (independent keys)", async () => {
      // Holder A takes k1 and KEEPS it. Holder B's lock on the unrelated k2
      // must be granted immediately — two different keys share no state.
      const first = output(await c.tryLock(k1, { holder: a, ttlMs: TTL }));
      assert.equal(first.acquired, true, "k1 should be granted to holder A");

      // WRONG BEHAVIOR => FAIL: an unrelated key must not be blocked.
      const second = output(await c.tryLock(k2, { holder: b, ttlMs: TTL }));
      assert.equal(
        second.acquired,
        true,
        "a lock on a DIFFERENT key must be granted while k1 is held — different keys never compete",
      );

      // Both grants are live at the same time and independently inspectable.
      const k1State = output(await c.lockGet(k1));
      const k2State = output(await c.lockGet(k2));
      assert.equal(k1State.held ?? k1State.locked ?? true, true, "k1 still held by A");
      assert.equal(k2State.held ?? k2State.locked ?? true, true, "k2 held by B concurrently");

      await c.lockRelease(k1, { holder: a, fencingToken: first.fencing_token });
      await c.lockRelease(k2, { holder: b, fencingToken: second.fencing_token });
    });
  });

  it("multi-key union lock is all-or-nothing (conflicts on any member)", async (t) => {
    const c = makeClient();
    const k1 = uniqueKey("locks-union-1");
    const k2 = uniqueKey("locks-union-2");
    const k3 = uniqueKey("locks-union-3");
    const k4 = uniqueKey("locks-union-4");
    const a = uniqueId("holder-a");
    const b = uniqueId("holder-b");

    await skipIfUndeployed(t, "POST /v1/locks/acquire (multi-key)", async () => {
      const held = output(await c.lockMany({ keys: [k1, k2], holder: a, ttlMs: TTL }));
      assert.equal(held.acquired, true, "union {k1,k2} should be granted");
      const token = held.fencing_token;

      // Overlap on a member key must conflict (union, not intersection).
      const overlapSingle = output(await c.tryLock(k2, { holder: b, ttlMs: TTL }));
      assert.notEqual(overlapSingle.acquired, true, "single key overlapping the union must conflict");

      const overlapSet = output(await c.lockMany({ keys: [k2, k3], holder: b, ttlMs: TTL }));
      assert.notEqual(overlapSet.acquired, true, "overlapping set must be refused all-or-nothing");

      // Disjoint set is granted immediately.
      const disjoint = output(await c.lockMany({ keys: [k3, k4], holder: b, ttlMs: TTL }));
      assert.equal(disjoint.acquired, true, "disjoint union should be granted");

      await c.lockRelease(k1, { holder: a, fencingToken: token });
      await c.lockRelease(k3, { holder: b, fencingToken: disjoint.fencing_token });
    });
  });

  it("fencing token is monotonic across successive grants", async (t) => {
    const c = makeClient();
    const key = uniqueKey("locks-fencing");
    const holder = uniqueId("holder");

    await skipIfUndeployed(t, "POST /v1/locks/acquire (fencing)", async () => {
      const g1 = output(await c.tryLock(key, { holder, ttlMs: TTL }));
      assert.equal(g1.acquired, true);
      const t1 = g1.fencing_token;
      await c.lockRelease(key, { holder, fencingToken: t1 });

      const g2 = output(await c.tryLock(key, { holder, ttlMs: TTL }));
      assert.equal(g2.acquired, true);
      const t2 = g2.fencing_token;
      await c.lockRelease(key, { holder, fencingToken: t2 });

      if (typeof t1 === "number" && typeof t2 === "number") {
        // Strictly increasing (Kleppmann fencing) — a later grant must fence
        // off the earlier one.
        assert.ok(t2 > t1, `fencing token must be monotonic: ${t2} > ${t1}`);
      } else {
        t.skip("endpoint did not return numeric fencing tokens; cannot check monotonicity");
      }
    });
  });
});
