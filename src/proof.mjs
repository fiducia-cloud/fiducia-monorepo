import { validateWorkloadPlacement } from "./attestation.mjs";

const SENSITIVE_FIELD = /(?:secret|token|password|credential|authorization|cookie|api.?key|private.?key)/i;
const SENSITIVE_ENV = /(?:SECRET|TOKEN|PASSWORD|AUTHORIZATION|COOKIE|API_KEY|PRIVATE_KEY)/i;

function nonempty(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value.trim();
}

function distinct(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be distinct`);
}

/** Assert the configured and live identity dimensions required by a strict proof. */
export function validateProofIdentities(topology, observations) {
  if (!Array.isArray(topology?.clusters) || topology.clusters.length !== 3) {
    throw new Error("strict proof topology must contain exactly 3 clusters");
  }
  if (!Array.isArray(observations) || observations.length !== 3) {
    throw new Error("strict proof must observe exactly 3 clusters");
  }
  const isolationMode = nonempty(topology.isolationMode, "topology isolation mode");
  if (!new Set(["logical", "regional"]).has(isolationMode)) {
    throw new Error("topology isolation mode must be logical or regional");
  }
  const configuredIds = topology.clusters.map((cluster, index) =>
    nonempty(cluster.clusterId, `topology cluster ${index} ID`));
  const regions = topology.clusters.map((cluster, index) =>
    nonempty(cluster.region, `topology cluster ${index} region`));
  const kubeContexts = topology.clusters.map((cluster, index) =>
    nonempty(cluster.kubeContext, `topology cluster ${index} kube context`));
  const observedById = new Map(observations.map((observation, index) => [
    nonempty(observation?.clusterId, `observation ${index} cluster ID`),
    observation,
  ]));
  if (observedById.size !== 3 || configuredIds.some((id) => !observedById.has(id))) {
    throw new Error("observed cluster IDs must exactly match the configured topology");
  }

  const kubernetesClusterUids = [];
  const fiduciaMemberIds = [];
  for (const cluster of topology.clusters) {
    const observation = observedById.get(cluster.clusterId);
    const kubernetesClusterUid = nonempty(
      observation.kubernetesClusterUid,
      `${cluster.clusterId} Kubernetes cluster UID`,
    );
    const fiduciaMemberId = nonempty(
      observation.fiduciaMemberId,
      `${cluster.clusterId} Fiducia member ID`,
    );
    if (
      cluster.expectedKubernetesClusterUid
      && cluster.expectedKubernetesClusterUid !== kubernetesClusterUid
    ) {
      throw new Error(`${cluster.clusterId} Kubernetes cluster UID does not match topology`);
    }
    if (cluster.expectedFiduciaMemberId && cluster.expectedFiduciaMemberId !== fiduciaMemberId) {
      throw new Error(`${cluster.clusterId} Fiducia member ID does not match topology`);
    }
    kubernetesClusterUids.push(kubernetesClusterUid);
    fiduciaMemberIds.push(fiduciaMemberId);
  }

  distinct(configuredIds, "configured cluster IDs");
  distinct(kubeContexts, "configured kube contexts");
  if (isolationMode === "regional") distinct(regions, "configured regions");
  distinct(kubernetesClusterUids, "live Kubernetes cluster UIDs");
  distinct(fiduciaMemberIds, "live Fiducia member IDs");
  return {
    isolationMode,
    clusterIds: configuredIds,
    regions,
    kubeContexts,
    kubernetesClusterUids,
    fiduciaMemberIds,
  };
}

function exactIntegerSet(values, expected, label) {
  if (!Array.isArray(values) || values.some((value) => !Number.isInteger(value))) {
    throw new Error(`${label} must be an integer array`);
  }
  const actual = [...values].sort((a, b) => a - b);
  if (new Set(actual).size !== actual.length || actual.join("\0") !== expected.join("\0")) {
    throw new Error(`${label} must be the complete ${expected.join(",")} set`);
  }
}

/**
 * Require a converged three-member Raft group from three pinned node endpoints.
 * This intentionally goes beyond endpoint reachability: every member must host
 * every shard, agree on term/leader/commit, and the leader must report all
 * three replicas caught up with its two configured peers.
 */
export function validateRaftConvergence(topology, observations) {
  if (!Array.isArray(topology?.clusters) || topology.clusters.length !== 3) {
    throw new Error("Raft proof topology must contain exactly 3 clusters");
  }
  if (!Array.isArray(observations) || observations.length !== 3) {
    throw new Error("Raft proof must observe exactly 3 pinned node endpoints");
  }
  const clusterIds = topology.clusters.map((cluster, index) =>
    nonempty(cluster.clusterId, `topology cluster ${index} ID`));
  const byCluster = new Map(observations.map((observation, index) => [
    nonempty(observation?.clusterId, `Raft observation ${index} cluster ID`),
    observation,
  ]));
  if (byCluster.size !== 3 || clusterIds.some((clusterId) => !byCluster.has(clusterId))) {
    throw new Error("Raft observations must exactly match the proof topology");
  }

  const members = topology.clusters.map((cluster) => {
    const observation = byCluster.get(cluster.clusterId);
    const status = observation?.status;
    if (!status || typeof status !== "object" || status.service !== "fiducia-node") {
      throw new Error(`${cluster.clusterId} pinned node endpoint did not report fiducia-node status`);
    }
    const consensus = status.consensus;
    if (!consensus || typeof consensus !== "object") {
      throw new Error(`${cluster.clusterId} status lacks consensus state`);
    }
    const nodeId = nonempty(consensus.node_id, `${cluster.clusterId} Raft node ID`);
    if (!Array.isArray(consensus.peers) || consensus.peers.length !== 2) {
      throw new Error(`${cluster.clusterId} must configure exactly two Raft peers`);
    }
    const peers = consensus.peers.map((peer, index) =>
      nonempty(peer, `${cluster.clusterId} Raft peer ${index}`));
    distinct(peers, `${cluster.clusterId} Raft peers`);
    const shardCount = consensus.shard_count;
    if (!Number.isInteger(shardCount) || shardCount <= 0) {
      throw new Error(`${cluster.clusterId} must report a positive shard_count`);
    }
    const expectedShardIds = Array.from({ length: shardCount }, (_, shardId) => shardId);
    exactIntegerSet(consensus.hosted_shards, expectedShardIds, `${cluster.clusterId} hosted shards`);
    if (!Array.isArray(consensus.unresponsive_shards) || consensus.unresponsive_shards.length !== 0) {
      throw new Error(`${cluster.clusterId} has unresponsive Raft shards`);
    }
    if (!Array.isArray(consensus.shards) || consensus.shards.length !== shardCount) {
      throw new Error(`${cluster.clusterId} must report every hosted Raft shard`);
    }
    exactIntegerSet(
      consensus.shards.map((shard) => shard?.shard_id),
      expectedShardIds,
      `${cluster.clusterId} status shards`,
    );

    const shards = new Map();
    for (const shard of consensus.shards) {
      const label = `${cluster.clusterId} shard ${shard.shard_id}`;
      if (!shard || typeof shard !== "object") throw new Error(`${label} must be an object`);
      if (!new Set(["leader", "follower"]).has(shard.role)) {
        throw new Error(`${label} is not converged to leader/follower state`);
      }
      if (!Number.isInteger(shard.term) || shard.term <= 0) {
        throw new Error(`${label} must report a positive term`);
      }
      nonempty(shard.leader_id, `${label} leader ID`);
      for (const field of ["commit_index", "last_applied", "last_log_index"]) {
        if (!Number.isInteger(shard[field]) || shard[field] < 0) {
          throw new Error(`${label} ${field} must be a nonnegative integer`);
        }
      }
      if (shard.last_applied !== shard.commit_index) {
        throw new Error(`${label} has unapplied committed entries`);
      }
      if (shard.commit_index > shard.last_log_index) {
        throw new Error(`${label} commit index exceeds its durable log tail`);
      }
      if (shard.storage_healthy !== true) throw new Error(`${label} storage is unhealthy`);
      if (shard.role === "leader") {
        if (shard.has_quorum !== true || shard.healthy_replicas !== 3) {
          throw new Error(`${label} leader does not have all 3 replicas caught up`);
        }
        if (!Array.isArray(shard.replication) || shard.replication.length !== 2) {
          throw new Error(`${label} leader must report exactly two replication peers`);
        }
        const replicatedPeers = shard.replication.map((replica, index) =>
          nonempty(replica?.peer, `${label} replication peer ${index}`));
        if (
          [...replicatedPeers].sort().join("\0") !== [...peers].sort().join("\0")
          || new Set(replicatedPeers).size !== 2
        ) {
          throw new Error(`${label} replication peers do not match configured membership`);
        }
        for (const replica of shard.replication) {
          if (!Number.isInteger(replica.match_index) || replica.match_index < shard.commit_index) {
            throw new Error(`${label} has a replication peer behind the commit index`);
          }
        }
      }
      shards.set(shard.shard_id, shard);
    }
    return { clusterId: cluster.clusterId, nodeId, peers, shardCount, shards };
  });

  distinct(members.map((member) => member.nodeId), "live Raft member IDs");
  const peerFrequency = new Map();
  for (const member of members) {
    for (const peer of member.peers) peerFrequency.set(peer, (peerFrequency.get(peer) ?? 0) + 1);
  }
  if (peerFrequency.size !== 3 || [...peerFrequency.values()].some((count) => count !== 2)) {
    throw new Error("three-member Raft peer lists must form one closed 3-member group");
  }
  distinct(
    members.map((member) => [...member.peers].sort().join("\0")),
    "per-member Raft peer sets",
  );
  const shardCount = members[0].shardCount;
  if (members.some((member) => member.shardCount !== shardCount)) {
    throw new Error("Raft members disagree on shard_count");
  }
  const memberIds = members.map((member) => member.nodeId);
  const shards = [];
  for (let shardId = 0; shardId < shardCount; shardId += 1) {
    const replicas = members.map((member) => ({
      nodeId: member.nodeId,
      shard: member.shards.get(shardId),
    }));
    const leaders = replicas.filter(({ shard }) => shard.role === "leader");
    if (leaders.length !== 1) throw new Error(`shard ${shardId} must have exactly one leader`);
    const agreedLeader = leaders[0].shard.leader_id;
    if (!memberIds.includes(agreedLeader) || leaders[0].nodeId !== agreedLeader) {
      throw new Error(`shard ${shardId} leader ID is not the observed leader member`);
    }
    if (replicas.some(({ shard }) => shard.leader_id !== agreedLeader)) {
      throw new Error(`shard ${shardId} replicas disagree on leader`);
    }
    const terms = new Set(replicas.map(({ shard }) => shard.term));
    if (terms.size !== 1) throw new Error(`shard ${shardId} replicas disagree on term`);
    const commitIndexes = new Set(replicas.map(({ shard }) => shard.commit_index));
    if (commitIndexes.size !== 1) throw new Error(`shard ${shardId} replicas have not converged on commit index`);
    shards.push({
      shardId,
      term: leaders[0].shard.term,
      leaderId: agreedLeader,
      commitIndex: leaders[0].shard.commit_index,
      healthyReplicas: leaders[0].shard.healthy_replicas,
    });
  }
  return {
    memberCount: members.length,
    memberIds,
    shardCount,
    shards,
  };
}

function normalizedNode(node, providerField) {
  return {
    name: node?.name,
    uid: node?.uid,
    providerID: node?.[providerField],
  };
}

function workloadPlacementFromImages(images, clusterId) {
  if (!Array.isArray(images)) throw new Error(`${clusterId} live images must be an array`);
  const pods = new Map();
  for (const image of images) {
    const podName = nonempty(image?.pod, `${clusterId} live image pod`);
    const nodeName = nonempty(image?.nodeName, `${clusterId} live pod ${podName} nodeName`);
    const existing = pods.get(podName);
    if (existing && existing.nodeName !== nodeName) {
      throw new Error(`${clusterId} live pod ${podName} has inconsistent node placement`);
    }
    const pod = existing ?? { name: podName, nodeName, images: [] };
    pod.images.push({
      name: image.container,
      image: image.declaredImage,
      imageID: image.imageDigest,
      ready: image.ready,
    });
    pods.set(podName, pod);
  }
  return [...pods.values()];
}

/** Bind fresh runner observations to the exact attested node and release image contract. */
export function validateLiveDeployments(topology, observations, infraEvidence) {
  if (!Array.isArray(topology?.clusters) || topology.clusters.length !== 3) {
    throw new Error("live deployment proof topology must contain exactly 3 clusters");
  }
  if (!Array.isArray(observations) || observations.length !== 3) {
    throw new Error("live deployment proof must observe exactly 3 clusters");
  }
  const releaseImages = infraEvidence?.release?.images;
  const attestedClusters = new Map((infraEvidence?.clusters ?? []).map((cluster) => [
    cluster?.cluster,
    cluster,
  ]));
  const liveClusters = new Map(observations.map((cluster) => [cluster?.clusterId, cluster]));
  const summaries = {};
  for (const cluster of topology.clusters) {
    const live = liveClusters.get(cluster.clusterId);
    const attested = attestedClusters.get(cluster.clusterId);
    if (!live || !attested) throw new Error(`${cluster.clusterId} lacks live or attested deployment evidence`);
    if (live.physicalNodePlacement?.available !== true) {
      throw new Error(`${cluster.clusterId} live physical node placement is unavailable`);
    }
    const liveNodes = (live.physicalNodePlacement.nodes ?? [])
      .map((node) => normalizedNode(node, "providerId"))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const attestedNodes = (attested.visible_nodes ?? [])
      .map((node) => normalizedNode(node, "providerID"))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (JSON.stringify(liveNodes) !== JSON.stringify(attestedNodes)) {
      throw new Error(`${cluster.clusterId} live physical nodes differ from attested placement`);
    }
    summaries[cluster.clusterId] = validateWorkloadPlacement({
      clusterId: cluster.clusterId,
      visibleNodes: liveNodes,
      workloadPlacement: workloadPlacementFromImages(live.images, cluster.clusterId),
      releaseImages,
    });
  }
  return summaries;
}

/** Recursively redact values under secret-bearing keys before evidence writes. */
export function sanitizeEvidence(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeEvidence(item, seen));
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_FIELD.test(key)) output[key] = "[REDACTED]";
    else if (key === "kubeconfig") output[key] = "[configured local path]";
    else output[key] = sanitizeEvidence(entry, seen);
  }
  return output;
}

export function secretValuesFromEnv(env = process.env) {
  return Object.entries(env)
    .filter(([key, value]) => SENSITIVE_ENV.test(key) && typeof value === "string" && value.length >= 4)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
}

export function redactText(text, secrets) {
  let safe = String(text);
  for (const secret of secrets) safe = safe.split(secret).join("[REDACTED]");
  return safe;
}

export function sanitizedTopology(topology) {
  return sanitizeEvidence(topology);
}
