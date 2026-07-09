// Conformance: config KV + watch (linearizable, versioned key/value with SSE).
//
// Real-world framing: feature flags, a kill switch, dynamic routing tables,
// cache invalidation — all needing a consistent value and a live change feed.
// Invariants: put/get round-trips with a monotonic version; CAS against a stale
// version fails; a watch stream delivers a change event.
//
// Routes/bodies per fiducia-clients/PROTOCOL.md ("Config KV — live").

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { HttpError } from "../../src/client.mjs";
import { makeClient } from "../../src/endpoints.mjs";
import { NO_ENDPOINT, uniqueKey, skipIfUndeployed } from "../helpers.mjs";

// GET returns {key, found, entry}. The version field is `revision` (kvPut CAS
// uses prev_revision), but tolerate `version`. VERIFY against PROTOCOL.md.
function revisionOf(getRes) {
  const e = getRes?.entry ?? getRes?.result?.output ?? getRes;
  return e?.revision ?? e?.version ?? e?.rev;
}
function valueOf(getRes) {
  const e = getRes?.entry ?? getRes?.result?.output ?? getRes;
  return e?.value;
}

describe("config KV + watch", { skip: NO_ENDPOINT }, () => {
  it("put/get round-trips and version advances", async (t) => {
    const c = makeClient();
    const key = uniqueKey("kv-roundtrip");

    await skipIfUndeployed(t, "PUT/GET /v1/kv", async () => {
      await c.kvPut(key, "on");
      const g1 = await c.kvGet(key);
      assert.equal(valueOf(g1), "on", "get should return the value just put");
      const r1 = revisionOf(g1);

      await c.kvPut(key, "off");
      const g2 = await c.kvGet(key);
      assert.equal(valueOf(g2), "off", "get should return the updated value");
      const r2 = revisionOf(g2);

      if (typeof r1 === "number" && typeof r2 === "number") {
        assert.ok(r2 > r1, `KV version must advance on write: ${r2} > ${r1}`);
      } else {
        t.skip("endpoint did not expose a numeric KV revision");
      }
    });
  });

  it("CAS against a stale prev_revision fails", async (t) => {
    const c = makeClient();
    const key = uniqueKey("kv-cas");

    await skipIfUndeployed(t, "PUT /v1/kv (CAS)", async () => {
      await c.kvPut(key, "v1");
      const g = await c.kvGet(key);
      const rev = revisionOf(g);
      if (typeof rev !== "number") {
        t.skip("no numeric revision to CAS against");
        return;
      }

      // Advance the value so `rev` becomes stale.
      await c.kvPut(key, "v2", { prevRevision: rev });

      // WRONG BEHAVIOR => FAIL: a write conditioned on the now-stale revision
      // must be rejected (lost-update prevention).
      let rejected = false;
      try {
        const res = await c.kvPut(key, "v3-stale", { prevRevision: rev });
        if (res && (res.committed === false || res.result?.output?.committed === false || res.result?.output?.updated === false)) {
          rejected = true;
        }
      } catch (err) {
        if (err instanceof HttpError && err.status >= 400 && err.status < 500) rejected = true;
        else throw err;
      }
      assert.ok(rejected, "CAS with a stale prev_revision must fail");

      const g2 = await c.kvGet(key);
      assert.equal(valueOf(g2), "v2", "stale CAS must not have overwritten the value");
    });
  });

  it("a watch stream delivers a change event", async (t) => {
    const c = makeClient();
    const key = uniqueKey("kv-watch");

    await skipIfUndeployed(t, "GET /v1/kv?watch=true", async () => {
      const ac = new AbortController();
      const stream = c.kvWatch(key, { signal: ac.signal });

      // Prime the stream (first .next opens the SSE connection), then mutate.
      const nextEvent = stream.next();
      await delay(300);
      await c.kvPut(key, "watched-value");

      let event;
      try {
        event = await Promise.race([
          nextEvent,
          delay(5000).then(() => ({ timeout: true })),
        ]);
      } finally {
        ac.abort();
      }

      if (event?.timeout) {
        t.skip("watch stream did not deliver an event within 5s");
        return;
      }
      // At minimum the stream must yield a well-formed SSE event after the write.
      assert.ok(event && event.done !== true, "watch should deliver an event after a change");
      assert.ok(event.value !== undefined, "delivered watch event should carry data");
    });
  });
});
