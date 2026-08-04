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
  return eventually(
    async () => {
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
    },
    {
      timeoutMs: 60_000,
      label: `${label} remains absent after routing convergence`,
    },
  );
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
      "AUTH-001/KV-002: identical raw anchor keys and prefix-list responses remain tenant scoped",
      { timeout: 180_000 },
      async () => {
        // A prefix list is currently routed by the prefix and is not yet a
        // cross-shard fan-out operation. Use an anchor whose raw key is exactly
        // the listed prefix so the test proves isolation without pretending the
        // endpoint already guarantees complete enumeration across all shards.
        const prefix = `${uniqueKey("shared-prefix")}/anchor`;
        const anchorKey = prefix;
        const onlyAKey = `${prefix}/only-a`;
        const onlyBKey = `${prefix}/only-b`;
        const valueA = uniqueId("tenant-a-value");
        const valueB = uniqueId("tenant-b-value");
        const onlyAValue = uniqueId("a-only-value");
        const onlyBValue = uniqueId("b-only-value");

        await eventually(() => edgeA.kvPut(anchorKey, valueA), {
          label: "org A anchor write",
        });
        await eventually(() => edgeA.kvPut(onlyAKey, onlyAValue), {
          label: "org A secondary write",
        });
        await assertKvMissing(edgeB, anchorKey, "org B before its own anchor write");

        await eventually(() => edgeB.kvPut(anchorKey, valueB), {
          label: "org B anchor write",
        });
        await eventually(() => edgeB.kvPut(onlyBKey, onlyBValue), {
          label: "org B secondary write",
        });

        const [readA, readB] = await Promise.all([
          eventually(() => edgeA.kvGet(anchorKey), { label: "org A anchor read" }),
          eventually(() => edgeB.kvGet(anchorKey), { label: "org B anchor read" }),
        ]);
        assert.equal(readA?.entry?.value, valueA);
        assert.equal(readB?.entry?.value, valueB);

        const listA = await eventually(
          async () => {
            const result = await edgeA.kvList(prefix);
            const rows = listedRows(result);
            const anchorRows = rows.filter((row) => row.key === anchorKey);
            assert.equal(anchorRows.length, 1, "org A list contains one scoped anchor");
            assert.equal(anchorRows[0]?.value, valueA);
            assert.ok(
              rows.every((row) => row.key === anchorKey || row.key === onlyAKey),
              "org A list contains only org A caller-facing keys",
            );
            assert.ok(
              !JSON.stringify(result).includes(valueB) &&
                !JSON.stringify(result).includes(onlyBValue),
              "org A list must not contain org B values",
            );
            assertNoInternalIdentity(result, "org A list");
            return result;
          },
          { timeoutMs: 60_000, label: "org A scoped prefix list" },
        );

        const listB = await eventually(
          async () => {
            const result = await edgeB.kvList(prefix);
            const rows = listedRows(result);
            const anchorRows = rows.filter((row) => row.key === anchorKey);
            assert.equal(anchorRows.length, 1, "org B list contains one scoped anchor");
            assert.equal(anchorRows[0]?.value, valueB);
            assert.ok(
              rows.every((row) => row.key === anchorKey || row.key === onlyBKey),
              "org B list contains only org B caller-facing keys",
            );
            assert.ok(
              !JSON.stringify(result).includes(valueA) &&
                !JSON.stringify(result).includes(onlyAValue),
              "org B list must not contain org A values",
            );
            assertNoInternalIdentity(result, "org B list");
            return result;
          },
          { timeoutMs: 60_000, label: "org B scoped prefix list" },
        );

        assert.ok(listedRows(listA).length >= 1);
        assert.ok(listedRows(listB).length >= 1);
      },
    );

    it(
      "KV-002: a caller key shaped like another tenant's internal prefix cannot escape its own namespace",
      { timeout: 180_000 },
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
        await eventually(
          async () => {
            const result = await edgeB.kvList(INTERNAL_SCOPE_DELIMITER);
            assert.deepEqual(
              listedRows(result),
              [],
              "org B cannot discover org A's crafted key by listing the delimiter prefix",
            );
          },
          { timeoutMs: 60_000, label: "org B crafted-prefix list remains empty" },
        );
      },
    );

    it(
      "KV-004 partial: secret inventory omits values while explicit reveal remains tenant-isolated",
      { timeout: 180_000 },
      async () => {
        const prefix = `${uniqueKey("redacted-secret")}/`;
        const name = `${prefix}database-password`;
        const secretValue = uniqueId("canary-secret-value");

        await eventually(() => edgeA.secretPut(name, secretValue), {
          label: "org A secret write",
        });

        const inventory = await eventually(
          async () => {
            const result = await edgeA.secretList(prefix);
            assert.equal(result.count, 1);
            assert.equal(result.secrets[0]?.name, name);
            assert.ok(
              !JSON.stringify(result).includes(secretValue),
              "secret inventory must never include the secret value",
            );
            assertNoInternalIdentity(result, "secret inventory");
            return result;
          },
          { timeoutMs: 60_000, label: "org A redacted secret inventory" },
        );
        assert.equal(inventory.count, 1);

        const revealed = await eventually(() => edgeA.secretReveal(name), {
          label: "org A explicit secret reveal",
        });
        assert.equal(revealed?.entry?.value, secretValue);
        await assertKvMissing(edgeB, `secret/${name}`, "org B secret reveal");
      },
    );
  },
);
