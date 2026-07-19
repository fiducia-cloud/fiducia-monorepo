// Chaos / cross-cluster invariants.
//
// This is the layer that justifies the whole repo: fiducia-infra places one
// shard replica per cluster (RF=3, one per Hetzner test cluster) so that losing ANY
// ONE cluster still leaves a 2/3 quorum serving. See fiducia-infra/README.md
// ("Why 2-of-3 works") and topology.toml (the three lb_endpoint values).
//
// Configure with a validated three-cluster topology. Strict proof mode receives
// an explicit infra-attested Hetzner topology and never uses the local Kind mock.
//
// SAFE assertions (run whenever exactly 3 endpoints are set):
//   (a) every endpoint's /v1/status reports a healthy quorum;
//   (b) a lock acquired via endpoint A is observable via endpoint B
//       (cross-cluster linearizability — all lock state is one Raft group).
//
// DISRUPTIVE test (stop one cluster's fiducia-node StatefulSets) is gated behind
// FIDUCIA_E2E_ALLOW_DISRUPTIVE=1; the validated topology selects the context.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { output } from "../../src/client.mjs";
import { endpoints, makeClient } from "../../src/endpoints.mjs";
import { loadProofTopology, topologyConfigured } from "../../src/topology.mjs";
import { assertHealthyNodeStatus, uniqueKey, uniqueId, skipIfUndeployed } from "../helpers.mjs";
import {
  disruptCluster as disruptWithKubectl,
  healCluster as healWithKubectl
} from "./kubectl.mjs";

const eps = endpoints();
const MULTI = eps.length === 3
  ? false
  : `cross-cluster proof needs exactly 3 endpoints (have ${eps.length})`;
const configuredTopology = topologyConfigured()
  ? loadProofTopology({ allowDefault: true })
  : null;

function clientFor(url) {
  return makeClient(url);
}

async function eventually(fn, { timeoutMs = 120_000, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(`timed out waiting for healed cluster: ${lastError?.message ?? lastError}`);
}

async function chaosHookAction(action, cluster) {
  const base = process.env.FIDUCIA_E2E_CHAOS_HOOK_URL?.trim();
  const token = process.env.FIDUCIA_E2E_CHAOS_HOOK_TOKEN?.trim();
  assert.ok(base, "FIDUCIA_E2E_CHAOS_HOOK_URL is required for hook-based chaos");
  assert.ok(token, "FIDUCIA_E2E_CHAOS_HOOK_TOKEN is required for hook-based chaos");
  const hook = new URL(base);
  assert.equal(hook.protocol, "https:", "credential-bearing chaos hooks require HTTPS");
  const response = await fetch(base, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ action, cluster }),
    signal: AbortSignal.timeout(60_000)
  });
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok, `chaos hook ${action} failed: HTTP ${response.status}`);
  assert.equal(
    body[action === "disrupt" ? "disrupted" : "healed"],
    true,
    `chaos hook must confirm ${action}`
  );
  return { ...body, provider: "hook" };
}

async function disruptCluster(name) {
  return process.env.FIDUCIA_E2E_CHAOS_HOOK_URL?.trim()
    ? chaosHookAction("disrupt", name)
    : disruptWithKubectl(name);
}

async function healCluster(name, provider) {
  return provider === "hook"
    ? chaosHookAction("heal", name)
    : healWithKubectl(name);
}

