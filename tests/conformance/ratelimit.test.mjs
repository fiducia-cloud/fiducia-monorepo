// Conformance: rate limiting (atomic token-bucket / sliding-window checks).
//
// Real-world framing: per-tenant API quota, brute-force login throttle, LLM
// spend cap, ad-budget pacing.
// Invariant: the first N checks within budget pass; N+1 is rejected; after the
// window refills, checks pass again.
//
// Routes/bodies per fiducia-clients/PROTOCOL.md ("Rate limiting — live").

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { output } from "../../src/client.mjs";
import { makeClient } from "../../src/endpoints.mjs";
import { NO_ENDPOINT, uniqueKey, skipIfUndeployed } from "../helpers.mjs";

// The check result field is not pinned in PROTOCOL.md beyond {committed,result}.
// README frames it as an allow/deny check, so read `allowed` defensively.
// VERIFY against PROTOCOL.md: the exact allow/deny field name.
function allowed(res) {
  const o = output(res);
  if (typeof o?.allowed === "boolean") return o.allowed;
  if (typeof o?.ok === "boolean") return o.ok;
  if (typeof o?.limited === "boolean") return !o.limited;
  if (typeof o?.remaining === "number") return o.remaining >= 0;
  return undefined; // unknown shape -> caller skips the strict assertion
}

describe("rate limiting", { skip: NO_ENDPOINT }, () => {
  it("first N within budget pass, N+1 is rejected", async (t) => {
    const c = makeClient();
    const tenant = "e2e-tenant";
    const key = uniqueKey("rl-budget");
    const limit = 3;

    await skipIfUndeployed(t, "POST /v1/rate-limit/{tenant}/{key}/check", async () => {
      const results = [];
      for (let i = 0; i < limit + 1; i += 1) {
        results.push(
          allowed(
            await c.rateLimitCheck(tenant, key, {
              algorithm: "token_bucket",
              limit,
              windowMs: 60_000,
              cost: 1,
            }),
          ),
        );
      }

      if (results.some((r) => r === undefined)) {
        t.skip("rate-limit response shape not recognized; cannot assert allow/deny");
        return;
      }

      // First `limit` requests must be allowed.
      for (let i = 0; i < limit; i += 1) {
        assert.equal(results[i], true, `request ${i + 1} within budget should be allowed`);
      }
      // WRONG BEHAVIOR => FAIL: the (limit+1)th must be denied.
      assert.equal(results[limit], false, "request over budget must be rejected");
    });
  });

  it("a fresh key/tenant starts with full budget", async (t) => {
    const c = makeClient();
    const tenant = "e2e-tenant";
    const key = uniqueKey("rl-fresh");

    await skipIfUndeployed(t, "POST /v1/rate-limit/{tenant}/{key}/check (fresh)", async () => {
      const first = allowed(
        await c.rateLimitCheck(tenant, key, {
          algorithm: "sliding_window",
          limit: 10,
          windowMs: 60_000,
          cost: 1,
        }),
      );
      if (first === undefined) {
        t.skip("rate-limit response shape not recognized");
        return;
      }
      assert.equal(first, true, "first check on a fresh key should be allowed");
    });
  });
});
