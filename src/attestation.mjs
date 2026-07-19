import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { validateProofTopology } from "./topology.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;
const HCLOUD_PROVIDER_ID = /^hcloud:\/\/[1-9][0-9]*$/;
const IMAGE_DIGEST = /^ghcr\.io\/fiducia-cloud\/[a-z0-9._-]+@sha256:[0-9a-f]{64}$/;
const MANIFEST_DIGEST = /^sha256:[0-9a-f]{64}$/;
const RUNTIME_IMAGE_ID = /^(?:(?:containerd|cri-o|docker|docker-pullable):\/\/)?(?:[^\s@]+@)?sha256:[0-9a-f]{64}$/;
const RELEASE_IMAGE_KEYS = Object.freeze(["brain", "load_balance", "node", "sidecar"]);
const WORKLOAD_CONTRACTS = Object.freeze([
  Object.freeze({
    name: "fiducia-node",
    podName: /^fiducia-node-[0-9]+$/,
    containers: Object.freeze({ node: "node", sidecar: "sidecar" }),
  }),
  Object.freeze({
    name: "fiducia-brain",
    podName: /^fiducia-brain-[0-9]+$/,
    containers: Object.freeze({ brain: "brain", sidecar: "sidecar" }),
  }),
  Object.freeze({
    name: "fiducia-load-balance",
    podName: /^fiducia-load-balance-[a-z0-9-]+$/,
    containers: Object.freeze({ lb: "load_balance" }),
  }),
]);
const MAX_ATTESTATION_BYTES = 1024 * 1024;
const MAX_TOPOLOGY_BYTES = 1024 * 1024;
const MAX_INFRA_EVIDENCE_BYTES = 64 * 1024 * 1024;
const SCOPES = Object.freeze({
  logical: {
    proofScope: "three-logically-isolated-vclusters-on-existing-hetzner-kubeadm",
    profile: "vcluster",
    distribution: "vcluster",
  },
  regional: {
    proofScope: "three-independent-single-node-k3s-on-hetzner",
    profile: "vm",
    distribution: "k3s",
  },
});

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
}

