// Conformance: distributed counters (replicated i64 + CAS via mod_revision).
//
// Real-world framing: rollout failure thresholds, quota tallies, fan-in counts.
// Invariants: adds are linearizable off the shard leader (a read after a
// committed add sees it); a compare-and-set with a stale revision MUST fail and
// MUST NOT mutate; a CAS with the current revision applies exactly once.
//
// Routes/bodies per fiducia-node.rs src/counters.rs (POST /v1/counters/{add,set},
// GET /v1/counters?key=K). Output: { ok, key, value, mod_revision } on success,
// { ok:false, reason:"cas_mismatch", current_revision } on a stale CAS.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { output } from "../../src/client.mjs";
import { makeClient } from "../../src/endpoints.mjs";
import { NO_ENDPOINT, uniqueKey, skipIfUndeployed } from "../helpers.mjs";

describe("counters", { skip: NO_ENDPOINT }, () => {
  it("adds accumulate and reads see the committed value", async (t) => {
    const c = makeClient();
    const key = uniqueKey("counter-acc");

    await skipIfUndeployed(t, "POST /v1/counters/add", async () => {
      const first = output(await c.counterAdd(key, { delta: 3 }));
      assert.equal(first.ok, true);
      assert.equal(first.value, 3, "fresh counter starts at 0 and adds the delta");

      const second = output(await c.counterAdd(key, { delta: -1 }));
      assert.equal(second.value, 2, "negative deltas subtract");

      // Linearizable read-after-write: the committed value must be visible.
      const read = output(await c.counterGet(key));
      assert.equal(read.found, true);
      assert.equal(read.counter.value, 2, "read after committed adds sees the sum");
      assert.equal(
        read.counter.mod_revision,
        second.mod_revision,
        "read reports the revision of the last committed mutation",
      );
    });
  });

  it("stale compare-and-set is rejected and does not mutate", async (t) => {
    const c = makeClient();
    const key = uniqueKey("counter-cas");

    await skipIfUndeployed(t, "POST /v1/counters/set (CAS)", async () => {
      const seeded = output(await c.counterSet(key, { value: 10 }));
      assert.equal(seeded.ok, true);
      const current = seeded.mod_revision;

      // WRONG BEHAVIOR => FAIL: a CAS against a stale revision must be refused.
      const stale = output(await c.counterAdd(key, { delta: 100, prevRevision: current - 1 }));
      assert.equal(stale.ok, false, "stale prev_revision must be rejected");
      assert.equal(stale.reason, "cas_mismatch");

      const unchanged = output(await c.counterGet(key));
      assert.equal(unchanged.counter.value, 10, "a failed CAS must not mutate the counter");

      // A CAS against the CURRENT revision applies.
      const applied = output(await c.counterAdd(key, { delta: 5, prevRevision: current }));
      assert.equal(applied.ok, true, "current-revision CAS applies");
      assert.equal(applied.value, 15);
    });
  });
});
