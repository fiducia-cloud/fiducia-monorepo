// Conformance: reader-writer locks.
//
// Real-world framing: cache-stampede prevention (many readers, one rebuilder),
// coordinated config reload, backup consistency (writer excludes readers).
// Invariant: multiple readers may hold concurrently; a writer is exclusive
// against both readers and other writers.
//
// NOTE: PROTOCOL.md lists reader-writer locks as a CLIENT EXTENSION whose routes
// "the current node runtime does not expose yet". So on a live node these routes
// may 404 — skipIfUndeployed records that as a skip rather than a failure.
// Routes/bodies follow the PROTOCOL.md "Reader-writer locks" table verbatim.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { output } from "../../src/client.mjs";
import { makeClient } from "../../src/endpoints.mjs";
import { NO_ENDPOINT, uniqueKey, skipIfUndeployed } from "../helpers.mjs";

const TTL = 30_000;

// Read the acquired flag defensively: PROTOCOL shows {acquired, fencing_token,
// lock_id}. VERIFY against PROTOCOL.md once rw-locks ship in the node runtime.
function acquired(res) {
  const o = output(res);
  return o?.acquired ?? o?.granted ?? false;
}
function lockId(res) {
  const o = output(res);
  return o?.lock_id ?? o?.lockId;
}

describe("reader-writer locks", { skip: NO_ENDPOINT }, () => {
  it("multiple readers may hold concurrently", async (t) => {
    const c = makeClient();
    const key = uniqueKey("rw-readers");

    await skipIfUndeployed(t, "POST /v1/rw/{key}/read", async () => {
      const r1 = await c.rwAcquireRead(key, { ttlMs: TTL, wait: false });
      assert.equal(acquired(r1), true, "first reader should acquire");
      const r2 = await c.rwAcquireRead(key, { ttlMs: TTL, wait: false });
      // WRONG BEHAVIOR => FAIL: readers must not exclude each other.
      assert.equal(acquired(r2), true, "concurrent second reader should also acquire");
      await c.rwEndRead(key, lockId(r1));
      await c.rwEndRead(key, lockId(r2));
    });
  });

  it("a writer excludes readers (and vice-versa)", async (t) => {
    const c = makeClient();
    const key = uniqueKey("rw-exclusive");

    await skipIfUndeployed(t, "POST /v1/rw/{key}/write", async () => {
      const w = await c.rwAcquireWrite(key, { ttlMs: TTL, wait: false });
      assert.equal(acquired(w), true, "writer should acquire on a free key");

      // WRONG BEHAVIOR => FAIL: a held write lock must exclude readers.
      const r = await c.rwAcquireRead(key, { ttlMs: TTL, wait: false });
      assert.notEqual(acquired(r), true, "reader must be blocked while a writer holds the lock");

      await c.rwEndWrite(key, lockId(w));

      // After the writer releases, a reader can proceed; that reader then
      // excludes a new writer.
      const r2 = await c.rwAcquireRead(key, { ttlMs: TTL, wait: false });
      assert.equal(acquired(r2), true, "reader should acquire once the writer released");
      const w2 = await c.rwAcquireWrite(key, { ttlMs: TTL, wait: false });
      assert.notEqual(acquired(w2), true, "writer must be blocked while a reader holds the lock");
      await c.rwEndRead(key, lockId(r2));
    });
  });
});
