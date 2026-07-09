// Chaos / cross-cluster invariants.
//
// This is the layer that justifies the whole repo: fiducia-infra places one
// shard replica per cluster (RF=3, one per GCP/AWS/Hetzner) so that losing ANY
// ONE cluster still leaves a 2/3 quorum serving. See fiducia-infra/README.md
// ("Why 2-of-3 works") and topology.toml (the three lb_endpoint values).
//
// Configure with FIDUCIA_E2E_ENDPOINTS = the >=3 cluster LB URLs, e.g.:
//   FIDUCIA_E2E_ENDPOINTS="https://gcp.lb.fiducia.cloud,https://aws.lb.fiducia.cloud,https://hetzner.lb.fiducia.cloud"
//
// SAFE assertions (run whenever >=3 endpoints are set):
//   (a) every endpoint's /v1/status reports a healthy quorum;
//   (b) a lock acquired via endpoint A is observable via endpoint B
//       (cross-cluster linearizability — all lock state is one Raft group).
//
// DISRUPTIVE test (kill a cluster) is DOCUMENTED and gated behind
// FIDUCIA_E2E_ALLOW_DISRUPTIVE=1, and even then only calls a no-op
// `disruptCluster` stub — this repo never actually kills infrastructure.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FiduciaClient, output } from "../../src/client.mjs";
import { endpoints, apiKey } from "../../src/endpoints.mjs";
import { uniqueKey, uniqueId, skipIfUndeployed } from "../helpers.mjs";

const eps = endpoints();
const MULTI = eps.length >= 3
  ? false
  : `cross-cluster chaos needs >=3 endpoints in FIDUCIA_E2E_ENDPOINTS (have ${eps.length})`;

function clientFor(url) {
  return new FiduciaClient(url, { apiKey: apiKey() });
}

// Best-effort quorum health read. /v1/status is {service, consensus, ...}; the
// exact per-shard health shape isn't pinned in PROTOCOL.md, so we accept the
// endpoint as healthy if it answers 2xx and, where present, does not report an
// explicit unhealthy/no-quorum flag. VERIFY against PROTOCOL.md / fiducia-node
// once the /v1/status schema is fixed.
function looksHealthy(status) {
  if (!status || typeof status !== "object") return false;
  if (status.healthy === false) return false;
  if (status.quorum === false) return false;
  if (typeof status.status === "string" && ["unhealthy", "down", "no_quorum"].includes(status.status.toLowerCase())) {
    return false;
  }
  return true;
}

// No-op disruption hook. A real harness would (for LOCAL/kind) cordon+drain or
// `kubectl delete` the target cluster's node pods, or (for cloud) fail its LB
// health check so the edge steers away. Here it is intentionally inert so the
// suite can never take down infrastructure.
async function disruptCluster(name) {
  void name;
  return { disrupted: false, note: "no-op stub; real kill wired only in the infra harness" };
}
async function healCluster(name) {
  void name;
  return { healed: true };
}

describe("chaos / cross-cluster quorum", { skip: MULTI }, () => {
  it("(a) every cluster endpoint reports a healthy quorum", async (t) => {
    await skipIfUndeployed(t, "GET /v1/status (all endpoints)", async () => {
      for (const url of eps) {
        const status = await clientFor(url).status();
        assert.ok(looksHealthy(status), `endpoint ${url} should report a healthy quorum`);
      }
    });
  });

  it("(b) a lock acquired via endpoint A is observable via endpoint B", async (t) => {
    const a = clientFor(eps[0]);
    const b = clientFor(eps[1]);
    const key = uniqueKey("chaos-xcluster");
    const holder = uniqueId("holder");

    await skipIfUndeployed(t, "cross-cluster lock acquire/observe", async () => {
      const grant = output(await a.tryLock(key, { holder, ttlMs: 30_000 }));
      assert.equal(grant.acquired, true, "lock should be acquired via endpoint A");
      const token = grant.fencing_token;

      // Read the SAME lock through a DIFFERENT cluster's LB. All lock state is a
      // single Raft group (LOCK_DOMAIN), so a committed grant is linearizable
      // across every endpoint. WRONG BEHAVIOR => FAIL: B must see it held, and
      // must refuse a second acquire.
      const view = await b.lockGet(key);
      const lock = view?.lock ?? output(view);
      if (lock && lock.holder !== undefined) {
        assert.equal(lock.holder, holder, "endpoint B must observe the same holder");
      }
      const contend = output(await b.tryLock(key, { holder: uniqueId("other"), ttlMs: 30_000 }));
      assert.notEqual(contend.acquired, true, "endpoint B must refuse a lock already held via A");

      await a.lockRelease(key, { holder, fencingToken: token });
    });
  });

  // Disruptive kill-a-cluster test. Gated OFF by default; even when enabled it
  // only drives the no-op disruptCluster stub, so nothing is actually killed
  // here. This documents the intended flow for a real infra harness to fill in.
  it("(c) surviving 2/3 after a cluster loss (disruptive; gated)", { skip: process.env.FIDUCIA_E2E_ALLOW_DISRUPTIVE !== "1" }, async (t) => {
    await skipIfUndeployed(t, "disruptive cluster-loss flow", async () => {
      const a = clientFor(eps[0]);
      const survivor = clientFor(eps[1]);
      const key = uniqueKey("chaos-kill");
      const holder = uniqueId("holder");

      // 1. Establish a lock before the disruption.
      const grant = output(await a.tryLock(key, { holder, ttlMs: 60_000 }));
      assert.equal(grant.acquired, true);
      const token = grant.fencing_token;

      // 2. Kill one cluster (NO-OP here). A real harness kills eps[2]'s cluster.
      const killed = await disruptCluster("hetzner");
      // With the stub inert, we can only assert the intended invariants against
      // the still-live endpoints; a real harness would first confirm eps[2] is
      // unreachable, then assert the following against the remaining 2/3:

      // 3. The pre-existing lock is still observable on a survivor endpoint.
      const view = await survivor.lockGet(key);
      const lock = view?.lock ?? output(view);
      if (lock && lock.holder !== undefined) {
        assert.equal(lock.holder, holder, "lock must survive a single-cluster loss (2/3 quorum)");
      }

      // 4. A brand-new lock still commits on the surviving 2/3.
      const key2 = uniqueKey("chaos-postkill");
      const holder2 = uniqueId("holder2");
      const grant2 = output(await survivor.tryLock(key2, { holder: holder2, ttlMs: 60_000 }));
      assert.equal(grant2.acquired, true, "a new lock must still commit on the surviving 2/3");
      await survivor.lockRelease(key2, { holder: holder2, fencingToken: grant2.fencing_token });

      // 5. Heal and clean up.
      await healCluster("hetzner");
      await a.lockRelease(key, { holder, fencingToken: token });
      t.diagnostic(`disruptCluster stub result: ${JSON.stringify(killed)}`);
    });
  });
});
