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
      .map(validateEndpoint);
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

/** Build a client for a specific endpoint (defaults to primary()). */
export function makeClient(baseUrl = primary()) {
  if (!baseUrl) throw new Error("no fiducia endpoint configured");
  return new FiduciaClient(baseUrl, { apiKey: apiKey() });
}
