// Shared journeys for the BROWSER-driven chaos and multicluster suites
// (tests/chaos/{selenium,playwright,puppeteer}, tests/multicluster/…).
//
// Unlike tests/browser/ (which boots the composed web-app stack locally),
// these ride the SAME deployed endpoints as their fetch-level siblings —
// endpoints() / the validated proof topology — but prove them through a real
// browser transport: navigation, redirects, and page rendering of the
// health/readiness surfaces. Each framework file supplies one `navigate(url)`
// -> body-text implementation; the journeys and assertions live here so all
// three frameworks certify identical behavior.

import assert from "node:assert/strict";

import { endpoints } from "./endpoints.mjs";
import { loadProofTopology, topologyConfigured } from "./topology.mjs";
import { publicUrlFor } from "./browser.mjs";

/** Endpoint list for browser chaos runs (>= 2 so one can be disrupted). */
export function chaosEndpoints() {
  return endpoints().map((url) => publicUrlFor(url));
}

/** `{ skip }` reason for browser chaos beyond the driver gate, or false. */
export function chaosEndpointSkip() {
  const eps = chaosEndpoints();
  if (eps.length < 2) {
    return `browser chaos needs >= 2 configured endpoints (have ${eps.length}) — set FIDUCIA_E2E_ENDPOINTS or a topology`;
  }
  return false;
}

/** Clusters for browser multicluster runs (from the validated topology). */
export function multiclusterTargets() {
  if (!topologyConfigured()) return [];
  return loadProofTopology({ allowDefault: true }).clusters.map((cluster) => ({
    name: cluster.clusterId,
    region: cluster.region,
    url: publicUrlFor(cluster.endpoint),
  }));
}

/** `{ skip }` reason for browser multicluster beyond the driver gate. */
export function multiclusterSkip() {
  if (process.env.FIDUCIA_E2E_MULTICLUSTER !== "1") {
    return "set FIDUCIA_E2E_MULTICLUSTER=1 (or run npm run test:multicluster:browser)";
  }
  const targets = multiclusterTargets();
  if (targets.length < 2) {
    return `browser multicluster needs a topology with >= 2 clusters (have ${targets.length})`;
  }
  return false;
}

/**
 * Assert one endpoint's /healthz through the browser: the page must serve,
 * render, and contain the health JSON with status "ok".
 * @param {(url: string) => Promise<string>} navigate framework-specific
 *   "load URL, return body text" implementation
 */
export async function assertHealthzInBrowser(navigate, baseUrl, label = baseUrl) {
  const text = await navigate(`${baseUrl.replace(/\/+$/, "")}/healthz`);
  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    assert.fail(`${label}: /healthz body is not JSON through the browser: ${text.slice(0, 120)}`);
  }
  assert.equal(parsed.status, "ok", `${label}: /healthz must report status ok`);
  return parsed;
}

/**
 * The browser chaos journey: every endpoint healthy through the browser; then
 * (only with FIDUCIA_E2E_ALLOW_DISRUPTIVE=1 and a configured topology) disrupt
 * the first cluster, prove the REMAINING endpoints still serve a browser, and
 * heal. The disruption phase reports "skipped" (not silently passing) when
 * the disruptive gate is off.
 */
export async function browserChaosJourney(t, navigate) {
  const eps = chaosEndpoints();
  for (const url of eps) {
    await assertHealthzInBrowser(navigate, url);
  }

  if (process.env.FIDUCIA_E2E_ALLOW_DISRUPTIVE !== "1" || !topologyConfigured()) {
    t.diagnostic(
      "disruption phase skipped: needs FIDUCIA_E2E_ALLOW_DISRUPTIVE=1 and a validated topology",
    );
    return { endpoints: eps.length, disrupted: false };
  }

  const topology = loadProofTopology({ allowDefault: true });
  const victim = topology.clusters[0].clusterId;
  const { disruptCluster, healCluster } = await import("../tests/chaos/kubectl.mjs");
  await disruptCluster(victim);
  try {
    for (const url of eps.slice(1)) {
      await assertHealthzInBrowser(navigate, url, `${url} (while ${victim} is down)`);
    }
  } finally {
    await healCluster(victim);
  }
  // Recovery: the disrupted cluster serves a browser again.
  await assertHealthzInBrowser(navigate, eps[0], `${eps[0]} (after heal)`);
  return { endpoints: eps.length, disrupted: true };
}

/** The browser multicluster journey: every cluster serves a browser. */
export async function browserMulticlusterJourney(navigate) {
  const targets = multiclusterTargets();
  for (const target of targets) {
    await assertHealthzInBrowser(navigate, target.url, `${target.name} (${target.region})`);
  }
  return { clusters: targets.length };
}
