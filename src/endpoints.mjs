// Endpoint resolution for the e2e suite.
//
// Three run modes (see README):
//   (a) strict proof: validated FIDUCIA_E2E_TOPOLOGY_JSON / _FILE.
//   (b) legacy multi-cluster: comma-separated FIDUCIA_E2E_ENDPOINTS.
//   (c) single-endpoint smoke: FIDUCIA_E2E_BASE_URL.
//
// When NEITHER is set, `endpoints()` returns [] and `primary()` returns null so
// every suite SKIPS cleanly — `npm test` is safe with nothing deployed.

import { FiduciaClient } from "./client.mjs";
import { isLoopbackHostname, validateEndpoint } from "./origin.mjs";
import { loadProofTopology, topologyConfigured } from "./topology.mjs";

export { validateEndpoint } from "./origin.mjs";

/** @returns {string[]} normalized (trailing-slash-stripped) endpoint URLs. */
export function endpoints() {
  if (topologyConfigured()) {
    if (process.env.FIDUCIA_E2E_ENDPOINTS?.trim() || process.env.FIDUCIA_E2E_BASE_URL?.trim()) {
      throw new Error(
        "strict/topology runs must not also configure FIDUCIA_E2E_ENDPOINTS or FIDUCIA_E2E_BASE_URL",
      );
    }
    return loadProofTopology({ allowDefault: true }).clusters.map((cluster) => cluster.endpoint);
  }
  const list = process.env.FIDUCIA_E2E_ENDPOINTS;
  if (list && list.trim()) {
    return list
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      // Do not pass validateEndpoint directly: Array#map's numeric index would
      // become its allowInsecureLocalhost argument and silently alter the
      // security policy per endpoint.
      .map((value) => validateEndpoint(value));
  }
  const single = process.env.FIDUCIA_E2E_BASE_URL;
  if (single && single.trim()) return [validateEndpoint(single.trim())];
  return [];
}

/** @returns {string|null} the first configured endpoint, or null to skip. */
export function primary() {
  return endpoints()[0] ?? null;
}

/** @returns {string|undefined} optional Bearer API key from env. */
export function apiKey() {
  return process.env.FIDUCIA_E2E_API_KEY || undefined;
}

/**
 * Build authentication options for a client.
 *
 * Production/staging tests use a public API key. The three-Kind harness has no
 * public identity provider, so it may instead emulate the immediately-upstream
 * trusted edge. That escape hatch is deliberately fail-closed: it requires the
 * insecure-localhost opt-in, refuses non-loopback origins, and pins injected
 * identity headers to the configured endpoint so the shared secret cannot be
 * forwarded to another origin.
 */
export function clientOptions(
  baseUrl,
  { env = process.env, fetchImpl = globalThis.fetch } = {},
) {
  const allowInsecureLocalhost = env.FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST === "1";
  const origin = validateEndpoint(baseUrl, allowInsecureLocalhost);
  const publicApiKey = env.FIDUCIA_E2E_API_KEY || undefined;
  const edgeSecret = env.FIDUCIA_E2E_LOCAL_EDGE_SECRET || undefined;

  if (publicApiKey && edgeSecret) {
    throw new Error(
      "configure either FIDUCIA_E2E_API_KEY or FIDUCIA_E2E_LOCAL_EDGE_SECRET, not both",
    );
  }
  if (!edgeSecret) {
    return {
      apiKey: publicApiKey,
      internalSecret: publicApiKey
        ? undefined
        : env.FIDUCIA_E2E_INTERNAL_SECRET || undefined,
      internalOrgId: publicApiKey ? undefined : env.FIDUCIA_E2E_ORG_ID || undefined,
    };
  }

  const parsed = new URL(origin);
  const local = isLoopbackHostname(parsed.hostname);
  if (!local || !allowInsecureLocalhost) {
    throw new Error(
      "FIDUCIA_E2E_LOCAL_EDGE_SECRET is restricted to an explicitly enabled localhost harness",
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("a fetch implementation is required for local trusted-edge tests");
  }

  const orgId = env.FIDUCIA_E2E_ORG_ID?.trim();
  if (!orgId) {
    throw new Error("FIDUCIA_E2E_ORG_ID is required with FIDUCIA_E2E_LOCAL_EDGE_SECRET");
  }
  const scopes = env.FIDUCIA_E2E_SCOPES?.trim() || "admin:read admin:write";

  return {
    fetch: async (input, init = {}) => {
      const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (target.origin !== origin) {
        throw new Error("refusing to forward local trusted-edge identity outside its endpoint origin");
      }
      const headers = new Headers(init.headers);
      headers.set("x-fiducia-edge-auth", edgeSecret);
      headers.set("x-fiducia-org-id", orgId);
      headers.set("x-fiducia-scopes", scopes);
      return fetchImpl(input, { ...init, headers });
    },
  };
}

/** Build a client for a specific endpoint (defaults to primary()). */
export function makeClient(baseUrl = primary()) {
  if (!baseUrl) throw new Error("no fiducia endpoint configured");
  const origin = validateEndpoint(baseUrl);
  return new FiduciaClient(origin, {
    ...clientOptions(origin),
    failoverEndpoints: endpoints(),
  });
}
