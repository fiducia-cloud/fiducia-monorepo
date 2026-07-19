import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { clientOptions, endpoints, validateEndpoint } from "./endpoints.mjs";
import { DEFAULT_LOCAL_MOCK_TOPOLOGY } from "./topology.mjs";

describe("endpoint validation", () => {
  it("normalizes a credential-free HTTPS origin", () => {
    assert.equal(validateEndpoint("https://api.example.test/"), "https://api.example.test");
  });

  it("does not echo an invalid endpoint value into diagnostics", () => {
    const sensitiveValue = "not a URL with private material";
    assert.throws(
      () => validateEndpoint(sensitiveValue),
      (error) => !error.message.includes(sensitiveValue),
    );
  });

  it("rejects authority-confusing URL components", () => {
    for (const value of [
      "https://user@api.example.test",
      "https://api.example.test/unexpected/path",
      "https://api.example.test?target=elsewhere",
      "https://api.example.test#fragment",
    ]) {
      assert.throws(() => validateEndpoint(value), /must not contain/);
    }
  });

  it("requires HTTPS except for an explicitly enabled localhost harness", () => {
    assert.throws(() => validateEndpoint("http://api.example.test"), /require HTTPS/);
    assert.throws(() => validateEndpoint("http://127.0.0.1:8090", false), /require HTTPS/);
    assert.equal(validateEndpoint("http://127.0.0.1:8090", true), "http://127.0.0.1:8090");
    assert.equal(validateEndpoint("http://[::1]:8090", true), "http://[::1]:8090");
    assert.throws(() => validateEndpoint("http://api.example.test", true), /require HTTPS/);
  });

  it("applies the localhost policy to every endpoint instead of leaking map indexes", () => {
    const previousEndpoints = process.env.FIDUCIA_E2E_ENDPOINTS;
    const previousAllow = process.env.FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST;
    try {
      process.env.FIDUCIA_E2E_ENDPOINTS =
        "http://127.0.0.1:8103,http://127.0.0.1:8104,http://127.0.0.1:8105";
      process.env.FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST = "1";
      assert.deepEqual(endpoints(), [
        "http://127.0.0.1:8103",
        "http://127.0.0.1:8104",
        "http://127.0.0.1:8105",
      ]);
    } finally {
      if (previousEndpoints === undefined) delete process.env.FIDUCIA_E2E_ENDPOINTS;
      else process.env.FIDUCIA_E2E_ENDPOINTS = previousEndpoints;
      if (previousAllow === undefined) delete process.env.FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST;
      else process.env.FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST = previousAllow;
    }
  });

  it("derives strict endpoints from the validated three-cluster topology", () => {
    const keys = [
      "FIDUCIA_E2E_STRICT_PROOF",
      "FIDUCIA_E2E_TOPOLOGY_JSON",
      "FIDUCIA_E2E_TOPOLOGY_FILE",
      "FIDUCIA_E2E_ENDPOINTS",
      "FIDUCIA_E2E_BASE_URL",
      "FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST",
    ];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      for (const key of keys) delete process.env[key];
      process.env.FIDUCIA_E2E_STRICT_PROOF = "1";
      process.env.FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST = "1";
      const topology = structuredClone(DEFAULT_LOCAL_MOCK_TOPOLOGY);
      topology.provider = "hetzner";
      for (const cluster of topology.clusters) cluster.kubernetesDistribution = "vcluster";
      process.env.FIDUCIA_E2E_TOPOLOGY_JSON = JSON.stringify(topology);
      assert.deepEqual(endpoints(), [
        "http://127.0.0.1:8103",
        "http://127.0.0.1:8104",
        "http://127.0.0.1:8105",
      ]);
      process.env.FIDUCIA_E2E_BASE_URL = "https://ambiguous.example.test";
      assert.throws(() => endpoints(), /must not also configure/);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("injects trusted-edge identity only into its pinned localhost origin", async () => {
    let captured;
    const fetchImpl = async (input, init) => {
      captured = { input, init };
      return new Response("{}", { status: 200 });
    };
    const env = {
      FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST: "1",
      FIDUCIA_E2E_LOCAL_EDGE_SECRET: "test-edge-secret",
      FIDUCIA_E2E_ORG_ID: "test-org",
      FIDUCIA_E2E_SCOPES: "kv:read kv:write",
    };
    const opts = clientOptions("http://127.0.0.1:8103", { env, fetchImpl });

    await opts.fetch("http://127.0.0.1:8103/v1/kv?key=a", {
      headers: { "x-request-id": "req-1" },
    });
    assert.equal(captured.input, "http://127.0.0.1:8103/v1/kv?key=a");
    assert.equal(captured.init.headers.get("x-request-id"), "req-1");
    assert.equal(captured.init.headers.get("x-fiducia-edge-auth"), "test-edge-secret");
    assert.equal(captured.init.headers.get("x-fiducia-org-id"), "test-org");
    assert.equal(captured.init.headers.get("x-fiducia-scopes"), "kv:read kv:write");
    await assert.rejects(
      opts.fetch("http://127.0.0.1:8104/v1/kv?key=a"),
      /outside its endpoint origin/,
    );
  });

  it("refuses the trusted-edge escape hatch outside an explicit localhost harness", () => {
    const baseEnv = {
      FIDUCIA_E2E_LOCAL_EDGE_SECRET: "test-edge-secret",
      FIDUCIA_E2E_ORG_ID: "test-org",
    };
    assert.throws(
      () => clientOptions("https://api.example.test", { env: baseEnv }),
      /restricted to an explicitly enabled localhost harness/,
    );
    assert.throws(
      () => clientOptions("http://127.0.0.1:8103", { env: baseEnv }),
      /require HTTPS/,
    );
  });

  it("refuses ambiguous credentials and missing local identity", () => {
    const localEnv = {
      FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST: "1",
      FIDUCIA_E2E_LOCAL_EDGE_SECRET: "test-edge-secret",
      FIDUCIA_E2E_ORG_ID: "test-org",
    };
    assert.throws(
      () => clientOptions("http://127.0.0.1:8103", {
        env: { ...localEnv, FIDUCIA_E2E_API_KEY: "also-configured" },
      }),
      /either .* or .* not both/,
    );
    assert.throws(
      () => clientOptions("http://127.0.0.1:8103", {
        env: { ...localEnv, FIDUCIA_E2E_ORG_ID: "" },
      }),
      /FIDUCIA_E2E_ORG_ID is required/,
    );
  });

  it("captures internal-hop auth only when no public or trusted-edge credential is selected", () => {
    assert.deepEqual(
      clientOptions("https://node.example.test", {
        env: {
          FIDUCIA_E2E_INTERNAL_SECRET: "internal-only",
          FIDUCIA_E2E_ORG_ID: "test-org",
        },
      }),
      {
        apiKey: undefined,
        internalSecret: "internal-only",
        internalOrgId: "test-org",
      },
    );
    assert.deepEqual(
      clientOptions("https://api.example.test", {
        env: {
          FIDUCIA_E2E_API_KEY: "public-key",
          FIDUCIA_E2E_INTERNAL_SECRET: "must-not-leak",
        },
      }),
      {
        apiKey: "public-key",
        internalSecret: undefined,
        internalOrgId: undefined,
      },
    );
  });
});
