// Shared test helpers. Not a test file (no `.test.mjs` suffix) so the runner
// ignores it. Keeps every conformance spec dependency-light and consistent.

import { HttpError } from "../src/client.mjs";
import { primary } from "../src/endpoints.mjs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

export const STRICT_PROOF = process.env.FIDUCIA_E2E_STRICT_PROOF === "1";

// One explicit high-entropy run namespace. PIDs repeat across CI containers and
// must not be used to address durable state in a long-lived cluster.
const configuredRun = process.env.FIDUCIA_E2E_RUN_ID
  || [process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT].filter(Boolean).join("-")
  || randomUUID();
const RUN = configuredRun.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 96) || randomUUID();
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
 * A capability-specific promotion gate may pass `{ strict: true }` without
 * impersonating the topology/attestation proof runner's private strict switch.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} label   what primitive/route we were exercising
 * @param {() => Promise<void>} fn
 * @param {{strict?: boolean}} options
 */
export async function skipIfUndeployed(t, label, fn, { strict = STRICT_PROOF } = {}) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 501)) {
      if (strict) {
        throw new Error(`${label}: strict proof requires this route (HTTP ${err.status})`, {
          cause: err,
        });
      }
      t.skip(`${label}: route not deployed on this endpoint (HTTP ${err.status})`);
      return;
    }
    throw err;
  }
}

/** In strict mode an absent response capability is a failure, not a skip. */
export function capabilityOrSkip(t, condition, message, { strict = STRICT_PROOF } = {}) {
  if (condition) return true;
  if (strict) assert.fail(`strict proof requires capability: ${message}`);
  t.skip(message);
  return false;
}

/** Assert the concrete fiducia-node `/v1/status` contract. */
export function assertHealthyNodeStatus(status, label = "status") {
  assert.equal(status?.service, "fiducia-node", `${label}: service`);
  const consensus = status?.consensus;
  assert.ok(consensus && typeof consensus === "object", `${label}: consensus object`);
  assert.equal(typeof consensus.node_id, "string", `${label}: node_id`);
  assert.ok(Number.isInteger(consensus.shard_count) && consensus.shard_count > 0, `${label}: shard_count`);
  assert.ok(Array.isArray(consensus.shards), `${label}: shards`);
  assert.equal(
    consensus.shards.length,
    consensus.shard_count,
    `${label}: status must cover every expected shard exactly once`,
  );
  assert.deepEqual(
    consensus.shards.map((shard) => shard?.shard_id).sort((a, b) => a - b),
    Array.from({ length: consensus.shard_count }, (_, shardId) => shardId),
    `${label}: shard IDs must be the complete 0..shard_count-1 set`,
  );
  for (const shard of consensus.shards) {
    assert.ok(Number.isInteger(shard.shard_id), `${label}: shard_id`);
    assert.ok(["leader", "follower", "candidate"].includes(shard.role), `${label}: role`);
    assert.ok(Number.isInteger(shard.term), `${label}: term`);
    assert.ok(Number.isInteger(shard.commit_index), `${label}: commit_index`);
    assert.ok(Number.isInteger(shard.last_applied), `${label}: last_applied`);
    assert.ok(shard.last_applied <= shard.commit_index, `${label}: apply index cannot exceed commit`);
    assert.equal(typeof shard.has_quorum, "boolean", `${label}: has_quorum`);
    assert.equal(typeof shard.leader_id, "string", `${label}: every shard must know its leader`);
    assert.ok(shard.leader_id.length > 0, `${label}: leader_id`);
    if (shard.role === "leader") {
      assert.equal(shard.has_quorum, true, `${label}: leader must report quorum`);
    }
  }
}

export { HttpError };
