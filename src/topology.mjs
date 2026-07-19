import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isLoopbackHostname, validateEndpoint } from "./origin.mjs";

const MAX_TOPOLOGY_BYTES = 1024 * 1024;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}$/;
const TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "provider",
  "isolationMode",
  "namespace",
  "clusters",
]);
const CLUSTER_FIELDS = new Set([
  "clusterId",
  "region",
  "kubernetesDistribution",
  "kubeContext",
  "kubeconfig",
  "nodeEndpoint",
  "endpoint",
  "expectedKubernetesClusterUid",
  "expectedFiduciaMemberId",
]);
const SECRET_FIELD = /(?:secret|token|password|credential|authorization|cookie|api.?key|private.?key)/i;
const ISOLATION_MODES = new Set(["regional", "logical"]);
const KUBERNETES_DISTRIBUTIONS = new Set(["kind", "k3s", "vcluster"]);
const PROVIDERS = new Set(["hetzner", "local-mock"]);

/**
 * Disposable localhost topology for the explicit Kind emulator. This is never
 * a Hetzner proof input: the operator proof requires an attested topology from
 * fiducia-infra and refuses all defaults.
 */
export const DEFAULT_LOCAL_MOCK_TOPOLOGY = Object.freeze({
  schemaVersion: 1,
  provider: "local-mock",
  isolationMode: "logical",
  namespace: "fiducia",
  clusters: Object.freeze([
    Object.freeze({
      clusterId: "hetzner-fsn1",
      region: "fsn1",
      kubernetesDistribution: "kind",
      kubeContext: "kind-fiducia-hetzner-fsn1",
      nodeEndpoint: "http://127.0.0.1:8100",
      endpoint: "http://127.0.0.1:8103",
    }),
    Object.freeze({
      clusterId: "hetzner-nbg1",
      region: "nbg1",
      kubernetesDistribution: "kind",
      kubeContext: "kind-fiducia-hetzner-nbg1",
      nodeEndpoint: "http://127.0.0.1:8101",
      endpoint: "http://127.0.0.1:8104",
    }),
    Object.freeze({
      clusterId: "hetzner-hel1",
      region: "hel1",
      kubernetesDistribution: "kind",
      kubeContext: "kind-fiducia-hetzner-hel1",
      nodeEndpoint: "http://127.0.0.1:8102",
      endpoint: "http://127.0.0.1:8105",
    }),
  ]),
});

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain JSON object`);
  }
}

function rejectUnknownFields(value, allowed, label) {
  for (const field of Object.keys(value)) {
    if (SECRET_FIELD.test(field)) {
      throw new Error(`${label} must not contain secret-bearing field ${field}`);
    }
    if (!allowed.has(field)) throw new Error(`${label} contains unknown field ${field}`);
  }
}

function requireString(value, label, pattern) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a nonempty string`);
  }
  const normalized = value.trim();
  if (pattern && !pattern.test(normalized)) throw new Error(`${label} has an invalid format`);
  return normalized;
}

function requireEnum(value, choices, label) {
  const normalized = requireString(value, label);
  if (!choices.has(normalized)) {
    throw new Error(`${label} must be one of: ${[...choices].join(", ")}`);
  }
  return normalized.startsWith("~/") ? join(homedir(), normalized.slice(2)) : normalized;
}

function requireLocalPath(value, label) {
  const normalized = requireString(value, label);
  if (normalized.length > 4096 || /[\0\r\n]/.test(normalized)) {
    throw new Error(`${label} must be a bounded single-line local path`);
  }
  if (/^(?:data:|https?:|exec:)/i.test(normalized)) {
    throw new Error(`${label} must be a local path, not inline or remote credential material`);
  }
  if (!/^(?:\/|\.\.?\/|~\/)/.test(normalized)) {
    throw new Error(`${label} must be an absolute or explicitly relative local path`);
  }
  return normalized;
}

