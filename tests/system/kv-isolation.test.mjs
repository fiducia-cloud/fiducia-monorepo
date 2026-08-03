// DEN-1391 production safety gate: real-process KV isolation and disclosure
// regression tests against three fiducia-node Raft members behind the real load
// balancer. This extends AUTH-001 and supplies an automated partial slice of
// KV-002/KV-004 without claiming ESO, TLS, at-rest, or production-log evidence.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { FiduciaClient, HttpError } from "../../src/client.mjs";
import {
  bootCoordinationStack,
  coordinationSkipReason,
  INTERNAL_SECRET,
} from "../../src/coordination.mjs";
import { uniqueId, uniqueKey } from "../helpers.mjs";

const SKIP = coordinationSkipReason();
const ORG_A = "e2e-kv-org-a";
const ORG_B = "e2e-kv-org-b";
const EDGE_AUTH_HEADER = "x-fiducia-edge-auth";
const ORG_HEADER = "x-fiducia-org-id";
const SCOPES_HEADER = "x-fiducia-scopes";
const INTERNAL_SCOPE_DELIMITER = "\u0001";

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

function edgeClient(stack, orgId) {
  const edgeFetch = (url, init = {}) =>
    fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        [EDGE_AUTH_HEADER]: INTERNAL_SECRET,
        [ORG_HEADER]: orgId,
        [SCOPES_HEADER]: "*",
      },
    });
  return new FiduciaClient(stack.lbUrl, { fetch: edgeFetch });
}

async function assertKvMissing(client, key, label) {
  try {
    const result = await client.kvGet(key);
    assert.equal(
      result?.entry ?? result?.value ?? null,
      null,
      `${label}: cross-tenant value became visible`,
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return;
    throw error;
  }
}

function listedRows(result) {
  assert.ok(Array.isArray(result?.keys), "KV list response must contain a keys array");
  return result.keys;
}

function assertNoInternalIdentity(value, label) {
  const serialized = JSON.stringify(value);
  assert.ok(
    !serialized.includes(INTERNAL_SCOPE_DELIMITER),
    `${label}: response leaked the internal scope delimiter`,
  );
  assert.ok(!serialized.includes(ORG_A), `${label}: response leaked org A identity`);
  assert.ok(!serialized.includes(ORG_B), `${label}: response leaked org B identity`);
}

describe(
  "DEN-1391 real-process KV isolation",
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

      const warmupKey = uniqueKey("kv-isolation-warmup");
      await eventually(() => edgeA.kvPut(warmupKey, "ready"), {
        timeoutMs: 60_000,
        label: "KV isolation LB routing warmup",
      });
    }, { timeout: 900_000 });

    after(async () => {
      await stack?.stop();
    }, { timeout: 120_000 });

    it(
      "AUTH-001/KV-002: identical raw keys and prefixes remain disjoint in get and list responses",
      { timeout: 120_000 },
      async () => {
        const prefix = `${uniqueKey("shared-prefix")}/`;
        const sharedKey = `${prefix}shared`;
        const onlyAKey = `${prefix}only-a`;
        const onlyBKey = `${prefix}only-b`;
        const valueA = uniqueId("tenant-a-value");
        const valueB = uniqueId("tenant-b-value");

        await Promise.all([
          eventually(() => edgeA.kvPut(sharedKey, valueA), { label: "org A shared-key write" }),
          eventually(() => edgeB.kvPut(sharedKey, valueB), { label: "org B shared-key write" }),
          eventually(() => edgeA.kvPut(onlyAKey, uniqueId("a-only")), {
            label: "org A unique write",
          }),
          eventually(() => edgeB.kvPut(onlyBKey, uniqueId("b-only")), {
            label: "org B unique write",
          }),
        ]);

        const [readA, readB, listA, listB] = await Promise.all([
          eventually(() => edgeA.kvGet(sharedKey), { label: "org A shared-key read" }),
          eventually(() => edgeB.kvGet(sharedKey), { label: "org B shared-key read" }),
          eventually(() => edgeA.kvList(prefix), { label: "org A prefix list" }),
          eventually(() => edgeB.kvList(prefix), { label: "org B prefix list" }),
        ]);

        assert.equal(readA?.entry?.value, valueA);
        assert.equal(readB?.entry?.value, valueB);

        const rowsA = listedRows(listA);
        const rowsB = listedRows(listB);
        assert.deepEqual(
          rowsA.map((row) => row.key).sort(),
          [onlyAKey, sharedKey].sort(),
          "org A list contains only org A caller-facing keys",
        );
        assert.deepEqual(
          rowsB.map((row) => row.key).sort(),
          [onlyBKey, sharedKey].sort(),
          "org B list contains only org B caller-facing keys",
        );
        assert.equal(rowsA.find((row) => row.key === sharedKey)?.value, valueA);
        assert.equal(rowsB.find((row) => row.key === sharedKey)?.value, valueB);
        assertNoInternalIdentity(listA, "org A list");
        assertNoInternalIdentity(listB, "org B list");
      },
    );

    it(
      "KV-002: a caller key shaped like another tenant's internal prefix cannot escape its own namespace",
      { timeout: 120_000 },
      async () => {
        const craftedKey = `${INTERNAL_SCOPE_DELIMITER}${ORG_B}${INTERNAL_SCOPE_DELIMITER}${uniqueKey("escape")}`;
        const value = uniqueId("crafted-key-value");

        await eventually(() => edgeA.kvPut(craftedKey, value), {
          label: "crafted-key write under org A",
        });
        const readA = await eventually(() => edgeA.kvGet(craftedKey), {
          label: "crafted-key read under org A",
        });
        assert.equal(readA?.entry?.value, value);
        assert.equal(readA?.key, craftedKey, "caller-facing key must round-trip exactly");

        await assertKvMissing(edgeB, craftedKey, "crafted key under org B");
        const listB = await eventually(() => edgeB.kvList(INTERNAL_SCOPE_DELIMITER), {
          label: "org B crafted-prefix list",
        });
        assert.deepEqual(
          listedRows(listB),
          [],
          "org B cannot discover org A's crafted key by listing the delimiter prefix",
        );
      },
    );

    it(
      "KV-004 partial: secret inventory omits values while explicit reveal remains tenant-isolated",
      { timeout: 120_000 },
      async () => {
        const prefix = `${uniqueKey("redacted-secret")}/`;
        const name = `${prefix}database-password`;
        const secretValue = uniqueId("canary-secret-value");

        await eventually(() => edgeA.secretPut(name, secretValue), {
          label: "org A secret write",
        });

        const inventory = await eventually(() => edgeA.secretList(prefix), {
          label: "org A secret inventory",
        });
        assert.equal(inventory.count, 1);
        assert.equal(inventory.secrets[0]?.name, name);
        assert.ok(
          !JSON.stringify(inventory).includes(secretValue),
          "secret inventory must never include the secret value",
        );
        assertNoInternalIdentity(inventory, "secret inventory");

        const revealed = await eventually(() => edgeA.secretReveal(name), {
          label: "org A explicit secret reveal",
        });
        assert.equal(revealed?.entry?.value, secretValue);
        await assertKvMissing(edgeB, `secret/${name}`, "org B secret reveal");
      },
    );
  },
);
