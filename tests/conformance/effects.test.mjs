// Conformance: approval-escrow effects (prepare → approve → commit, exactly once).
//
// Real-world framing: an agent must not directly perform an irreversible action
// (payment, deploy, delete, public post). It PREPARES the effect, one or more
// principals APPROVE it, and only then may it COMMIT — exactly once.
// Invariants: commit before approval is refused; the approval quorum gates the
// commit; a duplicate commit is an idempotent replay (never re-executes); an
// aborted effect can never commit.
//
// Routes/bodies per fiducia-node.rs src/effects.rs. Commit output:
// { ok, committed, effect } — `committed:true` exactly once, replay is
// { ok:true, committed:false }; refusals carry `reason`.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { output } from "../../src/client.mjs";
import { makeClient } from "../../src/endpoints.mjs";
import { NO_ENDPOINT, uniqueKey, uniqueId, skipIfUndeployed } from "../helpers.mjs";

describe("effects", { skip: NO_ENDPOINT }, () => {
  it("commit is gated on the approval quorum and executes exactly once", async (t) => {
    const c = makeClient();
    const name = uniqueKey("effect-payout");

    await skipIfUndeployed(t, "POST /v1/effects/{prepare,approve,commit}", async () => {
      const prepared = output(
        await c.effectPrepare({
          name,
          effectType: "payout",
          payload: { amount_micros: 12_000_000 },
          idempotencyKey: uniqueId("payout"),
          requiredApprovals: 2,
        }),
      );
      assert.equal(prepared.ok, true);

      // WRONG BEHAVIOR => FAIL: an unapproved effect must not commit.
      const early = output(await c.effectCommit({ name, result: { by: "impatient" } }));
      assert.equal(early.ok, false, "commit before approval must be refused");
      assert.equal(early.reason, "not_approved");

      // One of two approvals is still below the quorum.
      const first = output(await c.effectApprove({ name, principal: "alice" }));
      assert.equal(first.ok, true);
      const still = output(await c.effectCommit({ name, result: {} }));
      assert.equal(still.reason, "not_approved", "1 of 2 approvals must not commit");

      // Repeat approval by the SAME principal must not satisfy the quorum.
      output(await c.effectApprove({ name, principal: "alice" }));
      const same = output(await c.effectCommit({ name, result: {} }));
      assert.equal(
        same.reason,
        "not_approved",
        "a repeated approval by one principal must not count twice",
      );

      // The second distinct principal completes the quorum; commit executes.
      output(await c.effectApprove({ name, principal: "bob" }));
      const committed = output(await c.effectCommit({ name, result: { receipt: "r-1" } }));
      assert.equal(committed.ok, true);
      assert.equal(committed.committed, true, "quorum reached: the effect executes");

      // Exactly once: a duplicate commit is an idempotent replay, not a rerun.
      const replay = output(await c.effectCommit({ name, result: { receipt: "r-2" } }));
      assert.equal(replay.ok, true);
      assert.equal(replay.committed, false, "a second commit must be a replay");
      const view = output(await c.effectGet(name));
      const result = view?.effect?.result ?? view?.result;
      assert.deepEqual(
        result,
        { receipt: "r-1" },
        "the replay must preserve the FIRST commit's result",
      );
    });
  });

  it("an aborted effect can never commit", async (t) => {
    const c = makeClient();
    const name = uniqueKey("effect-abort");

    await skipIfUndeployed(t, "POST /v1/effects/abort", async () => {
      output(
        await c.effectPrepare({
          name,
          effectType: "deploy",
          idempotencyKey: uniqueId("deploy"),
          requiredApprovals: 1,
        }),
      );
      output(await c.effectApprove({ name, principal: "alice" }));
      const aborted = output(await c.effectAbort({ name }));
      assert.equal(aborted.ok, true);

      // WRONG BEHAVIOR => FAIL: abort is terminal.
      const commit = output(await c.effectCommit({ name, result: {} }));
      assert.equal(commit.ok, false, "an aborted effect must refuse to commit");
      assert.equal(commit.reason, "aborted");
    });
  });
});
