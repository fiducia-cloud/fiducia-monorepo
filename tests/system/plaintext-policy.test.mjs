// DEN-1244 / DEN-1391 KV-001: real-process proof that callers cannot opt
// individual managed-beta KV values out of at-rest protection with
// `plaintext:true` unless they carry the separate `admin:write` authority, and
// that the reserved secret keyspace never permits that opt-out.
//
// This suite runs against three real fiducia-node Raft members behind the real
// fiducia-load-balance. It proves route behavior and non-persistence of denied
// canaries. Exact production PVC/snapshot/log inspection remains a later live
// evidence requirement.

import { request as httpRequest } from "node:http";
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
const ORG = "e2e-plaintext-policy-org";
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

function trustedHeaders(orgId, scopes) {
  return {
    [EDGE_AUTH_HEADER]: INTERNAL_SECRET,
    [ORG_HEADER]: orgId,
    [SCOPES_HEADER]: scopes,
  };
}

function edgeClient(stack, orgId, scopes = "*") {
  const edgeFetch = (url, init = {}) =>
    fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...trustedHeaders(orgId, scopes),
      },
    });
  return new FiduciaClient(stack.lbUrl, { fetch: edgeFetch });
}

async function rawPlaintextPut(stack, { key, value, scopes }) {
  return fetch(`${stack.lbUrl}/v1/kv?key=${encodeURIComponent(key)}`, {
    method: "PUT",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      ...trustedHeaders(ORG, scopes),
    },
    body: JSON.stringify({ value, plaintext: true }),
    signal: AbortSignal.timeout(5_000),
  });
}

