// DEN-1391 production safety gate: execute the first tenant/credential-plane
// adversarial rows against the REAL local composition — 3 fiducia-node Raft
// members behind fiducia-load-balance. These are not mocked router tests.
//
// Covered gate rows:
//   AUTH-001: organization-scoped KV and lock isolation end to end.
//   AUTH-002: direct-node and forged/duplicated trusted-header bypasses fail.
//   AUTH-007: edge/LB credential-plane separation and internal-header scrubbing.
//
// Opt-in and heavyweight: FIDUCIA_E2E_SYSTEM=1. The dedicated CI workflow
// checks out exact node/LB commits and runs this file alone. Plain `npm test`
// still parses it and skips cleanly when the composition is unavailable.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { FiduciaClient, HttpError, output } from "../../src/client.mjs";
import {
  bootCoordinationStack,
  coordinationSkipReason,
  INTERNAL_AUTH_HEADER,
  INTERNAL_SECRET,
} from "../../src/coordination.mjs";
import { uniqueId, uniqueKey } from "../helpers.mjs";

const SKIP = coordinationSkipReason();
const ORG_A = "e2e-security-org-a";
const ORG_B = "e2e-security-org-b";
const EDGE_AUTH_HEADER = "x-fiducia-edge-auth";
const ORG_HEADER = "x-fiducia-org-id";
const SCOPES_HEADER = "x-fiducia-scopes";

