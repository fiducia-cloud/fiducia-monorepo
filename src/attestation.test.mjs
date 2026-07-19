import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { verifyInfraProofBundle } from "./attestation.mjs";
import { DEFAULT_LOCAL_MOCK_TOPOLOGY } from "./topology.mjs";

const source = Object.freeze({
  repository: "fiducia-infra",
  commit: "1234567890abcdef1234567890abcdef12345678",
  clean: true,
});

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture() {
  const topology = structuredClone(DEFAULT_LOCAL_MOCK_TOPOLOGY);
  topology.provider = "hetzner";
  for (const [index, cluster] of topology.clusters.entries()) {
    cluster.kubernetesDistribution = "vcluster";
    cluster.expectedKubernetesClusterUid = `kube-uid-${index}`;
  }
  const clusterIds = topology.clusters.map((cluster) => cluster.clusterId);
  const releaseId = "proof-release-1";
  const proofScope = "three-logically-isolated-vclusters-on-existing-hetzner-kubeadm";
  const releaseImages = {
    node: `ghcr.io/fiducia-cloud/fiducia-node@sha256:${"1".repeat(64)}`,
    sidecar: `ghcr.io/fiducia-cloud/fiducia-node-sidecar@sha256:${"2".repeat(64)}`,
    brain: `ghcr.io/fiducia-cloud/fiducia-brain@sha256:${"3".repeat(64)}`,
    load_balance: `ghcr.io/fiducia-cloud/fiducia-load-balance@sha256:${"4".repeat(64)}`,
  };
  const runtimeImage = (digit) => `containerd://sha256:${digit.repeat(64)}`;
  const infraEvidence = {
    schema_version: 1,
    proof_scope: proofScope,
    generated_at: "2026-07-18T12:00:00Z",
    source,
    release_id: releaseId,
    release: {
      schema_version: 1,
      topology: proofScope,
      profile: "vcluster",
      source,
      clusters: clusterIds,
      images: releaseImages,
      manifests: Object.fromEntries(clusterIds.map((clusterId, index) => [
        clusterId,
        `sha256:${String(index + 5).repeat(64)}`,
      ])),
      rendered_at: "2026-07-18T11:55:00Z",
    },
    clusters: topology.clusters.map((cluster, index) => ({
      cluster: cluster.clusterId,
      kubernetes_cluster_uid: cluster.expectedKubernetesClusterUid,
      visible_nodes: [{
        name: `dd-k8s-node-${index}`,
        uid: `node-uid-${index}`,
        providerID: `hcloud://${10_000 + index}`,
        labels: { region: cluster.region, zone: cluster.region },
      }],
      workload_placement: [
        {
          name: "fiducia-node-0",
          nodeName: `dd-k8s-node-${index}`,
          images: [
            { name: "node", image: releaseImages.node, imageID: runtimeImage("5"), ready: true },
            { name: "sidecar", image: releaseImages.sidecar, imageID: runtimeImage("6"), ready: true },
          ],
        },
        {
          name: "fiducia-brain-0",
          nodeName: `dd-k8s-node-${index}`,
          images: [
            { name: "brain", image: releaseImages.brain, imageID: runtimeImage("7"), ready: true },
            { name: "sidecar", image: releaseImages.sidecar, imageID: runtimeImage("6"), ready: true },
          ],
        },
        {
          name: `fiducia-load-balance-${index}abcde-abcde`,
          nodeName: `dd-k8s-node-${index}`,
          images: [{
            name: "lb",
            image: releaseImages.load_balance,
            imageID: runtimeImage("8"),
            ready: true,
          }],
        },
      ],
      topology: { FIDUCIA_CLUSTER: cluster.clusterId },
    })),
  };
  const topologyBytes = Buffer.from(`${JSON.stringify(topology, null, 2)}\n`);
  const infraEvidenceBytes = Buffer.from(`${JSON.stringify(infraEvidence, null, 2)}\n`);
  const attestation = {
    schema_version: 1,
    provider: "hetzner",
    proof_scope: proofScope,
    source,
    release_id: releaseId,
    topology: { file: "proof-topology.json", sha256: hash(topologyBytes) },
    infra_evidence: { file: "infra-evidence.json", sha256: hash(infraEvidenceBytes) },
  };
  return {
    attestationBytes: Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`),
    topologyBytes,
    infraEvidenceBytes,
  };
}

function replaceEvidence(value, mutate) {
  const evidence = JSON.parse(value.infraEvidenceBytes);
  mutate(evidence);
  value.infraEvidenceBytes = Buffer.from(`${JSON.stringify(evidence)}\n`);
  const attestation = JSON.parse(value.attestationBytes);
  attestation.infra_evidence.sha256 = hash(value.infraEvidenceBytes);
  value.attestationBytes = Buffer.from(`${JSON.stringify(attestation)}\n`);
  return value;
}

describe("Hetzner infrastructure proof attestation", () => {
  it("rehashes both siblings and binds topology identities to hcloud placement evidence", () => {
    const verified = verifyInfraProofBundle({
      ...fixture(),
      env: { FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST: "1" },
    });
    assert.equal(verified.topology.provider, "hetzner");
    assert.equal(verified.attestation.source.repository, "fiducia-infra");
    assert.deepEqual(
      Object.keys(verified.providerPlacement.providerIdsByCluster),
      verified.topology.clusters.map((cluster) => cluster.clusterId),
    );
  });

  it("rejects any byte-level topology or evidence substitution", () => {
    const topologyTamper = fixture();
    topologyTamper.topologyBytes = Buffer.concat([topologyTamper.topologyBytes, Buffer.from(" ")]);
    assert.throws(
      () => verifyInfraProofBundle({
        ...topologyTamper,
        env: { FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST: "1" },
      }),
      /topology SHA-256/,
    );

    const evidenceTamper = fixture();
    evidenceTamper.infraEvidenceBytes = Buffer.concat([
      evidenceTamper.infraEvidenceBytes,
      Buffer.from(" "),
    ]);
    assert.throws(
      () => verifyInfraProofBundle({
        ...evidenceTamper,
        env: { FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST: "1" },
      }),
      /evidence SHA-256/,
    );
  });

  it("rejects shared or non-Hetzner physical provider placement", () => {
    for (const mutate of [
      (evidence) => { evidence.clusters[0].visible_nodes[0].providerID = "aws:///node-1"; },
      (evidence) => {
        evidence.clusters[1].visible_nodes[0].providerID =
          evidence.clusters[0].visible_nodes[0].providerID;
      },
    ]) {
      const value = replaceEvidence(fixture(), mutate);
      assert.throws(() => verifyInfraProofBundle({
        ...value,
        env: { FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST: "1" },
      }));
    }
  });

  it("rejects workload, release-image, readiness, runtime-ID, and node-placement drift", () => {
    for (const mutate of [
      (evidence) => { delete evidence.release.images.brain; },
      (evidence) => { evidence.release.images.extra = evidence.release.images.node; },
      (evidence) => { evidence.clusters[0].workload_placement.splice(1, 1); },
      (evidence) => { evidence.clusters[0].workload_placement[0].name = "unrelated-pod"; },
      (evidence) => { evidence.clusters[0].workload_placement[0].images[0].image = evidence.release.images.brain; },
      (evidence) => { evidence.clusters[0].workload_placement[0].images[0].ready = false; },
      (evidence) => { evidence.clusters[0].workload_placement[0].images[0].imageID = ""; },
      (evidence) => { evidence.clusters[0].workload_placement[0].nodeName = "different-node"; },
      (evidence) => { evidence.clusters[0].visible_nodes.push({ ...evidence.clusters[0].visible_nodes[0], name: "second-node", providerID: "hcloud://99999" }); },
    ]) {
      const value = replaceEvidence(fixture(), mutate);
      assert.throws(() => verifyInfraProofBundle({
        ...value,
        env: { FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST: "1" },
      }));
    }
  });
});
