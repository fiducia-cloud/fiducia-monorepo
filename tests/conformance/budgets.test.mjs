// Conformance: hierarchical budgets (reserve -> commit/release against ceilings).
//
// Real-world framing: ten agents share one model-spend budget; each RESERVES
// before spending so they cannot collectively overshoot, then COMMITS actuals.
// Invariants: a reservation that would exceed any limited axis is refused;
// reserving the same id twice is idempotent (one hold); commit settles exactly
// once and caps actuals at the reservation; totals stay within the ceiling.
//
// Routes/bodies per fiducia-node.rs src/budgets.rs; reserve output:
// { ok, reserved, budget } / { ok:false, reason:"insufficient_budget", available }.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { output } from "../../src/client.mjs";
import { makeClient } from "../../src/endpoints.mjs";
import { NO_ENDPOINT, uniqueKey, uniqueId, skipIfUndeployed } from "../helpers.mjs";

describe("budgets", { skip: NO_ENDPOINT }, () => {
  it("reservations cannot overshoot the ceiling and duplicates hold once", async (t) => {
    const c = makeClient();
    const name = uniqueKey("budget-tokens");

    await skipIfUndeployed(t, "POST /v1/budgets/{set,reserve}", async () => {
      const set = output(await c.budgetSet({ name, limit: { tokens: 100 } }));
      assert.equal(set.ok, true);

      const first = output(
        await c.budgetReserve({
          name,
          reservationId: "resv-a",
          holder: "agent-a",
          amount: { tokens: 60 },
        }),
      );
      assert.equal(first.ok, true);
      assert.equal(first.reserved, true);

      // WRONG BEHAVIOR => FAIL: 60 reserved + 50 requested > 100 ceiling.
      const overshoot = output(
        await c.budgetReserve({
          name,
          reservationId: "resv-b",
          holder: "agent-b",
          amount: { tokens: 50 },
        }),
      );
      assert.equal(overshoot.ok, false, "the ceiling must refuse an overshooting hold");
      assert.equal(overshoot.reason, "insufficient_budget");

      // Idempotent re-reserve: same id holds ONCE (retry-safe), freeing nothing.
      const dup = output(
        await c.budgetReserve({
          name,
          reservationId: "resv-a",
          holder: "agent-a",
          amount: { tokens: 60 },
        }),
      );
      assert.equal(dup.ok, true);
      assert.equal(dup.reserved, false, "a duplicate reservation id must not double-hold");

      // What still fits, fits.
      const fits = output(
        await c.budgetReserve({
          name,
          reservationId: uniqueId("resv"),
          holder: "agent-c",
          amount: { tokens: 40 },
        }),
      );
      assert.equal(fits.ok, true, "a hold within the remaining budget must succeed");
    });
  });

  it("commit settles once and caps actuals at the reservation", async (t) => {
    const c = makeClient();
    const name = uniqueKey("budget-commit");

    await skipIfUndeployed(t, "POST /v1/budgets/commit", async () => {
      output(await c.budgetSet({ name, limit: { tokens: 100 } }));
      output(
        await c.budgetReserve({
          name,
          reservationId: "resv-1",
          holder: "agent-a",
          amount: { tokens: 30 },
        }),
      );

      // Actual spend above the hold is capped at the reservation (30).
      const committed = output(
        await c.budgetCommit({ name, reservationId: "resv-1", actual: { tokens: 999 } }),
      );
      assert.equal(committed.ok, true);
      assert.equal(committed.committed, true);
      const spentAfter = output(await c.budgetGet(name));
      const spent =
        spentAfter?.budget?.spent?.tokens ?? spentAfter?.spent?.tokens;
      if (spent !== undefined) {
        assert.equal(Number(spent), 30, "actuals must be capped at the reserved amount");
      }

      // Exactly once: a re-commit is a no-op replay.
      const replay = output(
        await c.budgetCommit({ name, reservationId: "resv-1", actual: { tokens: 5 } }),
      );
      assert.equal(replay.ok, true);
      assert.equal(replay.committed, false, "a second commit must not settle again");

      // Committing an unknown reservation is a typed refusal.
      const ghost = output(
        await c.budgetCommit({ name, reservationId: "resv-ghost", actual: { tokens: 1 } }),
      );
      assert.equal(ghost.ok, false);
      assert.equal(ghost.reason, "reservation_not_found");
    });
  });
});
