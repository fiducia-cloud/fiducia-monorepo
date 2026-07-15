// The real local three-cloud approximation: separate Kind control planes,
// cross-cluster node Raft, cross-cluster brain Raft, and one LB per cluster.

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { FiduciaClient } from "../../src/client.mjs";
import { uniqueKey } from "../helpers.mjs";

const execFileAsync = promisify(execFile);
const ENABLED = process.env.FIDUCIA_E2E_MULTICLUSTER === "1";
const SKIP = ENABLED ? false : "set FIDUCIA_E2E_MULTICLUSTER=1 (or run npm run test:multicluster)";
const INTERNAL_SECRET = process.env.FIDUCIA_E2E_INTERNAL_SECRET
  || "emulation-internal-secret-do-not-use-in-prod";
const ORG = process.env.FIDUCIA_E2E_ORG_ID || "emulation-org";
const REPOS_ROOT = process.env.FIDUCIA_REPOS_ROOT
  || fileURLToPath(new URL("../../../", import.meta.url));
const PARTITION = join(REPOS_ROOT, "fiducia-infra", "kind", "multicluster", "partition.sh");

const clusters = [
  { name: "hetzner", context: "kind-fiducia-hetzner", nodeUrl: "http://127.0.0.1:8090", lbUrl: "http://127.0.0.1:8093" },
  { name: "vultr", context: "kind-fiducia-vultr", nodeUrl: "http://127.0.0.1:8091", lbUrl: "http://127.0.0.1:8094" },
  { name: "civo", context: "kind-fiducia-civo", nodeUrl: "http://127.0.0.1:8092", lbUrl: "http://127.0.0.1:8095" },
];

async function eventually(fn, { timeoutMs = 90_000, intervalMs = 1_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await delay(intervalMs);
    }
  }
  throw new Error(`timed out waiting for ${label}: ${lastError?.message ?? lastError}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const { port } = server.address();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

async function startForward(cluster, resource, remotePort, label) {
  const port = await freePort();
  let logs = "";
  const child = spawn(
    process.env.FIDUCIA_E2E_KUBECTL || "kubectl",
    ["--context", cluster.context, "--namespace", "fiducia", "port-forward", resource, `${port}:${remotePort}`],
    { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] },
  );
  const append = (chunk) => { logs = (logs + String(chunk)).slice(-8192); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolvePromise) => child.once("exit", resolvePromise)),
      delay(3_000),
    ]);
  };
  try {
    await eventually(async () => {
      if (child.exitCode !== null) throw new Error(`port-forward exited ${child.exitCode}: ${logs}`);
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) });
      assert.equal(response.status, 200);
    }, { timeoutMs: 20_000, intervalMs: 200, label: `${cluster.name} ${label} port-forward` });
    return { url: `http://127.0.0.1:${port}`, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function startBrainForward(cluster) {
  return startForward(cluster, "service/fiducia-brain-peer-ext", 9095, "brain");
}

async function startSidecarForward(cluster, pod) {
  return startForward(cluster, `pod/${pod}`, 8091, `${pod} sidecar`);
}

async function nodeStatuses() {
  return Promise.all(clusters.map(async (cluster) => {
    const response = await fetch(`${cluster.nodeUrl}/v1/status`, {
      headers: { "x-fiducia-internal-auth": INTERNAL_SECRET },
      signal: AbortSignal.timeout(5_000),
    });
    assert.ok(response.ok, `${cluster.name} node status HTTP ${response.status}`);
    return response.json();
  }));
}

function edgeClient(cluster) {
  const edgeFetch = (url, init = {}) => fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      "x-fiducia-edge-auth": INTERNAL_SECRET,
      "x-fiducia-org-id": ORG,
      "x-fiducia-scopes": "*",
    },
  });
  return new FiduciaClient(cluster.lbUrl, { fetch: edgeFetch });
}

function leadersByShard(statuses) {
  const leaders = new Map();
  for (const status of statuses) {
    for (const shard of status.consensus.shards) {
      if (shard.role === "leader") {
        leaders.set(shard.shard_id, [...(leaders.get(shard.shard_id) ?? []), status.consensus.node_id]);
      }
    }
  }
  return leaders;
}

