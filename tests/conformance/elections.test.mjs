// Conformance: leader election (campaign / renew / get).
//
// Real-world framing: active/standby failover, a regional primary, a
// Kubernetes-operator leader — exactly one owner of a critical action at a time.
// Invariants: one campaigner wins (won:true); a second sees the current leader
// (won:false); renew with the right fencing token keeps leadership; a wrong or
// stale token is not_leader.
//
// Routes/bodies per fiducia-clients/PROTOCOL.md ("Leader election — live") and
// fiducia-node.rs/README.md (winner gets `won:true` + a `leadership` object with
// `leader`, `lease_expires_ms`, `metadata`, `fencing_token`).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { output, HttpError } from "../../src/client.mjs";
import { makeClient } from "../../src/endpoints.mjs";
import { NO_ENDPOINT, uniqueId, skipIfUndeployed } from "../helpers.mjs";

const TTL = 15_000;

function wonFlag(res) {
  const o = output(res);
  if (typeof o?.won === "boolean") return o.won;
  if (typeof o?.acquired === "boolean") return o.acquired;
  if (typeof o?.elected === "boolean") return o.elected;
  return undefined;
}
function tokenOf(res) {
  const o = output(res);
  return o?.fencing_token ?? o?.leadership?.fencing_token;
}

describe("leader election", { skip: NO_ENDPOINT }, () => {
  it("one candidate wins, a second sees the current leader", async (t) => {
    const c = makeClient();
    const name = uniqueId("election");
    const a = uniqueId("cand-a");
    const b = uniqueId("cand-b");

    await skipIfUndeployed(t, "POST /v1/elections/{name}/campaign", async () => {
      const first = await c.electionCampaign(name, a, TTL, { region: "us-east-1" });
      const firstWon = wonFlag(first);
      if (firstWon !== undefined) {
        assert.equal(firstWon, true, "first candidate for a fresh election should win");
      }

      const second = await c.electionCampaign(name, b, TTL, { region: "eu-central" });
      const secondWon = wonFlag(second);
      // WRONG BEHAVIOR => FAIL: two simultaneous winners = split brain.
      if (secondWon !== undefined) {
        assert.equal(secondWon, false, "a second campaigner must NOT also win (no split brain)");
      }

      // The loser (and any reader) should observe the incumbent leader.
      const view = await c.electionGet(name);
      const leadership = view?.leadership ?? output(view);
      if (leadership && (leadership.leader !== undefined || view.held !== undefined)) {
        if (leadership.leader !== undefined) {
          assert.equal(leadership.leader, a, "current leader should be the first candidate");
        }
      }

      const token = tokenOf(first);
      if (token !== undefined) await c.electionResign(name, a, token);
    });
  });

  it("renew with the right token keeps leadership; a wrong token is not_leader", async (t) => {
    const c = makeClient();
    const name = uniqueId("election-renew");
    const a = uniqueId("cand-a");

    await skipIfUndeployed(t, "POST /v1/elections/{name}/renew", async () => {
      const campaign = await c.electionCampaign(name, a, TTL);
      const token = tokenOf(campaign);
      if (typeof token !== "number") {
        t.skip("no numeric fencing token returned from campaign; cannot test renew");
        return;
      }

      const renew = output(await c.electionRenew(name, a, token));
      const renewed = renew?.renewed ?? renew?.won ?? renew?.leadership !== undefined;
      assert.notEqual(renewed, false, "renew with the correct fencing token should keep leadership");

      // WRONG BEHAVIOR => FAIL: a stale/incorrect token must not renew.
      let notLeader = false;
      try {
        const bad = output(await c.electionRenew(name, a, token - 1));
        if (bad && (bad.renewed === false || bad.not_leader === true || bad.won === false || bad.error)) {
          notLeader = true;
        }
      } catch (err) {
        if (err instanceof HttpError && err.status >= 400 && err.status < 500) notLeader = true;
        else throw err;
      }
      assert.ok(notLeader, "renew with a wrong/stale fencing token must be rejected (not_leader)");

      await c.electionResign(name, a, token);
    });
  });
});
