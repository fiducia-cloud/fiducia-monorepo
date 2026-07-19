import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FiduciaClient } from "../../src/client.mjs";
import { validateProofIdentities, validateRaftConvergence } from "../../src/proof.mjs";
import { loadProofTopology } from "../../src/topology.mjs";
import { assertHealthyNodeStatus, STRICT_PROOF } from "../helpers.mjs";

const execFileAsync = promisify(execFile);
const SKIP = STRICT_PROOF ? false : "set FIDUCIA_E2E_STRICT_PROOF=1 through the proof runner";

function connectionArgs(cluster) {
  return [
    ...(cluster.kubeconfig ? ["--kubeconfig", cluster.kubeconfig] : []),
    "--context",
    cluster.kubeContext,
  ];
}

async function kubernetesClusterUid(cluster) {
  const { stdout } = await execFileAsync(
    process.env.FIDUCIA_E2E_KUBECTL || "kubectl",
    [...connectionArgs(cluster), "get", "namespace", "kube-system", "--output", "json"],
    { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const uid = JSON.parse(stdout)?.metadata?.uid;
  assert.equal(typeof uid, "string", `${cluster.clusterId} kube-system UID`);
  assert.ok(uid.length > 0, `${cluster.clusterId} kube-system UID is nonempty`);
  return uid;
}

function pinnedNodeClient(cluster) {
  const internalSecret = process.env.FIDUCIA_E2E_INTERNAL_SECRET
    || process.env.FIDUCIA_E2E_LOCAL_EDGE_SECRET;
  assert.ok(internalSecret, "strict proof requires a direct-node internal secret");
  return new FiduciaClient(cluster.nodeEndpoint, {
    internalSecret,
    internalOrgId: process.env.FIDUCIA_E2E_ORG_ID,
  });
}

describe("strict proof / three independent Hetzner clusters", { skip: SKIP }, () => {
  it("requires distinct identities and one converged three-member Raft group", async (t) => {
    const topology = loadProofTopology({ allowDefault: false });
    assert.ok(topology, "strict proof requires an explicit topology");
    assert.equal(topology.clusters.length, 3, "strict proof has exactly three clusters");
    const observations = await Promise.all(topology.clusters.map(async (cluster) => {
      const [kubernetesUid, status] = await Promise.all([
        kubernetesClusterUid(cluster),
        pinnedNodeClient(cluster).status(),
      ]);
      assertHealthyNodeStatus(status, cluster.clusterId);
      return {
        clusterId: cluster.clusterId,
        kubernetesClusterUid: kubernetesUid,
        fiduciaMemberId: status.consensus.node_id,
        status,
      };
    }));
    const identities = validateProofIdentities(topology, observations);
    const raft = validateRaftConvergence(topology, observations);
    t.diagnostic(`verified cluster IDs: ${identities.clusterIds.join(", ")}`);
    t.diagnostic(
      `verified ${identities.isolationMode} placement labels: ${identities.regions.join(", ")}`,
    );
    t.diagnostic(`verified distinct kube contexts: ${identities.kubeContexts.join(", ")}`);
    t.diagnostic(`verified 3 distinct Kubernetes cluster UIDs and Fiducia member IDs`);
    t.diagnostic(`verified ${raft.memberCount}-member Raft convergence across ${raft.shardCount} shards`);
  });
});
