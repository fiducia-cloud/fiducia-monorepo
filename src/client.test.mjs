import assert from "node:assert/strict";
import test from "node:test";

import { FiduciaClient, HttpError } from "./client.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("handoff and budget methods preserve their HTTP wire contracts", async () => {
  const calls = [];
  const client = new FiduciaClient("https://api.example.test/", {
    apiKey: "test-api-key",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ committed: true });
    },
  });

  await client.handoffOffer({
    name: "handoff/a b",
    resource: "lock/a",
    from: "worker-a",
    to: "worker-b",
    fromToken: 9,
    ttlMs: 5_000,
  });
  await client.budgetReserve({
    name: "tenant/alpha",
    reservationId: "reservation 1",
    holder: "worker-a",
    amount: 17,
  });

  assert.equal(calls.length, 2);
  const handoff = calls[0];
  assert.equal(handoff.url, "https://api.example.test/v1/handoffs/offer");
  assert.equal(handoff.init.method, "POST");
  assert.equal(new Headers(handoff.init.headers).get("authorization"), "Bearer test-api-key");
  assert.deepEqual(JSON.parse(handoff.init.body), {
    name: "handoff/a b",
    resource: "lock/a",
    from: "worker-a",
    to: "worker-b",
    from_token: 9,
    ttl_ms: 5_000,
  });

  const budget = calls[1];
  assert.equal(budget.url, "https://api.example.test/v1/budgets/reserve");
  assert.deepEqual(JSON.parse(budget.init.body), {
    name: "tenant/alpha",
    reservation_id: "reservation 1",
    holder: "worker-a",
    amount: 17,
  });
});

test("request preserves a non-JSON HTTP error for conformance diagnostics", async () => {
  const client = new FiduciaClient("https://api.example.test", {
    fetch: async () => new Response("upstream unavailable", { status: 503 }),
  });

  await assert.rejects(
    () => client.health(),
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 503);
      assert.equal(error.path, "/healthz");
      assert.equal(error.body, "upstream unavailable");
      return true;
    },
  );
});

test("lock and semaphore renew/cancel helpers use token-bound wire contracts", async () => {
  const calls = [];
  const client = new FiduciaClient("https://api.example.test", {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ committed: true });
    },
  });
  await client.lockRenew("deploy/main", {
    holder: "worker-a",
    fencingToken: 41,
    ttlMs: 60_000,
  });
  await client.lockRenewMany({
    keys: ["deploy/main", "migration/main"],
    holder: "worker-a",
    fencingToken: 41,
    ttlMs: 60_000,
  });
  await client.lockCancel("deploy/next", { holder: "worker-c", requestId: "lock-attempt-1" });
  await client.semaphoreRenew("gpu/pool", {
    holder: "worker-b",
    fencingToken: 72,
    ttlMs: 60_000,
  });
  await client.semaphoreCancel("gpu/pool", {
    holder: "worker-d",
    requestId: "semaphore-attempt-1",
  });

  assert.deepEqual(calls.map((call) => [call.url, JSON.parse(call.init.body)]), [
    ["https://api.example.test/v1/locks/renew", {
      key: "deploy/main", holder: "worker-a", fencing_token: 41, ttl_ms: 60_000,
    }],
    ["https://api.example.test/v1/locks/renew", {
      keys: ["deploy/main", "migration/main"],
      holder: "worker-a",
      fencing_token: 41,
      ttl_ms: 60_000,
    }],
    ["https://api.example.test/v1/locks/cancel", {
      key: "deploy/next", holder: "worker-c", request_id: "lock-attempt-1",
    }],
    ["https://api.example.test/v1/semaphores/renew", {
      key: "gpu/pool", holder: "worker-b", fencing_token: 72, ttl_ms: 60_000,
    }],
    ["https://api.example.test/v1/semaphores/cancel", {
      key: "gpu/pool", holder: "worker-d", request_id: "semaphore-attempt-1",
    }],
  ]);
});

