// Shared test helpers. Not a test file (no `.test.mjs` suffix) so the runner
// ignores it. Keeps every conformance spec dependency-light and consistent.

import { HttpError } from "../src/client.mjs";
import { primary } from "../src/endpoints.mjs";

// Deterministic-but-unique keys: pid (stable per run) + a module-level counter.
// Avoids Date.now()/Math.random() flakiness while preventing cross-run key
// collisions when the suite runs repeatedly against a long-lived cluster.
const RUN = process.pid.toString(36);
let seq = 0;
export function uniqueKey(name) {
  seq += 1;
  return `e2e/${name}/${RUN}-${seq}`;
}
export function uniqueId(prefix = "id") {
  seq += 1;
  return `${prefix}-${RUN}-${seq}`;
}

/** Reason string to pass to describe/it `{ skip }` when nothing is deployed. */
export const NO_ENDPOINT = primary()
  ? false
  : "no FIDUCIA_E2E endpoint configured (set FIDUCIA_E2E_BASE_URL or FIDUCIA_E2E_ENDPOINTS)";

/**
 * Run `fn`, but if the endpoint answers 404/501 (primitive route not deployed
 * on this build) mark the test skipped via `t.skip(...)` instead of failing.
 * A WRONG behavioral assertion inside `fn` still throws and FAILS the test.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} label   what primitive/route we were exercising
 * @param {() => Promise<void>} fn
 */
export async function skipIfUndeployed(t, label, fn) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 501)) {
      t.skip(`${label}: route not deployed on this endpoint (HTTP ${err.status})`);
      return;
    }
    throw err;
  }
}

export { HttpError };
