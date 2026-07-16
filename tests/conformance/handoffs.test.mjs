// Conformance: atomic ownership handoffs (offer/accept with fencing tokens).
//
// Real-world framing: transfer a resource (shard, migration, incident command)
// from worker A to worker B with NO moment of dual or zero ownership.
// Invariants: only the named recipient may accept; acceptance mints a token
// STRICTLY ABOVE the offerer's (so downstream systems fence the old owner);
// a pending offer cannot be replaced; a resolved offer cannot be re-accepted.
//
// Routes/bodies per fiducia-node.rs src/handoffs.rs; accept output:
// { ok, to_token, handoff } / refusals carry `reason`.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { output } from "../../src/client.mjs";
import { makeClient } from "../../src/endpoints.mjs";
import { NO_ENDPOINT, uniqueKey, skipIfUndeployed } from "../helpers.mjs";

describe("handoffs", { skip: NO_ENDPOINT }, () => {
  it("only the named recipient accepts, and the new token fences the old owner", async (t) => {
    const c = makeClient();
    const name = uniqueKey("handoff-shard");

    await skipIfUndeployed(t, "POST /v1/handoffs/{offer,accept}", async () => {
      const fromToken = 41;
      const offered = output(
        await c.handoffOffer({
          name,
          resource: "tenant-shard/7",
          from: "worker-a",
          to: "worker-b",
          fromToken,
          ttlMs: 60_000,
        }),
      );
      assert.equal(offered.ok, true);

      // WRONG BEHAVIOR => FAIL: a bystander must not be able to accept.
      const thief = output(await c.handoffAccept({ name, to: "worker-z" }));
      assert.equal(thief.ok, false, "a non-recipient must not accept the handoff");
      assert.equal(thief.reason, "not_recipient");

      // A second offer while one is pending must be refused (no silent replace).
      const replaced = output(
        await c.handoffOffer({
          name,
          resource: "tenant-shard/7",
          from: "worker-a",
          to: "worker-c",
          fromToken,
          ttlMs: 60_000,
        }),
      );
      assert.equal(replaced.ok, false, "a pending offer cannot be replaced");
      assert.equal(replaced.reason, "already_offered");

      // The named recipient accepts and receives a STRICTLY higher token.
      const accepted = output(await c.handoffAccept({ name, to: "worker-b" }));
      assert.equal(accepted.ok, true);
      assert.ok(
        accepted.to_token > fromToken,
        `the successor token (${accepted.to_token}) must exceed the offerer's (${fromToken}) so downstream systems can fence worker-a`,
      );

      // Terminal: accepting again (any party) is refused.
      const again = output(await c.handoffAccept({ name, to: "worker-b" }));
      assert.equal(again.ok, false, "a resolved handoff cannot be re-accepted");
      assert.equal(again.reason, "not_offered");
    });
  });

  it("a rejected offer resolves without minting ownership", async (t) => {
    const c = makeClient();
    const name = uniqueKey("handoff-reject");

    await skipIfUndeployed(t, "POST /v1/handoffs/reject", async () => {
      output(
        await c.handoffOffer({
          name,
          resource: "migration/42",
          from: "worker-a",
          to: "worker-b",
          fromToken: 7,
          ttlMs: 60_000,
        }),
      );
      const rejected = output(await c.handoffReject({ name, to: "worker-b" }));
      assert.equal(rejected.ok, true);

      const late = output(await c.handoffAccept({ name, to: "worker-b" }));
      assert.equal(late.ok, false, "a rejected offer must not be acceptable");
      const view = output(await c.handoffGet(name));
      const token = view?.handoff?.to_token ?? view?.to_token;
      assert.ok(token == null, "rejection must never mint a successor token");
    });
  });
});