test("lock and semaphore acquire/cancel helpers preserve attempt request IDs", async () => {
  const calls = [];
  const client = new FiduciaClient("https://api.example.test", {
    fetch: async (url, init) => {
      calls.push([url, JSON.parse(init.body)]);
      return jsonResponse({ committed: true });
    },
  });

  await client.tryLock("deploy/main", {
    holder: "worker-a",
    ttlMs: 30_000,
    requestId: "lock-attempt-a",
  });
  await client.lockMany({
    keys: ["deploy/main", "migration/main"],
    holder: "worker-b",
    ttlMs: 30_000,
    requestId: "lock-attempt-b",
  });
  await client.lockCancelMany({
    keys: ["deploy/main", "migration/main"],
    holder: "worker-b",
    requestId: "lock-attempt-b",
  });
  await client.semaphoreAcquire("gpu/pool", {
    holder: "worker-c",
    ttlMs: 30_000,
    limit: 2,
    requestId: "semaphore-attempt-c",
  });

  assert.deepEqual(calls.map(([url, body]) => [url, body.request_id]), [
    ["https://api.example.test/v1/locks/acquire", "lock-attempt-a"],
    ["https://api.example.test/v1/locks/acquire", "lock-attempt-b"],
    ["https://api.example.test/v1/locks/cancel", "lock-attempt-b"],
    ["https://api.example.test/v1/semaphores/acquire", "semaphore-attempt-c"],
  ]);
});

test("redirect failover is explicit rather than reread from legacy endpoint env", async () => {
  const calls = [];
  const client = new FiduciaClient("https://one.example.test", {
    failoverEndpoints: ["https://one.example.test", "https://two.example.test/"],
    fetch: async (url) => {
      calls.push(url);
      return url.startsWith("https://one.example.test")
        ? new Response(null, { status: 307 })
        : jsonResponse({ ok: true });
    },
  });
  assert.deepEqual(await client.health(), { ok: true });
  assert.deepEqual(calls, [
    "https://one.example.test/healthz",
    "https://two.example.test/healthz",
  ]);
});

test("kvWatch parses chunked CRLF SSE and carries authorization", async () => {
  // This test pins the LB-fronted header contract (Bearer only). Clear the
  // direct-to-node env so running the suite against a kind tier (which exports
  // FIDUCIA_E2E_INTERNAL_SECRET) doesn't leak trusted-hop headers in here.
  const savedSecret = process.env.FIDUCIA_E2E_INTERNAL_SECRET;
  const savedOrg = process.env.FIDUCIA_E2E_ORG_ID;
  delete process.env.FIDUCIA_E2E_INTERNAL_SECRET;
  delete process.env.FIDUCIA_E2E_ORG_ID;
  try {
  const chunks = [
    ': keepalive\r\nid: 7\r\nevent: change\r\ndata: {"revision":',
    "2}\r\n\r\n",
    "event: note\ndata: hello\n",
    "data: world\n\n",
  ];
  let request;
  const client = new FiduciaClient("https://api.example.test", {
    apiKey: "test-api-key",
    fetch: async (url, init) => {
      request = { url, init };
      let offset = 0;
      const stream = new ReadableStream({
        pull(controller) {
          if (offset < chunks.length) {
            controller.enqueue(new TextEncoder().encode(chunks[offset++]));
          } else {
            controller.close();
          }
        },
      });
      return new Response(stream, { status: 200 });
    },
  });

  const events = [];
  for await (const event of client.kvWatch("team/a key")) events.push(event);

  assert.equal(request.url, "https://api.example.test/v1/kv?key=team%2Fa%20key&watch=true");
  assert.equal(request.init.method, "GET");
  assert.deepEqual(request.init.headers, {
    accept: "text/event-stream",
    authorization: "Bearer test-api-key",
  });
  assert.deepEqual(events, [
    { event: "change", id: "7", data: { revision: 2 } },
    { event: "note", id: undefined, data: "hello\nworld" },
  ]);
  } finally {
    if (savedSecret !== undefined) process.env.FIDUCIA_E2E_INTERNAL_SECRET = savedSecret;
    if (savedOrg !== undefined) process.env.FIDUCIA_E2E_ORG_ID = savedOrg;
  }
});

test("client base and failover endpoints enforce the same HTTPS policy", () => {
  assert.throws(
    () => new FiduciaClient("http://api.example.test", { apiKey: "test-api-key" }),
    /require HTTPS/,
  );
  assert.throws(
    () => new FiduciaClient("https://api.example.test", {
      apiKey: "test-api-key",
      failoverEndpoints: ["http://failover.example.test"],
    }),
    /require HTTPS/,
  );
});
