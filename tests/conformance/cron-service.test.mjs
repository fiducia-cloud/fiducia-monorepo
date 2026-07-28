import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FiduciaClient, output } from "../../src/client.mjs";
import {
  assertOpaqueSchedule,
  CronFunctionService,
  CronNodeService,
  CronServiceError,
} from "../../src/cron-service.mjs";
import { endpoints, primary } from "../../src/endpoints.mjs";
import {
  capabilityOrSkip,
  NO_ENDPOINT,
  skipIfUndeployed,
  STRICT_PROOF,
  uniqueId,
} from "../helpers.mjs";

const INTERNAL_SECRET = process.env.FIDUCIA_E2E_INTERNAL_SECRET?.trim();
const LAMBDA_URL = process.env.FIDUCIA_E2E_LAMBDA_SERVICE_URL?.trim();
const LAMBDA_SECRET = process.env.FIDUCIA_E2E_LAMBDA_SERVER_AUTH_SECRET?.trim();
const CRON_STRICT = STRICT_PROOF || process.env.FIDUCIA_E2E_CRON_STRICT === "1";
const CRON_GATE = { strict: CRON_STRICT };

function internalClient(orgId) {
  const base = primary();
  return new FiduciaClient(base, {
    internalSecret: INTERNAL_SECRET,
    internalOrgId: orgId,
    failoverEndpoints: endpoints().filter((endpoint) => endpoint !== base),
    timeoutMs: Number(process.env.FIDUCIA_E2E_TIMEOUT_MS || 15_000),
  });
}

function rowsOf(response, key) {
  const value = output(response) ?? response;
  const rows = value?.[key];
  return Array.isArray(rows) ? rows : [];
}

function schedulesOf(response) {
  return rowsOf(response, "schedules");
}

function historyOf(response) {
  return rowsOf(response, "history");
}

async function eventuallyHistory(service, name, fireIdMs) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const history = await service.history(name, { limit: 100 });
    const matches = historyOf(history).filter((run) => run?.fire_id_ms === fireIdMs);
    if (matches.length) return matches;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return [];
}

async function expectCronError(promise, status) {
  try {
    await promise;
    assert.fail(`expected HTTP ${status}`);
  } catch (error) {
    assert.ok(error instanceof CronServiceError, `expected CronServiceError, got ${error}`);
    assert.equal(error.status, status);
  }
}

describe("cron service HTTP conformance", { skip: NO_ENDPOINT }, () => {
  it("isolates schedules by tenant and keeps function source outside Raft", async (t) => {
    if (!capabilityOrSkip(
      t,
      Boolean(INTERNAL_SECRET),
      "FIDUCIA_E2E_INTERNAL_SECRET is required",
      CRON_GATE,
    )) return;
    const orgA = uniqueId("cron-org-a");
    const orgB = uniqueId("cron-org-b");
    const name = uniqueId("cron-isolation");
    const functionId = "c4db3dd2-19dc-4ca1-8ee4-e20d4d91c990";
    const a = new CronNodeService(internalClient(orgA));
    const b = new CronNodeService(internalClient(orgB));

    await skipIfUndeployed(t, "cron schedule CRUD", async () => {
      try {
        await a.upsert(name, {
          cron: "0 0 0 1 1 * *",
          target: { kind: "function", function_id: functionId },
          delivery: "at_least_once",
          maxRetries: 0,
        });
        const own = output(await a.get(name));
        const other = output(await b.get(name));
        assert.equal(own?.found, true);
        assert.equal(own?.schedule?.target?.kind, "function");
        assert.equal(own?.schedule?.target?.function_id, functionId);
        assert.equal(other?.found, false, "another tenant must observe the schedule as missing");
        assertOpaqueSchedule(own);

        const otherList = schedulesOf(await b.list({ limit: 200 }));
        assert.equal(otherList.some((schedule) => schedule?.name === name), false);
      } finally {
        await a.delete(name).catch(() => {});
      }
    }, CRON_GATE);
  });

  it("supports pause/resume and idempotent manual triggers with a traceable run trail", async (t) => {
    if (!capabilityOrSkip(
      t,
      Boolean(INTERNAL_SECRET),
      "FIDUCIA_E2E_INTERNAL_SECRET is required",
      CRON_GATE,
    )) return;
    const org = uniqueId("cron-org");
    const name = uniqueId("cron-trail");
    const service = new CronNodeService(internalClient(org));

    await skipIfUndeployed(t, "cron lifecycle and run history", async () => {
      try {
        await service.upsert(name, {
          cron: "0 0 0 1 1 * *",
          target: { kind: "function", function_id: uniqueId("missing-function") },
          delivery: "at_least_once",
          maxRetries: 0,
        });
        await service.pause(name);
        assert.equal(output(await service.get(name))?.schedule?.enabled, false);
        await service.resume(name, { catchUp: false });
        assert.equal(output(await service.get(name))?.schedule?.enabled, true);

        const fireIdMs = Date.now();
        await service.trigger(name, { fireIdMs });
        await service.trigger(name, { fireIdMs });
        const matching = await eventuallyHistory(service, name, fireIdMs);
        if (!capabilityOrSkip(
          t,
          matching.length > 0,
          "schedule runner did not record the manual run within ten seconds",
          CRON_GATE,
        )) return;
        assert.equal(matching.length, 1, "the same manual fire identity must produce one logical run");

        const run = matching[0];
        assert.equal(run.fire_id_ms, fireIdMs);
        assert.ok(Number.isInteger(run.attempts) && run.attempts >= 0);
        assert.ok(Number.isInteger(run.duration_ms) && run.duration_ms >= 0);
        assert.equal(Object.hasOwn(run, "error_class"), true);
        assert.equal(Object.hasOwn(run, "http_status"), true);
        assert.equal(Object.hasOwn(run, "trace_id"), true);
        assert.equal(Object.hasOwn(run, "span_id"), true);
        if (run.trace_id !== null) assert.match(run.trace_id, /^[0-9a-f]{32}$/);
        if (run.span_id !== null) assert.match(run.span_id, /^[0-9a-f]{16}$/);
        assertOpaqueSchedule(run);
        assert.equal(JSON.stringify(run).includes(INTERNAL_SECRET), false);
      } finally {
        await service.delete(name).catch(() => {});
      }
    }, CRON_GATE);
  });
});