describe("chaos / cross-cluster quorum", { skip: MULTI }, () => {
  it("(a) every cluster endpoint reports a healthy quorum", async (t) => {
    await skipIfUndeployed(t, "GET /v1/status (all endpoints)", async () => {
      for (const url of eps) {
        const status = await clientFor(url).status();
        assertHealthyNodeStatus(status, `endpoint ${url}`);
      }
    });
  });

  it("(b) every endpoint observes and excludes locks acquired through another endpoint", async (t) => {
    await skipIfUndeployed(t, "cross-cluster lock acquire/observe", async () => {
      for (let index = 0; index < eps.length; index += 1) {
        const acquiring = clientFor(eps[index]);
        const observing = clientFor(eps[(index + 1) % eps.length]);
        const key = uniqueKey(`chaos-xcluster-${index}`);
        const holder = uniqueId(`holder-${index}`);
        const grant = output(await acquiring.tryLock(key, { holder, ttlMs: 30_000 }));
        assert.equal(grant.acquired, true, `endpoint ${index} acquires its lock`);

        const view = await observing.lockGet(key);
        const lock = view?.lock ?? output(view);
        assert.ok(lock && typeof lock === "object", "another endpoint returns the lock record");
        assert.equal(lock.holder, holder, "another endpoint observes the same holder");
        const contend = output(await observing.tryLock(key, {
          holder: uniqueId(`contender-${index}`),
          ttlMs: 30_000,
        }));
        assert.notEqual(contend.acquired, true, "another endpoint refuses the held lock");
        await acquiring.lockRelease(key, { holder, fencingToken: grant.fencing_token });
      }
    });
  });

  // Disruptive cluster-loss test. Gated OFF by default and requires an explicit
  // validated kubectl context; the helper records replica counts and heals them.
  it("(c) surviving 2/3 after a cluster loss (disruptive; gated)", { skip: process.env.FIDUCIA_E2E_ALLOW_DISRUPTIVE !== "1" }, async (t) => {
    await skipIfUndeployed(t, "disruptive cluster-loss flow", async () => {
      assert.ok(
        configuredTopology,
        "disruptive chaos requires FIDUCIA_E2E_TOPOLOGY_JSON/_FILE; legacy endpoints are read-only",
      );
      const topology = configuredTopology;
      const target =
        process.env.FIDUCIA_E2E_CHAOS_TARGET
        || topology.clusters[2].clusterId;
      const targetIndex = topology.clusters.findIndex((cluster) => cluster.clusterId === target);
      assert.notEqual(targetIndex, -1, `chaos target ${target} must be present in topology`);
      const survivorIndexes = [0, 1, 2].filter((index) => index !== targetIndex);
      const a = clientFor(eps[survivorIndexes[0]]);
      const survivor = clientFor(eps[survivorIndexes[1]]);
      const key = uniqueKey("chaos-kill");
      const holder = uniqueId("holder");

      // 1. Establish a lock before the disruption.
      const grant = output(await a.tryLock(key, { holder, ttlMs: 60_000 }));
      assert.equal(grant.acquired, true);
      const token = grant.fencing_token;

      const killed = await disruptCluster(target);
      try {
        // 3. Confirm the selected cluster endpoint is actually unavailable.
        await assert.rejects(
          clientFor(eps[targetIndex]).status(),
          "the disrupted cluster endpoint must become unreachable"
        );

        // 4. The pre-existing lock is still observable on a survivor endpoint.
        const view = await survivor.lockGet(key);
        const lock = view?.lock ?? output(view);
        assert.ok(lock && typeof lock === "object", "survivor must return the lock record");
        assert.equal(lock.holder, holder, "lock must survive a single-cluster loss (2/3 quorum)");

        // 5. A brand-new lock still commits on the surviving 2/3.
        const key2 = uniqueKey("chaos-postkill");
        const holder2 = uniqueId("holder2");
        const grant2 = output(await survivor.tryLock(key2, { holder: holder2, ttlMs: 60_000 }));
        assert.equal(grant2.acquired, true, "a new lock must still commit on the surviving 2/3");
        await survivor.lockRelease(key2, { holder: holder2, fencingToken: grant2.fencing_token });
      } finally {
        // Always restore the original replica counts, even when an assertion fails.
        await healCluster(target, killed.provider);
        await eventually(async () => {
          const healed = await clientFor(eps[targetIndex]).status();
          assertHealthyNodeStatus(healed, `rejoined ${target}`);
        });
        await survivor.lockRelease(key, { holder, fencingToken: token }).catch(() => {});
      }
      t.diagnostic(`disruption result: ${JSON.stringify(killed)}`);
    });
  });
});