describe("Kind x3: cross-cluster node + brain Raft", { skip: SKIP, concurrency: 1 }, () => {
  const brainForwards = [];

  before(async () => {
    for (const cluster of clusters) brainForwards.push(await startBrainForward(cluster));
  }, { timeout: 90_000 });

  after(async () => {
    await Promise.all(brainForwards.map((forward) => forward.stop()));
  });

  it("elects exactly one healthy node leader per shard and all replicas agree", async () => {
    await eventually(async () => {
      const statuses = await nodeStatuses();
      const shardCount = statuses[0].consensus.shard_count;
      const leaders = leadersByShard(statuses);
      assert.equal(leaders.size, shardCount, "every shard has a leader");
      for (let shardId = 0; shardId < shardCount; shardId += 1) {
        assert.equal(leaders.get(shardId)?.length, 1, `shard ${shardId} has exactly one leader`);
        const replicas = statuses.map((status) => status.consensus.shards.find((shard) => shard.shard_id === shardId));
        assert.equal(new Set(replicas.map((shard) => shard.leader_id)).size, 1, `shard ${shardId} leader agreement`);
        assert.ok(replicas.find((shard) => shard.role === "leader")?.healthy_replicas >= 2, `shard ${shardId} holds quorum`);
      }
    }, { label: "node Raft convergence" });
  });

  it("elects one brain leader and replicates placement generation to all three brains", async () => {
    await eventually(async () => {
      const statuses = await Promise.all(brainForwards.map(async (forward) => {
        const response = await fetch(`${forward.url}/forward/v1/status`, {
          headers: { "x-fiducia-internal-auth": INTERNAL_SECRET },
          signal: AbortSignal.timeout(3_000),
        });
        assert.ok(response.ok, `brain status HTTP ${response.status}`);
        return response.json();
      }));
      assert.equal(statuses.filter((status) => status.brain_cluster.is_leader).length, 1, "one brain leader");
      assert.ok(statuses.every((status) => status.brain_cluster.available), "every brain member is available");
      assert.ok(statuses.every((status) => status.brain_cluster.configured_members === 3), "brain RF is three");
      assert.equal(new Set(statuses.map((status) => status.brain_cluster.placement_generation)).size, 1, "placement generations converge");
      assert.equal(new Set(statuses.map((status) => status.placement.placed_shards)).size, 1, "placement cardinality converges");
    }, { label: "brain Raft convergence" });
  });

  it("serves linearizable writes through every LB and reads them through another cluster", async () => {
    const clients = clusters.map(edgeClient);
    for (let index = 0; index < clients.length; index += 1) {
      const key = uniqueKey(`kind-x3-lb-${clusters[index].name}`);
      const value = `value-from-${clusters[index].name}`;
      const write = await clients[index].kvPut(key, value);
      assert.equal(write?.committed, true, `${clusters[index].name} LB commits the write`);
      const read = await clients[(index + 1) % clients.length].kvGet(key);
      assert.equal(read?.entry?.value, value, "another cluster observes the committed value");
    }
  });

  it("runs node and brain consensus without a NATS dependency in their pod specs", async () => {
    for (const cluster of clusters) {
      const { stdout } = await execFileAsync(
        process.env.FIDUCIA_E2E_KUBECTL || "kubectl",
        ["--context", cluster.context, "--namespace", "fiducia", "get", "statefulset", "fiducia-node", "fiducia-brain", "--output", "json"],
        { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      );
      const workloads = JSON.parse(stdout).items;
      for (const workload of workloads) {
        const envNames = workload.spec.template.spec.containers.flatMap((container) => (container.env ?? []).map((entry) => entry.name));
        assert.equal(envNames.some((name) => name.startsWith("NATS_")), false, `${workload.metadata.name} must not require NATS`);
        assert.equal(workload.spec.template.spec.containers.some((container) => /nats/i.test(container.name)), false, `${workload.metadata.name} has no NATS sidecar`);
      }
    }
    assert.equal(leadersByShard(await nodeStatuses()).size > 0, true, "Raft remains live with that NATS-free deployment");
  });

  it("uses one sidecar image with role-specific node and brain profiles", async () => {
    for (const cluster of clusters) {
      const { stdout } = await execFileAsync(
        process.env.FIDUCIA_E2E_KUBECTL || "kubectl",
        ["--context", cluster.context, "--namespace", "fiducia", "get", "statefulset", "fiducia-node", "fiducia-brain", "--output", "json"],
        { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      );
      const workloads = Object.fromEntries(
        JSON.parse(stdout).items.map((workload) => [workload.metadata.name, workload]),
      );
      const nodeSidecar = workloads["fiducia-node"].spec.template.spec.containers
        .find((container) => container.name === "sidecar");
      const brainSidecar = workloads["fiducia-brain"].spec.template.spec.containers
        .find((container) => container.name === "sidecar");
      assert.ok(nodeSidecar, `${cluster.name} node has the shared sidecar`);
      assert.ok(brainSidecar, `${cluster.name} brain has the shared sidecar`);
      assert.equal(nodeSidecar.image, brainSidecar.image, "node and brain use one operational image");

      const env = (container) => Object.fromEntries(
        (container.env ?? []).filter((entry) => "value" in entry).map((entry) => [entry.name, entry.value]),
      );
      assert.deepEqual(
        [env(nodeSidecar).FIDUCIA_EXPORT_TARGET, env(nodeSidecar).FIDUCIA_SIDECAR_ROLE],
        ["node", "full"],
      );
      assert.deepEqual(
        [env(brainSidecar).FIDUCIA_EXPORT_TARGET, env(brainSidecar).FIDUCIA_SIDECAR_ROLE],
        ["brain", "exporter"],
      );
      assert.ok(
        nodeSidecar.ports?.some((port) => port.name === "sidecar" && port.containerPort === 8091),
        "node profile exposes the shared metrics endpoint",
      );
      assert.ok(
        brainSidecar.ports?.some((port) => port.name === "sidecar" && port.containerPort === 8091),
        "brain profile exposes the shared metrics endpoint",
      );
    }
  });

  it("serves healthy role-specific metrics from every node and brain sidecar", { timeout: 90_000 }, async () => {
    const profiles = [
      {
        pod: "fiducia-node-0",
        target: "node",
        families: ["fiducia_node_up", "fiducia_raft_term"],
        heartbeats: true,
      },
      {
        pod: "fiducia-brain-0",
        target: "brain",
        families: ["fiducia_brain_up", "fiducia_placement_generation"],
        heartbeats: false,
      },
    ];

    for (const cluster of clusters) {
      for (const profile of profiles) {
        const forward = await startSidecarForward(cluster, profile.pod);
        try {
          const response = await fetch(`${forward.url}/metrics`, { signal: AbortSignal.timeout(5_000) });
          assert.equal(response.status, 200, `${cluster.name} ${profile.target} metrics HTTP 200`);
          const body = await response.text();
          assert.match(body, /^fiducia_sidecar_up 1$/m, `${cluster.name} ${profile.target} sidecar is up`);
          assert.match(
            body,
            new RegExp(`^fiducia_sidecar_scrape_up\\{[^\\n]*target="${profile.target}"[^\\n]*\\} 1$`, "m"),
            `${cluster.name} ${profile.target} upstream scrape is healthy`,
          );
          for (const family of profile.families) {
            assert.match(body, new RegExp(`^${family}(?:\\{| )`, "m"), `${cluster.name} exports ${family}`);
          }

          const attempts = Number(body.match(/^fiducia_sidecar_heartbeat_attempts_total (\d+)$/m)?.[1]);
          const successes = Number(body.match(/^fiducia_sidecar_heartbeat_successes_total (\d+)$/m)?.[1]);
          if (profile.heartbeats) {
            assert.ok(attempts > 0, `${cluster.name} node sidecar attempted heartbeats`);
            assert.ok(successes > 0, `${cluster.name} node sidecar completed heartbeats`);
          } else {
            assert.equal(attempts, 0, `${cluster.name} brain exporter does not register a fake node`);
            assert.equal(successes, 0, `${cluster.name} brain exporter does not send heartbeats`);
          }
        } finally {
          await forward.stop();
        }
      }
    }
  });

  it("refuses commits in a 1-1-1 split and converges after healing (disruptive; gated)", {
    skip: process.env.FIDUCIA_E2E_ALLOW_DISRUPTIVE !== "1",
    timeout: 180_000,
  }, async () => {
    await execFileAsync(PARTITION, ["split-brain"], { timeout: 30_000 });
    try {
      await eventually(async () => {
        const statuses = await nodeStatuses();
        const quorumLeaders = statuses.flatMap((status) => status.consensus.shards)
          .filter((shard) => shard.role === "leader" && shard.has_quorum);
        assert.equal(quorumLeaders.length, 0, "no minority may retain write authority");
      }, { timeoutMs: 45_000, label: "check-quorum step-down" });

      const attempts = await Promise.allSettled(
        clusters.map((cluster, index) => edgeClient(cluster).kvPut(uniqueKey(`split-${index}`), "must-not-commit")),
      );
      assert.equal(
        attempts.some((attempt) => attempt.status === "fulfilled" && attempt.value?.committed === true),
        false,
        "no isolated cluster may commit",
      );
    } finally {
      await execFileAsync(PARTITION, ["heal"], { timeout: 30_000 });
    }

    await eventually(async () => {
      const statuses = await nodeStatuses();
      assert.equal(leadersByShard(statuses).size, statuses[0].consensus.shard_count);
    }, { label: "post-partition node convergence" });
    const healed = await edgeClient(clusters[0]).kvPut(uniqueKey("post-heal"), "committed");
    assert.equal(healed?.committed, true, "healed quorum accepts new writes");
  });
});
