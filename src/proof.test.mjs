import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  redactText,
  sanitizeEvidence,
  secretValuesFromEnv,
  validateLiveDeployments,
  validateProofIdentities,
  validateRaftConvergence,
} from "./proof.mjs";
import { validateProofTopology, DEFAULT_LOCAL_MOCK_TOPOLOGY } from "./topology.mjs";

const env = { FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST: "1" };
const topology = validateProofTopology(DEFAULT_LOCAL_MOCK_TOPOLOGY, { env });

function observations() {
  return topology.clusters.map((cluster, index) => ({
    clusterId: cluster.clusterId,
    kubernetesClusterUid: `kube-uid-${index}`,
    fiduciaMemberId: `fiducia-member-${index}`,
  }));
}

function raftObservations() {
  const nodeIds = topology.clusters.map((cluster) => `fiducia-node-0.${cluster.clusterId}`);
  const peerAddresses = topology.clusters.map((cluster) => `peer-${cluster.clusterId}:9090`);
  const shardCount = 2;
  return topology.clusters.map((cluster, memberIndex) => {
    const peers = peerAddresses.filter((_, peerIndex) => peerIndex !== memberIndex);
    return {
      clusterId: cluster.clusterId,
      status: {
        service: "fiducia-node",
        consensus: {
          node_id: nodeIds[memberIndex],
          peers,
          shard_count: shardCount,
          hosted_shards: [0, 1],
          unresponsive_shards: [],
          shards: [0, 1].map((shardId) => {
            const leaderIndex = shardId;
            const leader = memberIndex === leaderIndex;
            const commitIndex = 20 + shardId;
            return {
              shard_id: shardId,
              role: leader ? "leader" : "follower",
              term: 7 + shardId,
              leader_id: nodeIds[leaderIndex],
              commit_index: commitIndex,
              last_applied: commitIndex,
              last_log_index: commitIndex,
              storage_healthy: true,
              has_quorum: leader,
              healthy_replicas: leader ? 3 : 0,
              replication: leader
                ? peers.map((peer) => ({ peer, match_index: commitIndex, lag: 0, in_flight: false }))
                : [],
            };
          }),
        },
      },
    };
  });
}

function liveDeploymentFixture() {
  const images = {
    node: `ghcr.io/fiducia-cloud/fiducia-node@sha256:${"1".repeat(64)}`,
    sidecar: `ghcr.io/fiducia-cloud/fiducia-node-sidecar@sha256:${"2".repeat(64)}`,
    brain: `ghcr.io/fiducia-cloud/fiducia-brain@sha256:${"3".repeat(64)}`,
    load_balance: `ghcr.io/fiducia-cloud/fiducia-load-balance@sha256:${"4".repeat(64)}`,
  };
  const runtime = (digit) => `containerd://sha256:${digit.repeat(64)}`;
  const infraEvidence = {
    release: { images },
    clusters: topology.clusters.map((cluster, index) => ({
      cluster: cluster.clusterId,
      visible_nodes: [{
        name: `host-${index}`,
        uid: `node-uid-${index}`,
        providerID: `hcloud://${10_000 + index}`,
      }],
    })),
  };
  const live = topology.clusters.map((cluster, index) => {
    const nodeName = `host-${index}`;
    const record = (pod, container, declaredImage, digit) => ({
      pod,
      nodeName,
      container,
      declaredImage,
      imageDigest: runtime(digit),
      ready: true,
      restartCount: 0,
    });
    return {
      clusterId: cluster.clusterId,
      physicalNodePlacement: {
        available: true,
        nodes: [{
          name: nodeName,
          uid: `node-uid-${index}`,
          providerId: `hcloud://${10_000 + index}`,
        }],
      },
      images: [
        record("fiducia-node-0", "node", images.node, "5"),
        record("fiducia-node-0", "sidecar", images.sidecar, "6"),
        record("fiducia-brain-0", "brain", images.brain, "7"),
        record("fiducia-brain-0", "sidecar", images.sidecar, "6"),
        record(`fiducia-load-balance-${index}abcde-abcde`, "lb", images.load_balance, "8"),
      ],
    };
  });
  return { infraEvidence, live };
}

