// Conformance: idempotency keys (retry-safe first-claim / duplicate-replay).
//
// Real-world framing: exactly-once webhook processing (Stripe/Kafka/SQS), the
// payment retry that must not double-charge, notification dedup.
// Invariants: first claim => claimed; duplicate claim replays the same record
// (not a second run); complete binds a durable result; a stale owner/token is
// rejected.
//
// Routes/bodies per fiducia-clients/PROTOCOL.md ("Idempotency keys — live").

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { output, HttpError } from "../../src/client.mjs";
import { makeClient } from "../../src/endpoints.mjs";
import { NO_ENDPOINT, uniqueKey, uniqueId, skipIfUndeployed } from "../helpers.mjs";

// PROTOCOL/README show status === "claimed" on the first active claim; the exact
// string for a duplicate is not pinned in PROTOCOL.md, so we accept any of these
// and, more importantly, assert the fencing token is REPLAYED (same run).
// VERIFY against PROTOCOL.md: exact duplicate-claim status string.
const CLAIMED = new Set(["claimed", "created", "new", "first"]);
const DUP = new Set(["duplicate", "exists", "existing", "replayed", "in_progress"]);

describe("idempotency keys", { skip: NO_ENDPOINT }, () => {
  it("first claim is claimed; a duplicate replays the same active record", async (t) => {
    const c = makeClient();
    const key = uniqueKey("idem");
    const owner = uniqueId("owner");

    await skipIfUndeployed(t, "POST /v1/idempotency/claim", async () => {
      const first = output(await c.idempotencyClaim(key, { owner, ttl: "5m", metadata: { source: "test" } }));
      if (first.status !== undefined) {
        assert.ok(CLAIMED.has(first.status), `first claim should be claimed, got "${first.status}"`);
      }
      const token = first.fencing_token;

      const dup = output(await c.idempotencyClaim(key, { owner, ttl: "5m" }));
      // WRONG BEHAVIOR => FAIL: a duplicate must NOT mint a fresh run. Either the
      // status flips to a duplicate marker or the same fencing token is replayed.
      if (dup.status !== undefined && first.status !== undefined) {
        assert.ok(
          DUP.has(dup.status) || !CLAIMED.has(dup.status) || dup.fencing_token === token,
          `duplicate claim must not be a fresh "claimed"; got "${dup.status}"`,
        );
      }
      if (typeof token === "number" && typeof dup.fencing_token === "number") {
        assert.equal(dup.fencing_token, token, "duplicate claim must replay the original fencing token");
      }
    });
  });

  it("complete binds a result; a stale owner is rejected by fencing", async (t) => {
    const c = makeClient();
    const key = uniqueKey("idem-complete");
    const owner = uniqueId("owner");
    const impostor = uniqueId("impostor");

    await skipIfUndeployed(t, "POST /v1/idempotency/complete", async () => {
      const claim = output(await c.idempotencyClaim(key, { owner, ttl: "5m" }));
      const token = claim.fencing_token;

      const done = output(await c.idempotencyComplete(key, { owner, fencingToken: token, result: { status: "ok" } }));
      assert.ok(done !== undefined, "complete should return a result envelope");

      // A different owner / stale token must be rejected: either a non-2xx
      // (HttpError) or an explicit not-owner outcome. WRONG => two owners could
      // both "complete" the same key.
      let rejected = false;
      try {
        const bad = output(
          await c.idempotencyComplete(key, { owner: impostor, fencingToken: (token ?? 0) - 1, result: { status: "hijacked" } }),
        );
        if (bad && (bad.completed === false || bad.ok === false || bad.error || bad.rejected === true)) {
          rejected = true;
        }
      } catch (err) {
        if (err instanceof HttpError && err.status >= 400 && err.status < 500) rejected = true;
        else throw err;
      }
      assert.ok(rejected, "stale owner/fencing token must be rejected on complete");
    });
  });
});
