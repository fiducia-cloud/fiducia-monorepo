// Conformance: durable tasks (claimable work; the exclusive owner holds a
// fencing token).
//
// Real-world framing: exactly-one worker claims a work item; a paused/stale
// worker that lost its claim must be fenced off from completing it.
// Invariants: exactly one concurrent claim wins; a second claim is refused
// while the lease is live; completion requires the owner's fencing token — a
// stale token is rejected ("fenced"), which is the property that prevents a
// zombie worker from overwriting the rightful owner's result.
//
// Routes/bodies per fiducia-node.rs src/tasks.rs. Claim output:
// { ok, fencing_token, task } / { ok:false, reason:"already_claimed" };
// complete with a wrong token: { ok:false, reason:"fenced" }.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { output } from "../../src/client.mjs";
import { makeClient } from "../../src/endpoints.mjs";
import { NO_ENDPOINT, uniqueKey, skipIfUndeployed } from "../helpers.mjs";

describe("tasks", { skip: NO_ENDPOINT }, () => {
  it("exactly one worker claims; the loser is told who owns it", async (t) => {
    const c = makeClient();
    const name = uniqueKey("task-claim");

    await skipIfUndeployed(t, "POST /v1/tasks/{create,claim}", async () => {
      const created = output(
        await c.taskCreate({ name, taskType: "e2e-conformance", payload: { n: 1 } }),
      );
      assert.equal(created.ok, true);

      const winner = output(await c.taskClaim({ name, worker: "worker-a", ttlMs: 30_000 }));
      assert.equal(winner.ok, true, "first claim wins");
      assert.equal(typeof winner.fencing_token, "number");

      // WRONG BEHAVIOR => FAIL: a live claim must exclude the second worker.
      const loser = output(await c.taskClaim({ name, worker: "worker-b", ttlMs: 30_000 }));
      assert.equal(loser.ok, false, "a second concurrent claim must be refused");
      assert.equal(loser.reason, "already_claimed");
    });
  });

  it("a stale fencing token cannot complete the task; the owner's can", async (t) => {
    const c = makeClient();
    const name = uniqueKey("task-fence");

    await skipIfUndeployed(t, "POST /v1/tasks/complete (fencing)", async () => {
      output(await c.taskCreate({ name, taskType: "e2e-conformance" }));
      const claim = output(await c.taskClaim({ name, worker: "worker-a", ttlMs: 30_000 }));
      assert.equal(claim.ok, true);
      const token = claim.fencing_token;

      // A zombie with a wrong token (stale worker identity or forged token)
      // must be fenced off — this is the primitive's core safety property.
      const zombie = output(
        await c.taskComplete({ name, worker: "worker-b", fencingToken: token, result: { by: "zombie" } }),
      );
      assert.equal(zombie.ok, false, "a non-owner must not complete the task");
      assert.equal(zombie.reason, "fenced");

      const staleToken = output(
        await c.taskComplete({ name, worker: "worker-a", fencingToken: token - 1, result: {} }),
      );
      assert.equal(staleToken.ok, false, "a stale token must be rejected even for the owner");

      // The rightful owner with the current token completes exactly once.
      const done = output(
        await c.taskComplete({ name, worker: "worker-a", fencingToken: token, result: { by: "owner" } }),
      );
      assert.equal(done.ok, true, "the owner's current token completes the task");

      const read = output(await c.taskGet(name));
      const status = read?.task?.status ?? read?.status;
      assert.equal(status, "completed", "the task must read as completed");
    });
  });
});