function rawHttp(url, { method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest(
      url,
      {
        method,
        headers,
        signal: AbortSignal.timeout(5_000),
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("error", rejectPromise);
        response.on("end", () => {
          resolvePromise({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", rejectPromise);
    request.end(body);
  });
}

async function rawDuplicateScopeRequest(
  stack,
  { path, method = "GET", scopeValues, body },
) {
  assert.equal(scopeValues.length, 2, "duplicate-scope proof requires exactly two lines");
  const serialized = body === undefined ? "" : JSON.stringify(body);
  const headers = {
    [EDGE_AUTH_HEADER]: INTERNAL_SECRET,
    [ORG_HEADER]: ORG,
    // Node's HTTP client emits one field line per array element for custom
    // headers. This intentionally exercises duplicate wire-level fields rather
    // than a comma-joined value.
    [SCOPES_HEADER]: scopeValues,
    connection: "close",
  };
  if (serialized) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(serialized));
  }
  return rawHttp(new URL(path, stack.lbUrl), {
    method,
    headers,
    body: serialized,
  });
}

async function settledPlaintextPut(stack, request, label) {
  return eventually(
    async () => {
      const response = await rawPlaintextPut(stack, request);
      if (response.status === 502 || response.status === 503) {
        await response.arrayBuffer();
        throw new Error(`transient route status ${response.status}`);
      }
      return response;
    },
    { timeoutMs: 60_000, label },
  );
}

async function settledDuplicateScopePlaintextPut(stack, request, label) {
  return eventually(
    async () => {
      const response = await rawDuplicateScopeRequest(stack, request);
      if (response.status === 502 || response.status === 503) {
        throw new Error(`transient route status ${response.status}`);
      }
      return response;
    },
    { timeoutMs: 60_000, label },
  );
}

async function assertKvMissing(client, key, label) {
  return eventually(
    async () => {
      try {
        const result = await client.kvGet(key);
        assert.equal(
          result?.entry ?? result?.value ?? null,
          null,
          `${label}: denied plaintext canary became visible`,
        );
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return;
        throw error;
      }
    },
    { timeoutMs: 60_000, label: `${label} remains absent` },
  );
}

async function assertPlaintextDenied(response, canary, label) {
  assert.equal(response.status, 403, `${label}: expected HTTP 403`);
  assert.equal(response.headers.get("location"), null, `${label}: denial must not redirect`);
  const body = await response.json();
  assert.equal(body?.error, "plaintext_kv_forbidden");
  assert.ok(
    !JSON.stringify(body).includes(canary),
    `${label}: denial response echoed the submitted value`,
  );
}

describe(
  "DEN-1244 real-process plaintext KV policy",
  { skip: SKIP, concurrency: 1 },
  () => {
    /** @type {Awaited<ReturnType<typeof bootCoordinationStack>>} */
    let stack;
    /** @type {FiduciaClient} */
    let ordinary;

    before(async () => {
      stack = await bootCoordinationStack({ shardCount: 4, compactThreshold: 16 });
      ordinary = edgeClient(stack, ORG, "*");

      const warmupKey = uniqueKey("plaintext-policy-warmup");
      await eventually(() => ordinary.kvPut(warmupKey, "ready"), {
        timeoutMs: 60_000,
        label: "plaintext policy LB routing warmup",
      });
    }, { timeout: 900_000 });

    after(async () => {
      await stack?.stop();
    }, { timeout: 120_000 });

    it(
      "KV-001: ordinary kv:write cannot persist plaintext:true",
      { timeout: 180_000 },
      async () => {
        const key = uniqueKey("ordinary-plaintext-denied");
        const canary = uniqueId("ordinary-plaintext-canary");
        const response = await settledPlaintextPut(
          stack,
          { key, value: canary, scopes: "kv:write" },
          "ordinary plaintext denial",
        );

        await assertPlaintextDenied(response, canary, "ordinary plaintext write");
        await assertKvMissing(ordinary, key, "ordinary plaintext write");
      },
    );

    it(
      "KV-001: wildcard data-plane authority is not admin plaintext authority",
      { timeout: 180_000 },
      async () => {
        const key = uniqueKey("wildcard-plaintext-denied");
        const canary = uniqueId("wildcard-plaintext-canary");
        const response = await settledPlaintextPut(
          stack,
          { key, value: canary, scopes: "*" },
          "wildcard plaintext denial",
        );

        await assertPlaintextDenied(response, canary, "wildcard plaintext write");
        await assertKvMissing(ordinary, key, "wildcard plaintext write");
      },
    );

    it(
      "KV-001: explicit admin:write may opt out only for a non-secret key",
      { timeout: 180_000 },
      async () => {
        const key = uniqueKey("admin-plaintext-allowed");
        const value = uniqueId("admin-plaintext-value");
        const response = await settledPlaintextPut(
          stack,
          { key, value, scopes: "kv:read kv:write admin:write" },
          "admin non-secret plaintext write",
        );
        assert.ok(response.ok, `admin non-secret write failed with ${response.status}`);
        await response.arrayBuffer();

        const result = await eventually(() => ordinary.kvGet(key), {
          timeoutMs: 60_000,
          label: "admin plaintext value readback",
        });
        assert.equal(result?.entry?.value, value);
        assert.equal(result?.protection?.at_rest, "plaintext");
      },
    );

    it(
      "KV-001: secret keyspace rejects plaintext:true even with admin:write",
      { timeout: 180_000 },
      async () => {
        const key = `secret/${uniqueKey("admin-secret-plaintext-denied")}`;
        const canary = uniqueId("admin-secret-plaintext-canary");
        const response = await settledPlaintextPut(
          stack,
          { key, value: canary, scopes: "kv:read kv:write admin:write" },
          "admin secret plaintext denial",
        );

        await assertPlaintextDenied(response, canary, "admin secret plaintext write");
        await assertKvMissing(ordinary, key, "admin secret plaintext write");
      },
    );

    it(
      "KV-001 / AUTH-007: duplicate trusted scopes fail at the LB and cannot persist plaintext",
      { timeout: 180_000 },
      async () => {
        const uniqueAdmin = await fetch(`${stack.lbUrl}/_lb/routes`, {
          headers: trustedHeaders(ORG, "admin:write"),
          signal: AbortSignal.timeout(5_000),
        });
        assert.equal(uniqueAdmin.status, 200, "unique admin scope must reach the LB operator route");
        await uniqueAdmin.arrayBuffer();

        const duplicateOperator = await rawDuplicateScopeRequest(stack, {
          path: "/_lb/routes",
          scopeValues: ["admin:write", "admin:write"],
        });
        assert.equal(
          duplicateOperator.status,
          403,
          "identical duplicate admin scope lines must not create an operator identity",
        );
        assert.equal(JSON.parse(duplicateOperator.body)?.error, "insufficient_scope");

        const key = uniqueKey("duplicate-scope-plaintext-denied");
        const canary = uniqueId("duplicate-scope-plaintext-canary");
        const response = await settledDuplicateScopePlaintextPut(
          stack,
          {
            path: `/v1/kv?key=${encodeURIComponent(key)}`,
            method: "PUT",
            scopeValues: [
              "kv:write admin:write",
              "admin:write kv:write",
            ],
            body: { value: canary, plaintext: true },
          },
          "duplicate trusted scopes plaintext denial",
        );

        assert.ok(
          response.status < 200 || response.status >= 300,
          `duplicate trusted scopes unexpectedly produced HTTP ${response.status}`,
        );
        assert.equal(response.headers.location, undefined, "denial must not redirect");
        assert.ok(
          !response.body.includes(canary),
          "duplicate-scope denial echoed the submitted plaintext canary",
        );
        await assertKvMissing(ordinary, key, "duplicate trusted scopes plaintext write");

        for (const source of ["lb", 0, 1, 2]) {
          assert.ok(
            !stack.logsOf(source).includes(canary),
            `duplicate-scope canary leaked into ${source === "lb" ? "LB" : `node ${source}`} logs`,
          );
        }
      },
    );
  },
);