// Endpoint resolution for the e2e suite.
//
// Two run modes (see README):
//   (a) multi-cluster: FIDUCIA_E2E_ENDPOINTS = comma-separated LB URLs, e.g.
//       the three lb_endpoint values from fiducia-infra/topology.toml.
//   (b) single-endpoint smoke: FIDUCIA_E2E_BASE_URL.
//
// When NEITHER is set, `endpoints()` returns [] and `primary()` returns null so
// every suite SKIPS cleanly — `npm test` is safe with nothing deployed.

import { FiduciaClient } from "./client.mjs";

/** @returns {string[]} normalized (trailing-slash-stripped) endpoint URLs. */
export function endpoints() {
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

export function validateEndpoint(
  value,
  allowInsecureLocalhost = process.env.FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST === "1",
) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid Fiducia E2E endpoint URL: ${value}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Fiducia E2E endpoints must not contain userinfo, query, or fragment data");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const allowLocalHttp = local && allowInsecureLocalhost;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowLocalHttp)) {
    throw new Error(
      "Fiducia E2E endpoints require HTTPS; set FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST=1 only for a local harness",
    );
  }
  return url.origin;
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
  if (!edgeSecret) return { apiKey: publicApiKey };

  const parsed = new URL(origin);
  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
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
  return new FiduciaClient(origin, clientOptions(origin));
}