function assertDistinct(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be distinct`);
}

/** Validate and normalize a three-cluster topology document. */
export function validateProofTopology(value, { env = process.env } = {}) {
  requirePlainObject(value, "topology");
  rejectUnknownFields(value, TOP_LEVEL_FIELDS, "topology");
  if (value.schemaVersion !== 1) throw new Error("topology.schemaVersion must be 1");
  const provider = requireEnum(value.provider, PROVIDERS, "topology.provider");
  if (env.FIDUCIA_E2E_STRICT_PROOF === "1" && provider !== "hetzner") {
    throw new Error("strict proof topology.provider must be hetzner");
  }
  const isolationMode = requireEnum(
    value.isolationMode,
    ISOLATION_MODES,
    "topology.isolationMode",
  );
  const namespace = requireString(value.namespace, "topology.namespace", DNS_LABEL);
  if (!Array.isArray(value.clusters) || value.clusters.length !== 3) {
    throw new Error("topology.clusters must contain exactly 3 clusters");
  }
  const allowInsecureLocalhost = env.FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST === "1";
  const clusters = value.clusters.map((cluster, index) => {
    const label = `topology.clusters[${index}]`;
    requirePlainObject(cluster, label);
    rejectUnknownFields(cluster, CLUSTER_FIELDS, label);
    const normalized = {
      clusterId: requireString(cluster.clusterId, `${label}.clusterId`, DNS_LABEL),
      region: requireString(cluster.region, `${label}.region`, DNS_LABEL),
      kubernetesDistribution: requireEnum(
        cluster.kubernetesDistribution,
        KUBERNETES_DISTRIBUTIONS,
        `${label}.kubernetesDistribution`,
      ),
      kubeContext: requireString(cluster.kubeContext, `${label}.kubeContext`, CONTEXT),
      nodeEndpoint: validateEndpoint(cluster.nodeEndpoint, allowInsecureLocalhost),
      endpoint: validateEndpoint(cluster.endpoint, allowInsecureLocalhost),
    };
    for (const optional of ["expectedKubernetesClusterUid", "expectedFiduciaMemberId"]) {
      if (cluster[optional] !== undefined) {
        normalized[optional] = requireString(cluster[optional], `${label}.${optional}`);
      }
    }
    if (cluster.kubeconfig !== undefined) {
      normalized.kubeconfig = requireLocalPath(cluster.kubeconfig, `${label}.kubeconfig`);
    }
    return normalized;
  });

  assertDistinct(clusters.map((cluster) => cluster.clusterId), "topology cluster IDs");
  if (isolationMode === "regional") {
    assertDistinct(clusters.map((cluster) => cluster.region), "topology regions");
  }
  assertDistinct(clusters.map((cluster) => cluster.kubeContext), "topology kubectl contexts");
  assertDistinct(clusters.map((cluster) => cluster.nodeEndpoint), "topology node endpoints");
  assertDistinct(clusters.map((cluster) => cluster.endpoint), "topology load-balancer endpoints");

  if (provider === "local-mock") {
    if (isolationMode !== "logical") {
      throw new Error("local-mock topology.isolationMode must be logical");
    }
    if (clusters.some((cluster) => cluster.kubernetesDistribution !== "kind")) {
      throw new Error("local-mock topology may contain only Kind clusters");
    }
    if (clusters.some((cluster) =>
      !isLoopbackHostname(new URL(cluster.nodeEndpoint).hostname)
      || !isLoopbackHostname(new URL(cluster.endpoint).hostname))) {
      throw new Error("local-mock topology endpoints must all be loopback origins");
    }
  } else if (clusters.some((cluster) => cluster.kubernetesDistribution === "kind")) {
    throw new Error("Hetzner proof topology cannot label the local Kind emulator as Hetzner");
  }

  return {
    schemaVersion: 1,
    provider,
    isolationMode,
    namespace,
    clusters,
  };
}

function parseTopology(text, source) {
  if (Buffer.byteLength(text, "utf8") > MAX_TOPOLOGY_BYTES) {
    throw new Error(`${source} exceeds the 1 MiB topology limit`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} must contain valid JSON: ${error.message}`);
  }
}

/**
 * Load a topology from exactly one env source. The only default is the
 * explicitly local-mock Kind emulator; the strict Hetzner proof calls this
 * with `allowDefault: false` and separately verifies infra attestation.
 */
export function loadProofTopology({
  env = process.env,
  allowDefault = true,
  readFile = readFileSync,
} = {}) {
  const inline = env.FIDUCIA_E2E_TOPOLOGY_JSON?.trim();
  const file = env.FIDUCIA_E2E_TOPOLOGY_FILE?.trim();
  if (inline && file) {
    throw new Error("configure either FIDUCIA_E2E_TOPOLOGY_JSON or FIDUCIA_E2E_TOPOLOGY_FILE, not both");
  }
  let value;
  if (inline) value = parseTopology(inline, "FIDUCIA_E2E_TOPOLOGY_JSON");
  else if (file) {
    let text;
    try {
      text = readFile(file, "utf8");
    } catch (error) {
      throw new Error(`cannot read FIDUCIA_E2E_TOPOLOGY_FILE ${file}: ${error.message}`);
    }
    value = parseTopology(text, `FIDUCIA_E2E_TOPOLOGY_FILE ${file}`);
  } else if (allowDefault) value = DEFAULT_LOCAL_MOCK_TOPOLOGY;
  else return null;
  return validateProofTopology(value, { env });
}

export function topologyConfigured(env = process.env) {
  return Boolean(
    env.FIDUCIA_E2E_TOPOLOGY_JSON?.trim()
      || env.FIDUCIA_E2E_TOPOLOGY_FILE?.trim()
      || env.FIDUCIA_E2E_STRICT_PROOF === "1",
  );
}
