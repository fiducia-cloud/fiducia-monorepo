#!/usr/bin/env node

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { loadVerifiedInfraProof } from "../src/attestation.mjs";
import { FiduciaClient } from "../src/client.mjs";
import {
  redactText,
  sanitizeEvidence,
  sanitizedTopology,
  secretValuesFromEnv,
  validateLiveDeployments,
  validateProofIdentities,
  validateRaftConvergence,
} from "../src/proof.mjs";

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

function usage() {
  return "usage: FIDUCIA_E2E_TOPOLOGY_FILE=... FIDUCIA_E2E_INFRA_ATTESTATION_FILE=... npm run proof:hetzner -- [--chaos] [--evidence-dir PATH]";
}

function parseArgs(argv) {
  const options = { chaos: false, evidenceDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--chaos") options.chaos = true;
    else if (arg === "--evidence-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`--evidence-dir requires a path\n${usage()}`);
      options.evidenceDir = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else throw new Error(`unknown argument ${arg}\n${usage()}`);
  }
  return options;
}

function connectionArgs(cluster) {
  return [
    ...(cluster.kubeconfig ? ["--kubeconfig", cluster.kubeconfig] : []),
    "--context",
    cluster.kubeContext,
  ];
}

async function kubectlJson(cluster, args, { namespace = false } = {}) {
  const scoped = namespace ? ["--namespace", proofTopology.namespace] : [];
  const { stdout } = await execFileAsync(
    process.env.FIDUCIA_E2E_KUBECTL || "kubectl",
    [...connectionArgs(cluster), ...scoped, ...args, "--output", "json"],
    { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

async function kubectlText(cluster, args) {
  const { stdout } = await execFileAsync(
    process.env.FIDUCIA_E2E_KUBECTL || "kubectl",
    [...connectionArgs(cluster), ...args],
    { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout.trim();
}

function safeApiServer(value, clusterId) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${clusterId} kube context did not expose a valid API server URL`);
  }
  if (
    !["https:", "http:"].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error(`${clusterId} Kubernetes API server URL contains unsafe components`);
  }
  return url.href.replace(/\/$/, "");
}

const PLACEMENT_LABELS = [
  "kubernetes.io/hostname",
  "topology.kubernetes.io/region",
  "topology.kubernetes.io/zone",
  "node.kubernetes.io/instance-type",
  "beta.kubernetes.io/instance-type",
];

function nodePlacements(nodes) {
  return (nodes?.items ?? []).map((node) => ({
    name: node.metadata?.name,
    uid: node.metadata?.uid,
    providerId: node.spec?.providerID ?? null,
    labels: Object.fromEntries(PLACEMENT_LABELS
      .filter((key) => node.metadata?.labels?.[key] !== undefined)
      .map((key) => [key, node.metadata.labels[key]])),
  })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function collectNodePlacement(cluster) {
  return {
    available: true,
    nodes: nodePlacements(await kubectlJson(cluster, ["get", "nodes"])),
  };
}

function podImages(pods) {
  const records = [];
  for (const pod of pods?.items ?? []) {
    const statusByName = new Map((pod.status?.containerStatuses ?? [])
      .map((status) => [status.name, status]));
    for (const container of pod.spec?.containers ?? []) {
      const status = statusByName.get(container.name);
      records.push({
        pod: pod.metadata?.name,
        nodeName: pod.spec?.nodeName ?? null,
        container: container.name,
        declaredImage: container.image,
        imageDigest: status?.imageID ?? null,
        ready: status?.ready === true,
        restartCount: status?.restartCount ?? 0,
      });
    }
  }
  return records.sort((a, b) => `${a.pod}/${a.container}`.localeCompare(`${b.pod}/${b.container}`));
}

async function gitEvidence() {
  const [{ stdout: sha }, { stdout: dirty }, { stdout: commitDate }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root }),
    execFileAsync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root }),
    execFileAsync("git", ["show", "-s", "--format=%cI", "HEAD"], { cwd: root }),
  ]);
  if (dirty.trim()) {
    throw new Error("strict proof refuses a dirty fiducia-e2e worktree; commit the reviewed proof source first");
  }
  return { sha: sha.trim(), commitDate: commitDate.trim(), clean: true };
}

function pinnedNodeClient(cluster) {
  const internalSecret = process.env.FIDUCIA_E2E_INTERNAL_SECRET
    || process.env.FIDUCIA_E2E_LOCAL_EDGE_SECRET;
  if (!internalSecret) {
    throw new Error(
      "strict Raft proof requires FIDUCIA_E2E_INTERNAL_SECRET (or the localhost-only local-edge secret)",
    );
  }
  return new FiduciaClient(cluster.nodeEndpoint, {
    internalSecret,
    internalOrgId: process.env.FIDUCIA_E2E_ORG_ID,
  });
}

async function collectCluster(cluster) {
  const [namespace, version, placement, pods, apiServer, status] = await Promise.all([
    kubectlJson(cluster, ["get", "namespace", "kube-system"]),
    kubectlJson(cluster, ["version"]),
    collectNodePlacement(cluster),
    kubectlJson(cluster, ["get", "pods"], { namespace: true }),
    kubectlText(cluster, [
      "config",
      "view",
      "--minify",
      "--output",
      "jsonpath={.clusters[0].cluster.server}",
    ]),
    pinnedNodeClient(cluster).status(),
  ]);
  const kubernetesClusterUid = namespace?.metadata?.uid;
  const fiduciaMemberId = status?.consensus?.node_id;
  const images = podImages(pods);
  if (images.length === 0) throw new Error(`${cluster.clusterId} has no pods in ${proofTopology.namespace}`);
  return {
    clusterId: cluster.clusterId,
    region: cluster.region,
    endpoint: cluster.endpoint,
    kubeContext: cluster.kubeContext,
    kubernetesDistribution: cluster.kubernetesDistribution,
    kubernetesApiServer: safeApiServer(apiServer, cluster.clusterId),
    kubernetesClusterUid,
    fiduciaMemberId,
    kubernetesVersion: version?.serverVersion ?? null,
    physicalNodePlacement: placement,
    images,
    status,
  };
}

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function waitForRaftConvergence(topology, clusters) {
  const timeoutMs = Number(process.env.FIDUCIA_E2E_RAFT_CONVERGENCE_TIMEOUT_MS || 60_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new Error("FIDUCIA_E2E_RAFT_CONVERGENCE_TIMEOUT_MS must be an integer from 1000 to 600000");
  }
  const deadline = Date.now() + timeoutMs;
  let observations = clusters.map((cluster) => ({
    clusterId: cluster.clusterId,
    status: cluster.status,
  }));
  let lastError;
  while (Date.now() <= deadline) {
    try {
      return {
        observations,
        summary: validateRaftConvergence(topology, observations),
      };
    } catch (error) {
      lastError = error;
    }
    await sleep(1_000);
    try {
      observations = await Promise.all(topology.clusters.map(async (cluster) => ({
        clusterId: cluster.clusterId,
        status: await pinnedNodeClient(cluster).status(),
      })));
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `three-member Raft group did not converge within ${timeoutMs}ms: ${lastError?.message ?? lastError}`,
  );
}

function runTap(env) {
  const testFiles = [
    "tests/proof/identity.test.mjs",
    "tests/smoke.test.mjs",
    "tests/conformance/locks.test.mjs",
    "tests/conformance/leases.test.mjs",
    "tests/conformance/semaphores.test.mjs",
    "tests/chaos/cluster-failure.test.mjs",
  ];
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", ...testFiles], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const append = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) {
        child.kill("SIGTERM");
        rejectPromise(new Error("proof TAP output exceeded 64 MiB"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", append(stdout));
    child.stderr.on("data", append(stderr));
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function writeSafeJson(path, value, secrets) {
  const json = `${JSON.stringify(sanitizeEvidence(value), null, 2)}\n`;
  await writeFile(path, redactText(json, secrets), { mode: 0o600 });
}

const options = parseArgs(process.argv.slice(2));
if (process.env.FIDUCIA_E2E_ENDPOINTS?.trim() || process.env.FIDUCIA_E2E_BASE_URL?.trim()) {
  throw new Error("strict proof uses the infra-attested topology file, not legacy endpoint variables");
}
if (process.env.FIDUCIA_E2E_TOPOLOGY_JSON?.trim()) {
  throw new Error("strict Hetzner proof requires the infra-generated FIDUCIA_E2E_TOPOLOGY_FILE, not inline JSON");
}
const topologyFile = process.env.FIDUCIA_E2E_TOPOLOGY_FILE?.trim();
const attestationFile = process.env.FIDUCIA_E2E_INFRA_ATTESTATION_FILE?.trim();
if (!topologyFile || !attestationFile) {
  throw new Error(
    "strict Hetzner proof requires explicit FIDUCIA_E2E_TOPOLOGY_FILE and FIDUCIA_E2E_INFRA_ATTESTATION_FILE inputs from fiducia-infra",
  );
}
if (options.chaos && process.env.FIDUCIA_E2E_ALLOW_DISRUPTIVE !== "1") {
  throw new Error("--chaos also requires FIDUCIA_E2E_ALLOW_DISRUPTIVE=1");
}

const verifiedInfra = loadVerifiedInfraProof({ topologyFile, attestationFile });
const proofTopology = verifiedInfra.topology;
const normalizedTopologyJson = JSON.stringify(proofTopology);
process.env.FIDUCIA_E2E_STRICT_PROOF = "1";
process.env.FIDUCIA_E2E_TOPOLOGY_JSON = normalizedTopologyJson;
delete process.env.FIDUCIA_E2E_TOPOLOGY_FILE;

const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[:.]/g, "-");
const evidenceDir = resolve(options.evidenceDir ?? join(root, "evidence", `hetzner-${stamp}`));
const secrets = secretValuesFromEnv(process.env);
let manifest = {
  schemaVersion: 1,
  proof: "fiducia-locks-leases-three-hetzner-clusters",
  startedAt,
  chaosEnabled: options.chaos,
  topology: sanitizedTopology(proofTopology),
  topologySha256: verifiedInfra.hashes.topologySha256,
  infrastructure: {
    attestationSha256: verifiedInfra.hashes.attestationSha256,
    infraEvidenceSha256: verifiedInfra.hashes.infraEvidenceSha256,
    provider: verifiedInfra.attestation.provider,
    proofScope: verifiedInfra.attestation.proof_scope,
    releaseId: verifiedInfra.attestation.release_id,
    source: verifiedInfra.attestation.source,
    providerPlacement: verifiedInfra.providerPlacement.providerIdsByCluster,
  },
};

try {
  manifest.source = await gitEvidence();
  await mkdir(join(evidenceDir, "status"), { recursive: true, mode: 0o700 });
  const clusters = await Promise.all(proofTopology.clusters.map(collectCluster));
  const raft = await waitForRaftConvergence(proofTopology, clusters);
  const convergedStatus = new Map(raft.observations.map((observation) => [
    observation.clusterId,
    observation.status,
  ]));
  for (const cluster of clusters) {
    cluster.status = convergedStatus.get(cluster.clusterId);
    cluster.fiduciaMemberId = cluster.status?.consensus?.node_id;
  }
  manifest.identities = validateProofIdentities(proofTopology, clusters);
  manifest.raft = raft.summary;
  manifest.liveWorkloads = validateLiveDeployments(
    proofTopology,
    clusters,
    verifiedInfra.infraEvidence,
  );
  manifest.clusters = clusters.map(({ status, ...cluster }) => sanitizeEvidence(cluster));
  for (const cluster of clusters) {
    await writeSafeJson(
      join(evidenceDir, "status", `${cluster.clusterId}.json`),
      cluster.status,
      secrets,
    );
  }

  const childEnv = {
    ...process.env,
    FIDUCIA_E2E_STRICT_PROOF: "1",
    FIDUCIA_E2E_TOPOLOGY_JSON: normalizedTopologyJson,
    FIDUCIA_E2E_ALLOW_DISRUPTIVE: options.chaos ? "1" : "0",
  };
  delete childEnv.FIDUCIA_E2E_TOPOLOGY_FILE;
  delete childEnv.FIDUCIA_E2E_ENDPOINTS;
  delete childEnv.FIDUCIA_E2E_BASE_URL;
  const tap = await runTap(childEnv);
  const safeTap = redactText(tap.stdout, secrets);
  const safeStderr = redactText(tap.stderr, secrets);
  await writeFile(join(evidenceDir, "proof.tap"), safeTap, { mode: 0o600 });
  if (safeStderr) await writeFile(join(evidenceDir, "proof.stderr.txt"), safeStderr, { mode: 0o600 });
  process.stdout.write(safeTap);
  if (safeStderr) process.stderr.write(safeStderr);
  manifest.tapSha256 = createHash("sha256").update(safeTap).digest("hex");
  manifest.testExitCode = tap.code;
  manifest.testSignal = tap.signal;
  manifest.finishedAt = new Date().toISOString();
  manifest.passed = tap.code === 0;
  await writeSafeJson(join(evidenceDir, "manifest.json"), manifest, secrets);
  process.stderr.write(`sanitized proof evidence: ${evidenceDir}\n`);
  if (tap.code !== 0) process.exitCode = tap.code || 1;
} catch (error) {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  manifest = {
    ...manifest,
    finishedAt: new Date().toISOString(),
    passed: false,
    error: redactText(error?.stack ?? error?.message ?? error, secrets),
  };
  await writeSafeJson(join(evidenceDir, "manifest.json"), manifest, secrets);
  process.stderr.write(`${redactText(error?.stack ?? error, secrets)}\n`);
  process.stderr.write(`sanitized failure evidence: ${evidenceDir}\n`);
  process.exitCode = 1;
}
