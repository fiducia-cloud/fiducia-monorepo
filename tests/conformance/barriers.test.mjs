// Conformance: fan-in barriers (parallel participants, policy-based resolution).
//
// Real-world framing: "wait for all three reviewers", "release when 2-of-3
// approvals land", "abort the deploy if any checker vetoes".
// Invariants: a barrier resolves only when its policy is satisfied; repeat
// arrivals by the same participant are idempotent (no double-counting).
//
// Routes/bodies per fiducia-node.rs src/barriers.rs (POST /v1/barriers/{create,
// arrive}, GET /v1/barriers?name=N). Policy is internally tagged
// ({ "kind": "all" } / { "kind": "quorum", "required": N }, state.rs
// BarrierPolicy). Arrive output: { ok, resolved, barrier }.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { output } from "../../src/client.mjs";
import { makeClient } from "../../src/endpoints.mjs";
import { NO_ENDPOINT, uniqueKey, uniqueId, skipIfUndeployed } from "../helpers.mjs";

describe("barriers", { skip: NO_ENDPOINT }, () => {
  it("an `all` barrier resolves only after every participant arrives, idempotently", async (t) => {
    const c = makeClient();
    const name = uniqueKey("barrier-all");

    await skipIfUndeployed(t, "POST /v1/barriers/create", async () => {
      const created = output(
        await c.barrierCreate({ name, policy: { kind: "all" }, expected: 3 }),
      );
      assert.equal(created.ok, true);

      const a1 = output(await c.barrierArrive({ name, participant: "worker-a" }));
      assert.equal(a1.resolved, false, "1 of 3 must not resolve");

      // Idempotent repeat: worker-a arriving again must not count twice.
      const repeat = output(await c.barrierArrive({ name, participant: "worker-a" }));
      assert.equal(
        repeat.resolved,
        false,
        "a repeat arrival by the same participant must not double-count toward `all`",
      );

      const a2 = output(await c.barrierArrive({ name, participant: "worker-b" }));
      assert.equal(a2.resolved, false, "2 of 3 must not resolve");

      // WRONG BEHAVIOR => FAIL: the last distinct participant resolves it.
      const a3 = output(await c.barrierArrive({ name, participant: "worker-c" }));
      assert.equal(a3.resolved, true, "3rd distinct participant must resolve an all(3) barrier");
    });
  });

  it("a quorum barrier resolves at N arrivals without waiting for stragglers", async (t) => {
    const c = makeClient();
    const name = uniqueKey("barrier-quorum");

    await skipIfUndeployed(t, "POST /v1/barriers/create (quorum)", async () => {
      // 2-of-3 approvals: the shape recovery/approval workflows use.
      const created = output(
        await c.barrierCreate({
          name,
          policy: { kind: "quorum", required: 2 },
          expected: 3,
        }),
      );
      assert.equal(created.ok, true);

      const a1 = output(await c.barrierArrive({ name, participant: uniqueId("approver") }));
      assert.equal(a1.resolved, false, "1 arrival is below quorum");
      const a2 = output(await c.barrierArrive({ name, participant: uniqueId("approver") }));
      assert.equal(a2.resolved, true, "quorum reached must resolve without the 3rd participant");

      // The barrier's terminal state is visible to a plain read.
      const read = output(await c.barrierGet(name));
      const status = read?.barrier?.status ?? read?.status;
      assert.notEqual(status, "pending", "a resolved barrier must not read as pending");
    });
  });
});