describe("managed cron function lifecycle", () => {
  it("keeps definitions tenant-scoped and links only the opaque UUID into a schedule", async (t) => {
    if (!LAMBDA_URL || !LAMBDA_SECRET) {
      if (CRON_STRICT) assert.fail("strict cron proof requires the lambda-service URL and auth secret");
      t.skip("set FIDUCIA_E2E_LAMBDA_SERVICE_URL and FIDUCIA_E2E_LAMBDA_SERVER_AUTH_SECRET");
      return;
    }

    const orgA = uniqueId("function-org-a");
    const orgB = uniqueId("function-org-b");
    const functionA = new CronFunctionService(LAMBDA_URL, {
      serverAuth: LAMBDA_SECRET,
      orgId: orgA,
    });
    const functionB = new CronFunctionService(LAMBDA_URL, {
      serverAuth: LAMBDA_SECRET,
      orgId: orgB,
    });
    let functionId;
    let schedule;

    try {
      const created = await functionA.create({
        slug: uniqueId("daily-rollup"),
        displayName: "E2E daily rollup",
        description: "Ephemeral conformance definition",
        runtime: "nodejs",
        functionBody: "return { ok: true, request };",
        maxRunMs: 15_000,
        labels: ["e2e", "cron"],
        metaData: { suite: "fiducia-e2e" },
      });
      functionId = created?.function?.id;
      assert.match(functionId, /^[0-9a-f-]{36}$/i);
      assert.equal(created.function.status, "draft");

      await expectCronError(functionB.get(functionId), 404);
      assert.equal(
        (await functionB.list({ limit: 10 }))?.functions?.some((entry) => entry?.id === functionId),
        false,
      );

      const checked = await functionA.check(functionId, {
        traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      });
      assert.equal(checked?.function?.status, "active");
      const invoked = await functionA.invoke(
        functionId,
        { probe: "cron-e2e" },
        { idempotencyKey: uniqueId("invoke") },
      );
      assert.equal(invoked?.ok, true);

      if (!NO_ENDPOINT && INTERNAL_SECRET) {
        const node = new CronNodeService(internalClient(orgA));
        schedule = uniqueId("function-schedule");
        await node.upsert(schedule, {
          cron: "0 0 0 1 1 * *",
          target: { kind: "function", function_id: functionId },
          delivery: "at_least_once",
          maxRetries: 0,
        });
        const stored = output(await node.get(schedule));
        assert.equal(stored?.schedule?.target?.function_id, functionId);
        assertOpaqueSchedule(stored);
      }

      await functionA.pause(functionId);
      await expectCronError(
        functionA.invoke(functionId, { probe: "paused" }, { idempotencyKey: uniqueId("paused") }),
        404,
      );
    } catch (error) {
      if (error instanceof CronServiceError && [404, 501, 503].includes(error.status) && !CRON_STRICT) {
        t.skip(`managed cron function service is not deployable on this target (HTTP ${error.status})`);
        return;
      }
      throw error;
    } finally {
      if (schedule && !NO_ENDPOINT && INTERNAL_SECRET) {
        await new CronNodeService(internalClient(orgA)).delete(schedule).catch(() => {});
      }
      if (functionId) await functionA.delete(functionId).catch(() => {});
    }
  });
});
