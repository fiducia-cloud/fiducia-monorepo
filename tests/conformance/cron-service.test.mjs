// Conformance: customer-facing cron jobs as a service.
//
// These tests exercise the real tenant-scoped HTTP control plane added by the
// hardened scheduler. They intentionally do not forge run records: only the
// elected runner may write the audit trail.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FiduciaClient, HttpError, output } from "../../src/client.mjs";
import { endpoints, makeClient, primary } from "../../src/endpoints.mjs";
import { NO_ENDPOINT, skipIfUndeployed, uniqueId } from "../helpers.mjs";

const enc = encodeURIComponent;
const TERMINAL = new Set(["delivered", "failed", "succeeded", "completed"]);

function farFutureMs() {
  return Date.now() + 24 * 60 * 60 * 1_000;
}

function upsert(client, name, overrides = {}) {
  return client.request("PUT", `/v1/cron/schedules/${enc(name)}`, {
    one_shot_at_ms: farFutureMs(),
    target: { kind: "function", function_id: uniqueId("missing-function") },
    delivery: "at_least_once",
    max_retries: 0,
    ...overrides,
  });
}

function list(client, { cursor, limit = 50 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set("cursor", cursor);
  return client.request("GET", `/v1/cron/schedules?${query}`);
}

function get(client, name) {
  return client.request("GET", `/v1/cron/schedules/${enc(name)}`);
}

function remove(client, name) {
  return client.request("DELETE", `/v1/cron/schedules/${enc(name)}`);
}

function pause(client, name) {
  return client.request("POST", `/v1/cron/schedules/${enc(name)}/pause`);
}

function resume(client, name, catchUp = false) {
  return client.request(
    "POST",
    `/v1/cron/schedules/${enc(name)}/resume?catch_up=${catchUp ? "true" : "false"}`,
  );
}

function trigger(client, name, fireIdMs) {
  return client.request(
    "POST",
    `/v1/cron/schedules/${enc(name)}/trigger?fire_id_ms=${fireIdMs}`,
  );
}

function history(client, name, limit = 100) {
  return client.request("GET", `/v1/cron/schedules/${enc(name)}/history?limit=${limit}`);
}

async function eventually(fn, predicate, {
  timeoutMs = Number(process.env.FIDUCIA_E2E_CRON_TIMEOUT_MS || 30_000),
  intervalMs = 250,
  label = "condition",
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  let lastError;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (predicate(last)) return last;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (lastError) throw new Error(`timed out waiting for ${label}`, { cause: lastError });
  assert.fail(`timed out waiting for ${label}; last value: ${JSON.stringify(last)}`);
}

function runsFrom(value) {
  return Array.isArray(value?.history) ? value.history : [];
}

function fireIdOf(run) {
  return Number(run?.fire_id_ms ?? run?.fire_id ?? run?.fireId);
}

function isTerminal(run) {
  return run?.completed_at_ms != null || TERMINAL.has(String(run?.status || "").toLowerCase());
}

function assertTraceShape(run) {
  if (run.trace_id != null) {
    assert.match(run.trace_id, /^[0-9a-f]{32}$/i, "trace_id should be W3C-width hex");
  }
  if (run.span_id != null) {
    assert.match(run.span_id, /^[0-9a-f]{16}$/i, "span_id should be W3C-width hex");
  }
}

function assertSanitizedRun(run) {
  const serialized = JSON.stringify(run).toLowerCase();
  for (const forbidden of [
    "function_body",
    "functionbody",
    "function_source",
    "authorization",
    "x-server-auth",
    "x-fiducia-internal-auth",
    "cookie",
    "environment",
    "webhook_url",
    "request_body",
    "response_body",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `run trail leaked ${forbidden}`);
  }
  assert.ok(
    run.error == null || (typeof run.error === "string" && run.error.length <= 512),
    "sanitized error should be absent or bounded",
  );
}

function directTenantClient(baseUrl, orgId) {
  const secret = process.env.FIDUCIA_E2E_INTERNAL_SECRET
    || process.env.FIDUCIA_E2E_LOCAL_EDGE_SECRET;
  if (!secret) return null;

  const origin = new URL(baseUrl);
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(origin.hostname);
  const insecureLocal = loopback
    && process.env.FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST === "1";
  if (origin.protocol !== "https:" && !insecureLocal) {
    throw new Error("refusing to send the cron tenant-isolation secret over non-HTTPS");
  }

  return new FiduciaClient(baseUrl, {
    internalSecret: secret,
    internalOrgId: orgId,
    failoverEndpoints: endpoints(),
  });
}

describe("cron jobs service control plane", { skip: NO_ENDPOINT }, () => {
  it("supports tenant-scoped CRUD, pause/resume, list, and delete", async (t) => {
    const client = makeClient();
    const name = uniqueId("cron-crud");
    t.after(async () => remove(client, name).catch(() => {}));

    await skipIfUndeployed(t, "GET /v1/cron/schedules", async () => {
      await upsert(client, name);

      const read = await get(client, name);
      assert.equal(read?.found, true);
      assert.equal(read?.schedule?.name, name, "the public API must remove internal org scope");
      assert.equal(read?.schedule?.enabled, true);
      assert.equal(read?.schedule?.target?.kind, "function");

      const inventory = await list(client, { limit: 200 });
      assert.ok(inventory.schedules.some((schedule) => schedule.name === name));
      assert.equal(
        inventory.schedules.some((schedule) => schedule.name.includes("\u001f")),
        false,
        "replicated scope delimiters must not escape to customers",
      );

      await pause(client, name);
      assert.equal((await get(client, name))?.schedule?.enabled, false);

      await resume(client, name, false);
      assert.equal((await get(client, name))?.schedule?.enabled, true);

      await remove(client, name);
      assert.equal((await get(client, name))?.found, false);
      assert.equal((await list(client, { limit: 200 })).schedules.some((s) => s.name === name), false);
    });
  });

  it("paginates deterministically without leaking another page into the cursor", async (t) => {
    const client = makeClient();
    const prefix = uniqueId("cron-page");
    const names = [`${prefix}-a`, `${prefix}-b`, `${prefix}-c`];
    t.after(async () => Promise.all(names.map((name) => remove(client, name).catch(() => {}))));

    await skipIfUndeployed(t, "GET /v1/cron/schedules?cursor=", async () => {
      for (const name of names) await upsert(client, name);

      const all = await list(client, { limit: 200 });
      const ours = all.schedules.filter((schedule) => schedule.name.startsWith(prefix));
      assert.deepEqual(ours.map((schedule) => schedule.name), names);

      // Exercise the service cursor against the full inventory rather than
      // assuming this test owns the tenant. Every page must be sorted and disjoint.
      const first = await list(client, { limit: 2 });
      assert.ok(first.schedules.length <= 2);
      assert.deepEqual(
        first.schedules.map((schedule) => schedule.name),
        [...first.schedules.map((schedule) => schedule.name)].sort(),
      );
      if (first.next_cursor) {
        const second = await list(client, { cursor: first.next_cursor, limit: 2 });
        const firstNames = new Set(first.schedules.map((schedule) => schedule.name));
        assert.equal(second.schedules.some((schedule) => firstNames.has(schedule.name)), false);
        assert.ok(second.schedules.every((schedule) => schedule.name > first.next_cursor));
      }
    });
  });

  it("manual trigger is idempotent and produces one sanitized traceable run", async (t) => {
    const client = makeClient();
    const name = uniqueId("cron-trigger");
    const fireIdMs = Date.now();
    t.after(async () => remove(client, name).catch(() => {}));

    await skipIfUndeployed(t, "POST /v1/cron/schedules/{name}/trigger", async () => {
      await upsert(client, name, {
        cron: "0 0 1 1 *",
        one_shot_at_ms: undefined,
      });

      await trigger(client, name, fireIdMs);
      await trigger(client, name, fireIdMs);

      const finalHistory = await eventually(
        () => history(client, name),
        (value) => runsFrom(value).some((run) => fireIdOf(run) === fireIdMs && isTerminal(run)),
        { label: "one terminal manual cron run" },
      );
      const matching = runsFrom(finalHistory).filter((run) => fireIdOf(run) === fireIdMs);
      assert.equal(matching.length, 1, "repeating one fire_id_ms must not create duplicate runs");

      const [run] = matching;
      assert.equal(String(run.trigger).toLowerCase(), "manual");
      assert.ok(Number.isInteger(run.attempts) && run.attempts >= 0);
      assert.ok(Number.isInteger(run.duration_ms) && run.duration_ms >= 0);
      assertTraceShape(run);
      assertSanitizedRun(run);
    });
  });

  it("rejects SSRF targets, URL credentials, and path-like function identifiers", async (t) => {
    const client = makeClient();
    const cases = [
      {
        name: uniqueId("cron-ssrf"),
        target: { kind: "webhook", url: "http://127.0.0.1:9/internal" },
      },
      {
        name: uniqueId("cron-creds"),
        target: { kind: "webhook", url: "https://user:pass@example.com/hook" },
      },
      {
        name: uniqueId("cron-function-path"),
        target: { kind: "function", function_id: "../secret" },
      },
    ];

    await skipIfUndeployed(t, "PUT /v1/cron/schedules/{name} validation", async () => {
      for (const testCase of cases) {
        await assert.rejects(
          upsert(client, testCase.name, { target: testCase.target }),
          (error) => error instanceof HttpError && error.status === 400,
          `unsafe target should be rejected: ${JSON.stringify(testCase.target)}`,
        );
      }
    });
  });

  it("isolates identical schedule names and histories across two tenants", async (t) => {
    const base = primary();
    const orgA = uniqueId("cron-org-a");
    const orgB = uniqueId("cron-org-b");
    const clientA = directTenantClient(base, orgA);
    const clientB = directTenantClient(base, orgB);
    if (!clientA || !clientB) {
      t.skip("requires FIDUCIA_E2E_INTERNAL_SECRET or the localhost edge secret");
      return;
    }

    const name = uniqueId("shared-cron-name");
    const functionA = uniqueId("tenant-a-function");
    const functionB = uniqueId("tenant-b-function");
    t.after(async () => Promise.all([
      remove(clientA, name).catch(() => {}),
      remove(clientB, name).catch(() => {}),
    ]));

    await skipIfUndeployed(t, "tenant-scoped cron CRUD", async () => {
      await upsert(clientA, name, { target: { kind: "function", function_id: functionA } });
      await upsert(clientB, name, { target: { kind: "function", function_id: functionB } });

      const readA = await get(clientA, name);
      const readB = await get(clientB, name);
      assert.equal(readA?.schedule?.target?.function_id, functionA);
      assert.equal(readB?.schedule?.target?.function_id, functionB);

      assert.equal((await list(clientA, { limit: 200 })).schedules.filter((s) => s.name === name).length, 1);
      assert.equal((await list(clientB, { limit: 200 })).schedules.filter((s) => s.name === name).length, 1);

      await remove(clientA, name);
      assert.equal((await get(clientA, name))?.found, false);
      assert.equal((await get(clientB, name))?.found, true, "tenant A delete must not affect tenant B");
      assert.deepEqual(runsFrom(await history(clientA, name)), []);
      assert.deepEqual(runsFrom(await history(clientB, name)), []);
    });
  });
});