async function eventually(
  fn,
  { timeoutMs = 30_000, intervalMs = 200, label = "condition" } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await delay(intervalMs);
    }
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${label}: ${lastError?.message ?? lastError}`,
  );
}

function edgeClient(stack, orgId, extraHeaders = {}) {
  const edgeFetch = (url, init = {}) =>
    fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...extraHeaders,
        [EDGE_AUTH_HEADER]: INTERNAL_SECRET,
        [ORG_HEADER]: orgId,
        [SCOPES_HEADER]: "*",
      },
    });
  return new FiduciaClient(stack.lbUrl, { fetch: edgeFetch });
}

function duplicateHeaders(entries) {
  const headers = new Headers();
  for (const [name, value] of entries) headers.append(name, value);
  return headers;
}

async function rawKvPut(baseUrl, key, value, headers) {
  return fetch(`${baseUrl}/v1/kv?key=${encodeURIComponent(key)}`, {
    method: "PUT",
    redirect: "manual",
    headers,
    body: JSON.stringify({ value, plaintext: false }),
    signal: AbortSignal.timeout(5_000),
  });
}

async function assertDenied(response, label) {
  assert.ok(
    response.status === 401 || response.status === 403,
    `${label}: expected HTTP 401/403, received ${response.status}`,
  );
  assert.equal(
    response.headers.get("location"),
    null,
    `${label}: an unauthenticated request must not receive a leader redirect`,
  );
  // Consume a bounded response so keep-alive sockets are reusable. Never copy
  // the body into assertion output: an auth failure must remain secret-safe.
  await response.arrayBuffer();
}

async function assertKvMissing(client, key, label) {
  return eventually(
    async () => {
      try {
        const result = await client.kvGet(key);
        assert.equal(
          result?.entry ?? result?.value ?? null,
          null,
          `${label}: the denied/cross-tenant write became visible`,
        );
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return;
        throw error;
      }
    },
    {
      timeoutMs: 60_000,
      label: `${label} remains absent after routing convergence`,
    },
  );
}

describe(
  "DEN-1391 system security boundaries",
  { skip: SKIP, concurrency: 1 },
  () => {
    /** @type {Awaited<ReturnType<typeof bootCoordinationStack>>} */
    let stack;
    /** @type {FiduciaClient} */
    let edgeA;
    /** @type {FiduciaClient} */
    let edgeB;

    before(async () => {
      stack = await bootCoordinationStack({ shardCount: 4, compactThreshold: 16 });
      edgeA = edgeClient(stack, ORG_A);
      edgeB = edgeClient(stack, ORG_B);

      // The process readiness endpoints become healthy before every shard's LB
      // route has necessarily converged. Establish one committed operation so
      // later failures are auth/tenancy evidence, not startup noise.
      const warmupKey = uniqueKey("security-warmup");
      await eventually(() => edgeA.kvPut(warmupKey, "ready"), {
        timeoutMs: 60_000,
        label: "security-suite LB routing warmup",
      });
    }, { timeout: 900_000 });

    after(async () => {
      await stack?.stop();
    }, { timeout: 120_000 });

    it(
      "AUTH-002: direct nodes reject missing, wrong, edge-only, bearer-only, and duplicated internal credentials",
      { timeout: 180_000 },
      async () => {
        const nodeUrl = stack.nodeUrls[0];
        const key = uniqueKey("direct-node-bypass");
        const base = [
          ["content-type", "application/json"],
          [ORG_HEADER, ORG_A],
        ];

        const attempts = [
          {
            label: "missing internal credential with forged org",
            headers: duplicateHeaders(base),
          },
          {
            label: "wrong internal credential",
            headers: duplicateHeaders([
              ...base,
              [INTERNAL_AUTH_HEADER, "attacker-wrong-internal-secret"],
            ]),
          },
          {
            label: "edge credential presented to the node plane",
            headers: duplicateHeaders([
              ...base,
              [EDGE_AUTH_HEADER, INTERNAL_SECRET],
              [SCOPES_HEADER, "*"],
            ]),
          },
          {
            label: "bearer credential presented without trusted-hop authority",
            headers: duplicateHeaders([
              ...base,
              ["authorization", "Bearer attacker-customer-token"],
            ]),
          },
          {
            label: "ambiguous duplicated internal credential",
            headers: duplicateHeaders([
              ...base,
              [INTERNAL_AUTH_HEADER, INTERNAL_SECRET],
              [INTERNAL_AUTH_HEADER, "attacker-appended-value"],
            ]),
          },
        ];

        for (const attempt of attempts) {
          // eslint-disable-next-line no-await-in-loop
          const response = await rawKvPut(nodeUrl, key, attempt.label, attempt.headers);
          // eslint-disable-next-line no-await-in-loop
          await assertDenied(response, attempt.label);
        }

        // Verify the denied writes through the authoritative LB path. A fixed
        // direct node can correctly be a follower and reject linearizable reads
        // with 503; that is not evidence that the denied write committed.
        await assertKvMissing(edgeA, key, "direct-node bypass attempts");
      },
    );

    it(
      "AUTH-007: the LB rejects node-plane credentials and ambiguous edge identities",
      { timeout: 180_000 },
      async () => {
        const key = uniqueKey("lb-plane-separation");
        const base = [["content-type", "application/json"]];
        const attempts = [
          {
            label: "node internal credential presented to the edge plane",
            headers: duplicateHeaders([
              ...base,
              [INTERNAL_AUTH_HEADER, INTERNAL_SECRET],
              [ORG_HEADER, ORG_A],
              [SCOPES_HEADER, "*"],
            ]),
          },
          {
            label: "wrong edge credential",
            headers: duplicateHeaders([
              ...base,
              [EDGE_AUTH_HEADER, "attacker-wrong-edge-secret"],
              [ORG_HEADER, ORG_A],
              [SCOPES_HEADER, "*"],
            ]),
          },
          {
            label: "valid edge credential without a verified organization",
            headers: duplicateHeaders([
              ...base,
              [EDGE_AUTH_HEADER, INTERNAL_SECRET],
              [SCOPES_HEADER, "*"],
            ]),
          },
          {
            label: "ambiguous duplicated edge credential",
            headers: duplicateHeaders([
              ...base,
              [EDGE_AUTH_HEADER, INTERNAL_SECRET],
              [EDGE_AUTH_HEADER, "attacker-appended-value"],
              [ORG_HEADER, ORG_A],
              [SCOPES_HEADER, "*"],
            ]),
          },
          {
            label: "ambiguous duplicated organization identity",
            headers: duplicateHeaders([
              ...base,
              [EDGE_AUTH_HEADER, INTERNAL_SECRET],
              [ORG_HEADER, ORG_A],
              [ORG_HEADER, ORG_B],
              [SCOPES_HEADER, "*"],
            ]),
          },
        ];

        for (const attempt of attempts) {
          // eslint-disable-next-line no-await-in-loop
          const response = await rawKvPut(stack.lbUrl, key, attempt.label, attempt.headers);
          // eslint-disable-next-line no-await-in-loop
          await assertDenied(response, attempt.label);
        }

        await assertKvMissing(edgeA, key, "LB plane-separation attempts");
      },
    );

    it(
      "AUTH-007: the LB removes a client-supplied node credential and injects its canonical trusted-hop credential",
      { timeout: 120_000 },
      async () => {
        const key = uniqueKey("lb-scrubs-internal-header");
        const value = uniqueId("scrubbed-value");
        const client = edgeClient(stack, ORG_A, {
          [INTERNAL_AUTH_HEADER]: "attacker-client-controlled-node-secret",
        });

        await eventually(() => client.kvPut(key, value), {
          timeoutMs: 30_000,
          label: "LB write with forged client internal header",
        });
        assert.equal(
          (await eventually(() => edgeA.kvGet(key), {
            label: "read value written through scrubbed LB request",
          }))?.entry?.value,
          value,
          "LB must strip the forged internal credential and inject its own trusted-hop credential",
        );
      },
    );

    it(
      "AUTH-001: two organizations using the same raw KV key observe disjoint values through the full edge/LB/node path",
      { timeout: 180_000 },
      async () => {
        const key = uniqueKey("cross-org-kv");
        const valueA = uniqueId("org-a-value");
        const valueB = uniqueId("org-b-value");

        await eventually(() => edgeA.kvPut(key, valueA), {
          label: "org A KV write",
        });
        await assertKvMissing(edgeB, key, "org B before its own write");

        await eventually(() => edgeB.kvPut(key, valueB), {
          label: "org B KV write",
        });

        const [readA, readB] = await Promise.all([
          eventually(() => edgeA.kvGet(key), { label: "org A KV read" }),
          eventually(() => edgeB.kvGet(key), { label: "org B KV read" }),
        ]);
        assert.equal(readA?.entry?.value, valueA, "org A retains its value");
        assert.equal(readB?.entry?.value, valueB, "org B retains its value");
        assert.notEqual(readA?.entry?.mod_revision, undefined);
        assert.notEqual(readB?.entry?.mod_revision, undefined);
      },
    );

    it(
      "AUTH-001: two organizations can independently hold the same raw lock key and receive distinct fencing authority",
      { timeout: 180_000 },
      async () => {
        const key = uniqueKey("cross-org-lock");
        const holderA = uniqueId("org-a-holder");
        const holderB = uniqueId("org-b-holder");

        const [grantA, grantB] = await Promise.all([
          eventually(() => edgeA.tryLock(key, { holder: holderA, ttlMs: 60_000 }), {
            label: "org A lock grant",
          }),
          eventually(() => edgeB.tryLock(key, { holder: holderB, ttlMs: 60_000 }), {
            label: "org B lock grant",
          }),
        ]);
        const lockA = output(grantA);
        const lockB = output(grantB);
        assert.equal(lockA?.acquired, true, "org A must acquire its scoped lock");
        assert.equal(lockB?.acquired, true, "org B must acquire its scoped lock");
        assert.ok(Number.isInteger(lockA?.fencing_token));
        assert.ok(Number.isInteger(lockB?.fencing_token));

        await Promise.all([
          eventually(
            () => edgeA.lockRelease(key, {
              holder: holderA,
              fencingToken: lockA.fencing_token,
            }),
            { timeoutMs: 60_000, label: "org A lock release" },
          ),
          eventually(
            () => edgeB.lockRelease(key, {
              holder: holderB,
              fencingToken: lockB.fencing_token,
            }),
            { timeoutMs: 60_000, label: "org B lock release" },
          ),
        ]);
      },
    );
  },
);
