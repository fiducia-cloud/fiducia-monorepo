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
// DISRUPTIVE test (kill a cluster) is gated behind both
// FIDUCIA_E2E_ALLOW_DISRUPTIVE=1 and an authenticated chaos-hook URL. The hook
// owns provider-specific disruption/healing; this suite verifies the outcome.

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

async function chaosAction(action, cluster) {
  const base = process.env.FIDUCIA_E2E_CHAOS_HOOK_URL?.trim();
  const token = process.env.FIDUCIA_E2E_CHAOS_HOOK_TOKEN?.trim();
  assert.ok(base, "FIDUCIA_E2E_CHAOS_HOOK_URL is required for disruptive tests");
  assert.ok(token, "FIDUCIA_E2E_CHAOS_HOOK_TOKEN is required for disruptive tests");
  const response = await fetch(base, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ action, cluster }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok, `chaos hook ${action} failed: HTTP ${response.status}`);
  assert.equal(body[action === "disrupt" ? "disrupted" : "healed"], true,
    `chaos hook must confirm ${action}`);
  return body;
}

async function disruptCluster(name) {
  return chaosAction("disrupt", name);
}

async function healCluster(name) {
  return chaosAction("heal", name);
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

  // Disruptive kill-a-cluster test. Gated OFF by default and requires an
  // authenticated provider-specific hook that confirms disruption and healing.
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

      const cluster = process.env.FIDUCIA_E2E_CHAOS_CLUSTER?.trim() || "hetzner";
      const killed = await disruptCluster(cluster);
      try {
        // 3. Confirm the selected cluster endpoint is actually unavailable.
        await assert.rejects(clientFor(eps[2]).status(),
          "the disrupted cluster endpoint must become unreachable");

        // 4. The pre-existing lock is still observable on a survivor endpoint.
        const view = await survivor.lockGet(key);
        const lock = view?.lock ?? output(view);
        if (lock && lock.holder !== undefined) {
          assert.equal(lock.holder, holder, "lock must survive a single-cluster loss (2/3 quorum)");
        }

        // 5. A brand-new lock still commits on the surviving 2/3.
        const key2 = uniqueKey("chaos-postkill");
        const holder2 = uniqueId("holder2");
        const grant2 = output(await survivor.tryLock(key2, { holder: holder2, ttlMs: 60_000 }));
        assert.equal(grant2.acquired, true, "a new lock must still commit on the surviving 2/3");
        await survivor.lockRelease(key2, { holder: holder2, fencingToken: grant2.fencing_token });
      } finally {
        await healCluster(cluster);
        await survivor.lockRelease(key, { holder, fencingToken: token });
      }
      t.diagnostic(`disruption confirmed: ${JSON.stringify(killed)}`);
    });
  });
});
