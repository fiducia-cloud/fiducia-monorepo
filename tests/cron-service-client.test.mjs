import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertOpaqueSchedule,
  CronFunctionService,
  CronNodeService,
  CronServiceError,
  forbiddenReplicatedFields,
} from "../src/cron-service.mjs";

function response(body, status = 200, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("CronNodeService", () => {
  it("builds the tenant-scoped CRUD, lifecycle, trigger, and history routes", async () => {
    const calls = [];
    const service = new CronNodeService({
      async request(method, path, body) {
        calls.push({ method, path, body });
        return { ok: true };
      },
    });

    await service.list({ cursor: "alpha/beta", limit: 25 });
    await service.upsert("daily rollup", {
      cron: "0 4 * * *",
      target: { kind: "function", function_id: "c4db3dd2-19dc-4ca1-8ee4-e20d4d91c990" },
      delivery: "at_least_once",
      maxRetries: 4,
    });
    await service.get("daily rollup");
    await service.pause("daily rollup");
    await service.resume("daily rollup", { catchUp: true });
    await service.trigger("daily rollup", { fireIdMs: 1_725_000_000_000 });
    await service.history("daily rollup", { limit: 75 });
    await service.delete("daily rollup");

    assert.deepEqual(calls.map(({ method }) => method), [
      "GET", "PUT", "GET", "POST", "POST", "POST", "GET", "DELETE",
    ]);
    assert.equal(calls[0].path, "/v1/cron/schedules?cursor=alpha%2Fbeta&limit=25");
    assert.equal(calls[1].path, "/v1/cron/schedules/daily%20rollup");
    assert.deepEqual(calls[1].body.target, {
      kind: "function",
      function_id: "c4db3dd2-19dc-4ca1-8ee4-e20d4d91c990",
    });
    assert.equal(calls[4].path, "/v1/cron/schedules/daily%20rollup/resume?catch_up=true");
    assert.equal(
      calls[5].path,
      "/v1/cron/schedules/daily%20rollup/trigger?fire_id_ms=1725000000000",
    );
    assert.equal(calls[6].path, "/v1/cron/schedules/daily%20rollup/history?limit=75");
  });

  it("rejects source, secrets, payloads, and execution policy in replicated targets", () => {
    const service = new CronNodeService({ request() { throw new Error("not reached"); } });
    assert.throws(
      () => service.upsert("unsafe", {
        cron: "0 * * * *",
        target: {
          kind: "function",
          function_id: "opaque-id",
          functionBody: "return process.env",
        },
      }),
      /sensitive fields.*functionBody/,
    );
    assert.throws(
      () => assertOpaqueSchedule({ target: { payload: { secret: "do-not-store" } } }),
      /payload.*secret/,
    );
    assert.deepEqual(
      forbiddenReplicatedFields({ history: [{ error_class: "timeout", trace_id: "a".repeat(32) }] }),
      [],
    );
  });
});

describe("CronFunctionService", () => {
  it("rebuilds trusted headers and never forwards browser credentials", async () => {
    const seen = [];
    const fetchImpl = async (url, options) => {
      seen.push({ url: String(url), options });
      return response({ ok: true, function: { id: "fn-1", status: "draft" } }, 201);
    };
    const service = new CronFunctionService("https://lambda.example.test", {
      serverAuth: "service-secret",
      orgId: "org-a",
      fetch: fetchImpl,
    });
    const traceparent = `00-${"1".repeat(32)}-${"2".repeat(16)}-01`;
    await service.create({
      slug: "daily-rollup",
      displayName: "Daily rollup",
      runtime: "nodejs",
      functionBody: "return { ok: true };",
    }, { traceparent });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://lambda.example.test/v1/functions");
    assert.equal(seen[0].options.redirect, "manual");
    const headers = seen[0].options.headers;
    assert.equal(headers.get("x-server-auth"), "service-secret");
    assert.equal(headers.get("x-fiducia-org-id"), "org-a");
    assert.equal(headers.get("traceparent"), traceparent);
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("cookie"), false);
    assert.equal(JSON.parse(seen[0].options.body).runtime, "nodejs");
  });

  it("adds an invocation idempotency key without exposing it in errors", async () => {
    const seen = [];
    const fetchImpl = async (url, options) => {
      seen.push({ url: String(url), options });
      return response({ error: "postgres://user:password@db/private failure" }, 503);
    };
    const service = new CronFunctionService("https://lambda.example.test", {
      serverAuth: "service-secret",
      orgId: "org-a",
      fetch: fetchImpl,
    });

    await assert.rejects(
      () => service.invoke("abc/def", { requestedBy: "cron" }, { idempotencyKey: "run-123" }),
      (error) => {
        assert.ok(error instanceof CronServiceError);
        assert.equal(error.status, 503);
        assert.equal(error.path, "/invoke/abc%2Fdef");
        assert.equal(error.message.includes("password"), false);
        return true;
      },
    );
    assert.equal(seen[0].options.headers.get("idempotency-key"), "run-123");
  });

  it("rejects redirects, invalid trace context, and oversized responses", async () => {
    const redirecting = new CronFunctionService("https://lambda.example.test", {
      serverAuth: "service-secret",
      orgId: "org-a",
      fetch: async () => new Response(null, { status: 307, headers: { location: "https://evil.test" } }),
    });
    await assert.rejects(() => redirecting.list(), /redirect_rejected/);
    await assert.rejects(
      () => redirecting.get("fn-1", { traceparent: "not-a-trace" }),
      /traceparent is invalid/,
    );

    const oversized = new CronFunctionService("https://lambda.example.test", {
      serverAuth: "service-secret",
      orgId: "org-a",
      maxResponseBytes: 16,
      fetch: async () => new Response("x".repeat(17), { status: 200 }),
    });
    await assert.rejects(() => oversized.list(), /response_too_large/);
  });
});