function exactKeys(value, expected, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function nonempty(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value.trim();
}

function parseJson(bytes, label, maxBytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
  if (buffer.length > maxBytes) throw new Error(`${label} exceeds its bounded size limit`);
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${error.message}`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameSource(actual, expected, label) {
  exactKeys(actual, ["repository", "commit", "clean"], label);
  if (actual.repository !== "fiducia-infra" || actual.clean !== true) {
    throw new Error(`${label} must identify a clean fiducia-infra checkout`);
  }
  if (!GIT_COMMIT.test(actual.commit)) throw new Error(`${label}.commit must be a Git SHA-1`);
  if (
    expected
    && (actual.repository !== expected.repository
      || actual.commit !== expected.commit
      || actual.clean !== expected.clean)
  ) {
    throw new Error(`${label} does not match the attested source`);
  }
}

function validateAttestation(value) {
  exactKeys(value, [
    "schema_version",
    "provider",
    "proof_scope",
    "source",
    "release_id",
    "topology",
    "infra_evidence",
  ], "infra attestation");
  if (value.schema_version !== 1) throw new Error("infra attestation schema_version must be 1");
  if (value.provider !== "hetzner") throw new Error("infra attestation provider must be hetzner");
  nonempty(value.proof_scope, "infra attestation proof_scope");
  nonempty(value.release_id, "infra attestation release_id");
  sameSource(value.source, null, "infra attestation source");
  for (const [field, filename] of [
    ["topology", "proof-topology.json"],
    ["infra_evidence", "infra-evidence.json"],
  ]) {
    exactKeys(value[field], ["file", "sha256"], `infra attestation ${field}`);
    if (value[field].file !== filename) {
      throw new Error(`infra attestation ${field}.file must be the sibling ${filename}`);
    }
    if (!SHA256.test(value[field].sha256)) {
      throw new Error(`infra attestation ${field}.sha256 must be lowercase SHA-256`);
    }
  }
  return value;
}

function validateRelease(release, attestation, clusterIds, scope) {
  plainObject(release, "infra evidence release");
  if (release.schema_version !== 1) throw new Error("infra evidence release schema_version must be 1");
  if (release.topology !== scope.proofScope || release.profile !== scope.profile) {
    throw new Error("infra evidence release profile does not match the proof scope");
  }
  sameSource(release.source, attestation.source, "infra evidence release source");
  if (!Array.isArray(release.clusters) || release.clusters.join("\0") !== clusterIds.join("\0")) {
    throw new Error("infra evidence release clusters must exactly match topology order");
  }
  exactKeys(release.images, RELEASE_IMAGE_KEYS, "infra evidence release images");
  if (Object.values(release.images).some((image) => !IMAGE_DIGEST.test(image))) {
    throw new Error("infra evidence release images must be immutable fiducia-cloud GHCR digests");
  }
  plainObject(release.manifests, "infra evidence release manifests");
  if (
    Object.keys(release.manifests).sort().join("\0") !== [...clusterIds].sort().join("\0")
    || Object.values(release.manifests).some((digest) => !MANIFEST_DIGEST.test(digest))
  ) {
    throw new Error("infra evidence release must hash one manifest per topology cluster");
  }
}

/**
 * Validate the exact Fiducia workload/container contract captured from one
 * cluster. This is shared by the infra-attestation verifier and the strict
 * runner's fresh live observation so neither path can accept an arbitrary pod.
 */
export function validateWorkloadPlacement({
  clusterId,
  visibleNodes,
  workloadPlacement,
  releaseImages,
}) {
  nonempty(clusterId, "workload placement cluster ID");
  plainObject(releaseImages, `${clusterId} release images`);
  exactKeys(releaseImages, RELEASE_IMAGE_KEYS, `${clusterId} release images`);
  if (!Array.isArray(visibleNodes) || visibleNodes.length !== 1) {
    throw new Error(`${clusterId} must expose exactly one attested physical node`);
  }
  const visibleNodeNames = visibleNodes.map((node, index) => {
    plainObject(node, `${clusterId} visible node ${index}`);
    return nonempty(node.name, `${clusterId} visible node ${index} name`);
  });
  if (new Set(visibleNodeNames).size !== visibleNodeNames.length) {
    throw new Error(`${clusterId} visible physical node names must be distinct`);
  }
  if (!Array.isArray(workloadPlacement) || workloadPlacement.length === 0) {
    throw new Error(`${clusterId} infra evidence must include workload placement`);
  }

  const seenPods = new Set();
  const workloadCounts = Object.fromEntries(WORKLOAD_CONTRACTS.map((contract) => [contract.name, 0]));
  for (const [podIndex, pod] of workloadPlacement.entries()) {
    plainObject(pod, `${clusterId} workload ${podIndex}`);
    const podName = nonempty(pod.name, `${clusterId} workload ${podIndex} name`);
    if (seenPods.has(podName)) throw new Error(`${clusterId} repeats workload pod ${podName}`);
    seenPods.add(podName);
    const contract = WORKLOAD_CONTRACTS.find((candidate) => candidate.podName.test(podName));
    if (!contract) throw new Error(`${clusterId} contains unexpected workload pod ${podName}`);
    workloadCounts[contract.name] += 1;

    const nodeName = nonempty(pod.nodeName, `${clusterId} workload ${podName} nodeName`);
    if (!visibleNodeNames.includes(nodeName)) {
      throw new Error(`${clusterId} workload ${podName} is placed outside its attested visible node`);
    }
    if (!Array.isArray(pod.images)) {
      throw new Error(`${clusterId} workload ${podName} images must be an array`);
    }
    const expectedContainers = Object.keys(contract.containers).sort();
    const byContainer = new Map();
    for (const [imageIndex, image] of pod.images.entries()) {
      plainObject(image, `${clusterId} workload ${podName} image ${imageIndex}`);
      const container = nonempty(
        image.name,
        `${clusterId} workload ${podName} image ${imageIndex} container`,
      );
      if (byContainer.has(container)) {
        throw new Error(`${clusterId} workload ${podName} repeats container ${container}`);
      }
      byContainer.set(container, image);
    }
    if ([...byContainer.keys()].sort().join("\0") !== expectedContainers.join("\0")) {
      throw new Error(
        `${clusterId} workload ${podName} must contain exactly containers: ${expectedContainers.join(", ")}`,
      );
    }
    for (const [container, releaseKey] of Object.entries(contract.containers)) {
      const image = byContainer.get(container);
      if (image.image !== releaseImages[releaseKey]) {
        throw new Error(
          `${clusterId} workload ${podName}/${container} does not match release image ${releaseKey}`,
        );
      }
      if (image.ready !== true) {
        throw new Error(`${clusterId} workload ${podName}/${container} is not ready`);
      }
      if (typeof image.imageID !== "string" || !RUNTIME_IMAGE_ID.test(image.imageID)) {
        throw new Error(`${clusterId} workload ${podName}/${container} lacks a resolved runtime image ID`);
      }
    }
  }

  for (const [workload, count] of Object.entries(workloadCounts)) {
    if (count === 0) throw new Error(`${clusterId} is missing required workload ${workload}`);
  }
  return { visibleNodeNames, workloadCounts };
}

function validateInfraEvidence(value, attestation, topology) {
  plainObject(value, "infra evidence");
  if (value.schema_version !== 1) throw new Error("infra evidence schema_version must be 1");
  if (value.proof_scope !== attestation.proof_scope) {
    throw new Error("infra evidence proof_scope does not match its attestation");
  }
  if (value.release_id !== attestation.release_id) {
    throw new Error("infra evidence release_id does not match its attestation");
  }
  sameSource(value.source, attestation.source, "infra evidence source");
  const scope = SCOPES[topology.isolationMode];
  if (!scope || scope.proofScope !== attestation.proof_scope) {
    throw new Error("attested proof_scope does not match topology isolationMode");
  }
  if (topology.clusters.some((cluster) => cluster.kubernetesDistribution !== scope.distribution)) {
    throw new Error("topology Kubernetes distributions do not match the attested proof scope");
  }
  const clusterIds = topology.clusters.map((cluster) => cluster.clusterId);
  validateRelease(value.release, attestation, clusterIds, scope);
  if (!Array.isArray(value.clusters) || value.clusters.length !== 3) {
    throw new Error("infra evidence must contain exactly three cluster observations");
  }
  const byId = new Map(value.clusters.map((cluster) => [cluster?.cluster, cluster]));
  if (byId.size !== 3 || clusterIds.some((clusterId) => !byId.has(clusterId))) {
    throw new Error("infra evidence clusters must exactly match the topology");
  }

  const providerIdsByCluster = {};
  const workloadPlacementByCluster = {};
  for (const cluster of topology.clusters) {
    const observed = byId.get(cluster.clusterId);
    if (!cluster.expectedKubernetesClusterUid) {
      throw new Error(`${cluster.clusterId} topology must pin expectedKubernetesClusterUid`);
    }
    if (observed.kubernetes_cluster_uid !== cluster.expectedKubernetesClusterUid) {
      throw new Error(`${cluster.clusterId} infra evidence Kubernetes UID does not match topology`);
    }
    if (!Array.isArray(observed.visible_nodes) || observed.visible_nodes.length !== 1) {
      throw new Error(`${cluster.clusterId} infra evidence must include exactly one visible physical node`);
    }
    const providerIds = observed.visible_nodes.map((node, index) => {
      plainObject(node, `${cluster.clusterId} visible node ${index}`);
      nonempty(node.name, `${cluster.clusterId} visible node ${index} name`);
      nonempty(node.uid, `${cluster.clusterId} visible node ${index} UID`);
      if (!HCLOUD_PROVIDER_ID.test(node.providerID)) {
        throw new Error(`${cluster.clusterId} visible node ${index} is not backed by Hetzner Cloud`);
      }
      return node.providerID;
    });
    if (new Set(providerIds).size !== providerIds.length) {
      throw new Error(`${cluster.clusterId} infra evidence repeats a physical provider ID`);
    }
    workloadPlacementByCluster[cluster.clusterId] = validateWorkloadPlacement({
      clusterId: cluster.clusterId,
      visibleNodes: observed.visible_nodes,
      workloadPlacement: observed.workload_placement,
      releaseImages: value.release.images,
    });
    if (observed.topology?.FIDUCIA_CLUSTER !== cluster.clusterId) {
      throw new Error(`${cluster.clusterId} deployed topology identity does not match`);
    }
    providerIdsByCluster[cluster.clusterId] = providerIds;
  }

  const ownership = new Map();
  for (const [clusterId, providerIds] of Object.entries(providerIdsByCluster)) {
    for (const providerId of providerIds) {
      if (ownership.has(providerId)) {
        throw new Error(
          `physical provider ID ${providerId} is shared by ${ownership.get(providerId)} and ${clusterId}`,
        );
      }
      ownership.set(providerId, clusterId);
    }
  }
  return { scope, providerIdsByCluster, workloadPlacementByCluster };
}

/** Verify exact bytes and semantic links across an infra-generated proof bundle. */
export function verifyInfraProofBundle({ attestationBytes, topologyBytes, infraEvidenceBytes, env = process.env }) {
  const attestation = validateAttestation(parseJson(
    attestationBytes,
    "infra attestation",
    MAX_ATTESTATION_BYTES,
  ));
  const topologyHash = sha256(topologyBytes);
  const evidenceHash = sha256(infraEvidenceBytes);
  if (topologyHash !== attestation.topology.sha256) {
    throw new Error("proof topology SHA-256 does not match its infra attestation");
  }
  if (evidenceHash !== attestation.infra_evidence.sha256) {
    throw new Error("infra evidence SHA-256 does not match its attestation");
  }
  const topology = validateProofTopology(
    parseJson(topologyBytes, "proof topology", MAX_TOPOLOGY_BYTES),
    { env: { ...env, FIDUCIA_E2E_STRICT_PROOF: "1" } },
  );
  const infraEvidence = parseJson(
    infraEvidenceBytes,
    "infra evidence",
    MAX_INFRA_EVIDENCE_BYTES,
  );
  const providerPlacement = validateInfraEvidence(infraEvidence, attestation, topology);
  return {
    attestation,
    topology,
    infraEvidence,
    providerPlacement,
    hashes: {
      attestationSha256: sha256(attestationBytes),
      topologySha256: topologyHash,
      infraEvidenceSha256: evidenceHash,
    },
  };
}

function boundedFile(path, label, maxBytes) {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  if (stat.size > maxBytes) throw new Error(`${label} exceeds its bounded size limit`);
  return readFileSync(path);
}

/** Load only an attestation and its two exact sibling inputs. */
export function loadVerifiedInfraProof({ attestationFile, topologyFile, env = process.env }) {
  const attestationPath = realpathSync(nonempty(attestationFile, "infra attestation file"));
  const base = dirname(attestationPath);
  const expectedTopologyPath = realpathSync(join(base, "proof-topology.json"));
  const evidencePath = realpathSync(join(base, "infra-evidence.json"));
  const configuredTopologyPath = realpathSync(nonempty(topologyFile, "proof topology file"));
  if (configuredTopologyPath !== expectedTopologyPath) {
    throw new Error("FIDUCIA_E2E_TOPOLOGY_FILE must be the attestation's sibling proof-topology.json");
  }
  for (const [path, label] of [
    [expectedTopologyPath, "proof topology"],
    [evidencePath, "infra evidence"],
  ]) {
    if (dirname(path) !== base) throw new Error(`${label} must resolve beside its infra attestation`);
  }
  return verifyInfraProofBundle({
    attestationBytes: boundedFile(attestationPath, "infra attestation", MAX_ATTESTATION_BYTES),
    topologyBytes: boundedFile(expectedTopologyPath, "proof topology", MAX_TOPOLOGY_BYTES),
    infraEvidenceBytes: boundedFile(evidencePath, "infra evidence", MAX_INFRA_EVIDENCE_BYTES),
    env,
  });
}
