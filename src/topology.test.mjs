import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LOCAL_MOCK_TOPOLOGY,
  loadProofTopology,
  validateProofTopology,
} from "./topology.mjs";

const localEnv = { FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST: "1" };

function topology() {
  return JSON.parse(JSON.stringify(DEFAULT_LOCAL_MOCK_TOPOLOGY));
}

function hetznerTopology({ isolationMode = "logical" } = {}) {
  const value = topology();
  value.provider = "hetzner";
  value.isolationMode = isolationMode;
  for (const [index, cluster] of value.clusters.entries()) {
    cluster.kubernetesDistribution = isolationMode === "logical" ? "vcluster" : "k3s";
    cluster.expectedKubernetesClusterUid = `kube-uid-${index}`;
  }
  return value;
}

describe("strict Hetzner proof topology", () => {
  it("defaults only to an explicitly local-mock three-Kind topology", () => {
    const value = loadProofTopology({ env: localEnv });
    assert.equal(value.provider, "local-mock");
    assert.deepEqual(value.clusters.map((cluster) => cluster.clusterId), [
      "hetzner-fsn1",
      "hetzner-nbg1",
      "hetzner-hel1",
    ]);
    assert.equal(value.isolationMode, "logical");
    assert.deepEqual(value.clusters.map((cluster) => cluster.kubernetesDistribution), [
      "kind",
      "kind",
      "kind",
    ]);
    assert.deepEqual(value.clusters.map((cluster) => cluster.nodeEndpoint), [
      "http://127.0.0.1:8100",
      "http://127.0.0.1:8101",
      "http://127.0.0.1:8102",
    ]);
    assert.deepEqual(value.clusters.map((cluster) => cluster.endpoint), [
      "http://127.0.0.1:8103",
      "http://127.0.0.1:8104",
      "http://127.0.0.1:8105",
    ]);
  });

  it("loads either inline JSON or a JSON file, never both", () => {
    const json = JSON.stringify(topology());
    assert.deepEqual(
      loadProofTopology({ env: { ...localEnv, FIDUCIA_E2E_TOPOLOGY_JSON: json } }),
      validateProofTopology(topology(), { env: localEnv }),
    );
    assert.deepEqual(
      loadProofTopology({
        env: { ...localEnv, FIDUCIA_E2E_TOPOLOGY_FILE: "/safe/topology.json" },
        readFile: (path, encoding) => {
          assert.equal(path, "/safe/topology.json");
          assert.equal(encoding, "utf8");
          return json;
        },
      }),
      validateProofTopology(topology(), { env: localEnv }),
    );
    assert.throws(
      () => loadProofTopology({
        env: {
          ...localEnv,
          FIDUCIA_E2E_TOPOLOGY_JSON: json,
          FIDUCIA_E2E_TOPOLOGY_FILE: "/safe/topology.json",
        },
      }),
      /either .* or .* not both/,
    );
  });

  it("requires exactly three distinct Hetzner identities and routes", () => {
    for (const mutate of [
      (value) => value.clusters.pop(),
      (value) => { value.provider = "vultr"; },
      (value) => { value.clusters[1].clusterId = value.clusters[0].clusterId; },
      (value) => { value.isolationMode = "unsupported"; },
      (value) => { value.clusters[1].kubernetesDistribution = "namespace"; },
      (value) => { value.clusters[1].kubeContext = value.clusters[0].kubeContext; },
      (value) => { value.clusters[1].endpoint = value.clusters[0].endpoint; },
      (value) => { value.clusters[1].nodeEndpoint = value.clusters[0].nodeEndpoint; },
    ]) {
      const value = topology();
      mutate(value);
      assert.throws(() => validateProofTopology(value, { env: localEnv }));
    }
  });

  it("allows one physical region only for three logically isolated control planes", () => {
    const logical = hetznerTopology();
    for (const cluster of logical.clusters) {
      cluster.region = "fsn1";
    }
    assert.deepEqual(
      validateProofTopology(logical, { env: localEnv }).clusters.map((cluster) => cluster.region),
      ["fsn1", "fsn1", "fsn1"],
    );

    const regional = hetznerTopology({ isolationMode: "regional" });
    regional.clusters[1].region = regional.clusters[0].region;
    assert.throws(
      () => validateProofTopology(regional, { env: localEnv }),
      /regions must be distinct/,
    );
  });

  it("never accepts the localhost Kind emulator as a Hetzner proof", () => {
    const disguised = topology();
    disguised.provider = "hetzner";
    assert.throws(
      () => validateProofTopology(disguised, { env: localEnv }),
      /cannot label the local Kind emulator as Hetzner/,
    );
    assert.throws(
      () => loadProofTopology({
        env: { ...localEnv, FIDUCIA_E2E_STRICT_PROOF: "1" },
      }),
      /provider must be hetzner/,
    );
  });

  it("rejects credential material, unknown fields, and unsafe transports", () => {
    const secret = topology();
    secret.clusters[0].apiToken = "must-not-be-here";
    assert.throws(() => validateProofTopology(secret, { env: localEnv }), /secret-bearing field/);

    const inlineKubeconfig = topology();
    inlineKubeconfig.clusters[0].kubeconfig = "data:application/yaml;base64,abc";
    assert.throws(() => validateProofTopology(inlineKubeconfig, { env: localEnv }), /local path/);

    const inlineYaml = topology();
    inlineYaml.clusters[0].kubeconfig = "apiVersion: v1 users: credential-material";
    assert.throws(() => validateProofTopology(inlineYaml, { env: localEnv }), /local path/);

    const unknown = topology();
    unknown.clusters[0].cloud = "hetzner";
    assert.throws(() => validateProofTopology(unknown, { env: localEnv }), /unknown field/);

    assert.throws(
      () => validateProofTopology(topology(), { env: {} }),
      /require HTTPS/,
    );
  });

  it("accepts optional expected identities and a non-secret kubeconfig path", () => {
    const value = topology();
    value.clusters[0].expectedKubernetesClusterUid = "uid-fsn1";
    value.clusters[0].expectedFiduciaMemberId = "member-fsn1";
    value.clusters[0].kubeconfig = "/Users/operator/.kube/fiducia-fsn1";
    const normalized = validateProofTopology(value, { env: localEnv });
    assert.equal(normalized.clusters[0].kubeconfig, "/Users/operator/.kube/fiducia-fsn1");

    value.clusters[0].kubeconfig = "~/.kube/fiducia-fsn1";
    assert.match(
      validateProofTopology(value, { env: localEnv }).clusters[0].kubeconfig,
      /\/\.kube\/fiducia-fsn1$/,
    );
  });
});