describe("strict proof evidence", () => {
  it("requires exactly three distinct live identity dimensions", () => {
    const identities = validateProofIdentities(topology, observations());
    assert.equal(identities.clusterIds.length, 3);
    assert.equal(identities.regions.length, 3);
    assert.equal(identities.kubeContexts.length, 3);
    assert.equal(identities.kubernetesClusterUids.length, 3);
    assert.equal(identities.fiduciaMemberIds.length, 3);

    for (const mutate of [
      (value) => value.pop(),
      (value) => { value[1].clusterId = "wrong-cluster"; },
      (value) => { value[1].kubernetesClusterUid = value[0].kubernetesClusterUid; },
      (value) => { value[1].fiduciaMemberId = value[0].fiduciaMemberId; },
      (value) => { value[1].fiduciaMemberId = ""; },
    ]) {
      const value = observations();
      mutate(value);
      assert.throws(() => validateProofIdentities(topology, value));
    }
  });

  it("permits repeated physical regions for distinct logical cluster identities", () => {
    const logical = structuredClone(topology);
    logical.isolationMode = "logical";
    for (const cluster of logical.clusters) cluster.region = "fsn1";
    const identities = validateProofIdentities(logical, observations());
    assert.deepEqual(identities.regions, ["fsn1", "fsn1", "fsn1"]);
    assert.equal(new Set(identities.kubernetesClusterUids).size, 3);
  });

  it("honors optional expected live identities", () => {
    const expected = structuredClone(topology);
    expected.clusters[0].expectedKubernetesClusterUid = "different";
    assert.throws(
      () => validateProofIdentities(expected, observations()),
      /does not match topology/,
    );
  });

  it("requires one converged RF=3 group across the three pinned node statuses", () => {
    const raft = validateRaftConvergence(topology, raftObservations());
    assert.equal(raft.memberCount, 3);
    assert.equal(raft.shardCount, 2);
    assert.equal(raft.shards.length, 2);

    for (const mutate of [
      (value) => value[0].status.consensus.peers.pop(),
      (value) => { value[0].status.consensus.unresponsive_shards = [0]; },
      (value) => { value[2].status.consensus.shards[0].storage_healthy = false; },
      (value) => { value[1].status.consensus.shards[0].term += 1; },
      (value) => { value[2].status.consensus.shards[0].commit_index -= 1; value[2].status.consensus.shards[0].last_applied -= 1; },
      (value) => { value[0].status.consensus.shards[0].healthy_replicas = 2; },
      (value) => { value[0].status.consensus.shards[0].replication.pop(); },
      (value) => { value[1].status.consensus.shards[0].role = "candidate"; },
      (value) => { value[1].status.consensus.shards[0].leader_id = value[1].status.consensus.node_id; },
    ]) {
      const value = raftObservations();
      mutate(value);
      assert.throws(() => validateRaftConvergence(topology, value));
    }
  });

  it("binds fresh runtime pods and physical placement to the attested release", () => {
    const fixture = liveDeploymentFixture();
    const result = validateLiveDeployments(topology, fixture.live, fixture.infraEvidence);
    assert.deepEqual(Object.keys(result), topology.clusters.map((cluster) => cluster.clusterId));

    for (const mutate of [
      (value) => { value.live[0].physicalNodePlacement.nodes[0].providerId = "hcloud://99999"; },
      (value) => { value.live[0].images[0].declaredImage = value.infraEvidence.release.images.brain; },
      (value) => { value.live[0].images[0].imageDigest = ""; },
      (value) => { value.live[0].images[0].ready = false; },
      (value) => { value.live[0].images[0].nodeName = "different-node"; },
      (value) => { value.live[0].images = value.live[0].images.filter((image) => image.pod !== "fiducia-brain-0"); },
    ]) {
      const value = liveDeploymentFixture();
      mutate(value);
      assert.throws(() => validateLiveDeployments(topology, value.live, value.infraEvidence));
    }
  });

  it("redacts secret fields, kubeconfig paths, and secret env values", () => {
    assert.deepEqual(
      sanitizeEvidence({ apiToken: "abc", nested: { password: "pw" }, kubeconfig: "/private/kube" }),
      { apiToken: "[REDACTED]", nested: { password: "[REDACTED]" }, kubeconfig: "[configured local path]" },
    );
    const secrets = secretValuesFromEnv({
      FIDUCIA_E2E_API_KEY: "api-secret-value",
      FIDUCIA_E2E_ORG_ID: "not-secret",
    });
    assert.deepEqual(secrets, ["api-secret-value"]);
    assert.equal(redactText("failed with api-secret-value", secrets), "failed with [REDACTED]");
  });
});
