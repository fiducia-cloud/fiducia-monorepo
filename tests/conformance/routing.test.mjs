// Conformance: key → shard routing (the fiducia-routing.rs contract, observed
// end-to-end through the deployed HTTP surface).
//
// Real-world framing: every component — edge, LB, node, brain — must map a key
// to the SAME shard, or the cluster splits its brain (a lock acquired on one
// shard while its releaser talks to another). The mapping is frozen in
// fiducia-routing.rs: FNV-1a(key) % shard_count, plus two reserved coordinator
// keys for locks/semaphores and service discovery.
//
// This file asserts that contract two ways:
//   1. Hash pins (no endpoint needed): the local JS FNV-1a mirror reproduces
//      the same published vectors and coordinator pins as the Rust crate's
//      golden tests — the cross-LANGUAGE anchor. If these fail, this suite is
//      not hashing what the cluster hashes.
//   2. Deployed agreement (endpoint-gated): every mutating op's envelope
//      reports the shard that committed it (`result.shard`); it must equal
//      what the frozen hash predicts from `/v1/status`'s shard_count — the
//      cross-PROCESS anchor, through the real edge/LB/node path.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { endpoints, makeClient } from "../../src/endpoints.mjs";
import { NO_ENDPOINT, uniqueKey, uniqueId, skipIfUndeployed } from "../helpers.mjs";

// ---------------------------------------------------------------------------
// JS mirror of fiducia-routing.rs. Frozen: change nothing here without also
// changing the Rust crate's golden vectors (which is a data migration).
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();

/** FNV-1a 32-bit over the key's UTF-8 bytes (fiducia-routing.rs `fnv1a`). */
function fnv1a(key) {
  let hash = 0x811c9dc5;
  for (const byte of utf8.encode(key)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** fiducia-routing.rs `shard_for`. */
function shardFor(key, shardCount) {
  assert.ok(shardCount > 0, "shard_count must be > 0");
  return fnv1a(key) % shardCount;
}

// Reserved coordinator keys (leading NUL keeps them out of the user keyspace).
const LOCK_COORDINATION_KEY = "\u0000fiducia-lock-coordinator";
const SERVICE_DISCOVERY_KEY = "\u0000fiducia-service-discovery";

/** Shard that committed a mutation, from the `{committed,result}` envelope. */
function shardOf(res) {
  const shard = res?.result?.shard ?? res?.shard;
  return Number.isInteger(shard) ? shard : undefined;
}

// ---------------------------------------------------------------------------
// 1. Hash pins — always run; they need no deployment.
// ---------------------------------------------------------------------------

describe("routing hash pins (cross-language anchor)", () => {
  it("reproduces the published FNV-1a reference vectors", () => {
    // Same vectors as fiducia-routing.rs `fnv1a_matches_published_reference_vectors`.
    assert.equal(fnv1a(""), 0x811c9dc5);
    assert.equal(fnv1a("a"), 0xe40c292c);
    assert.equal(fnv1a("b"), 0xe70c2de5);
    assert.equal(fnv1a("foobar"), 0xbf9cf968);
    assert.equal(fnv1a("hello"), 0x4f9f2cab);
    assert.equal(fnv1a("orders/checkout"), 0xd2176c9d);
  });

  it("reproduces the Rust crate's shard_for golden vectors", () => {
    // Same as fiducia-routing.rs `golden_vectors` (shard_count = 8).
    assert.equal(shardFor("checkout", 8), 1);
    assert.equal(shardFor("orders", 8), 4);
    assert.equal(shardFor("orders/checkout", 8), 5);
  });

  it("pins the coordinator shards at deployed shard counts", () => {
    // Same as fiducia-routing.rs `coordination_shards_are_pinned_at_deployed_shard_counts`.
    assert.equal(shardFor(LOCK_COORDINATION_KEY, 16), 15);
    assert.equal(shardFor(LOCK_COORDINATION_KEY, 8), 7);
    assert.equal(shardFor(LOCK_COORDINATION_KEY, 256), 223);
    assert.equal(shardFor(SERVICE_DISCOVERY_KEY, 16), 9);
    assert.equal(shardFor(SERVICE_DISCOVERY_KEY, 8), 1);
    assert.equal(shardFor(SERVICE_DISCOVERY_KEY, 256), 233);
  });
});

// ---------------------------------------------------------------------------
// 2. Deployed agreement — the cluster must route like the frozen hash says.
//
// One org-scoping subtlety: the node commits an org-owned key under its SCOPED
// form (`{org}{key}` — fiducia_routing::org_scoped_key), so the
// exact shard depends on the caller's org id. Coordinator routes (locks,
// semaphores, service discovery) use cluster-reserved keys and stay exactly
// predictable for every caller. For org-owned keys the suite always checks
// bounds + stability, and checks the exact scoped hash when the operator says
// which org the configured credential belongs to (FIDUCIA_E2E_ORG_ID).
// ---------------------------------------------------------------------------

/** fiducia-routing.rs `org_scoped_key`: the key the node actually hashes. */
function orgScopedKey(orgId, key) {
  return `${orgId}${key}`;
}

/** The org the configured credential resolves to, when the operator knows it. */
const ORG_ID = process.env.FIDUCIA_E2E_ORG_ID || undefined;

/** shard_count from /v1/status, or undefined when the endpoint hides it. */
async function shardCountOf(client) {
  const status = await client.status();
  const count = status?.consensus?.shard_count ?? status?.shard_count;
  return Number.isInteger(count) && count > 0 ? count : undefined;
}

describe("deployed cluster routes keys like the frozen hash", { skip: NO_ENDPOINT }, () => {
  it("KV writes commit on a stable, in-range shard (exact hash when the org is known)", async (t) => {
    const c = makeClient();
    await skipIfUndeployed(t, "GET /v1/status + PUT /v1/kv", async () => {
      const shardCount = await shardCountOf(c);
      if (!shardCount) {
        t.skip("endpoint does not expose consensus.shard_count");
        return;
      }
      let sawShard = false;
      for (let i = 0; i < 5; i++) {
        const key = uniqueKey(`routing-kv-${i}`);
        const first = await c.kvPut(key, "route-check");
        const shard = shardOf(first);
        if (shard === undefined) continue; // envelope doesn't carry the shard
        sawShard = true;
        assert.ok(shard < shardCount, `shard ${shard} out of range (< ${shardCount})`);
        if (ORG_ID) {
          // WRONG BEHAVIOR => FAIL: the deployed path must hash the org-scoped
          // key exactly like fiducia-routing.rs, or clients and the cluster
          // disagree where a key lives.
          assert.equal(
            shard,
            shardFor(orgScopedKey(ORG_ID, key), shardCount),
            `key ${key} (org ${ORG_ID}) committed on shard ${shard}, hash says ${shardFor(orgScopedKey(ORG_ID, key), shardCount)}`,
          );
        }
        // Same key, same shard — routing is a pure function of (org, key, count).
        const again = await c.kvPut(key, "route-check-2");
        assert.equal(shardOf(again), shard, "re-writing a key must hit the same shard");
      }
      if (!sawShard) t.skip("mutation envelope does not report result.shard on this build");
    });
  });

  it("every lock and semaphore op lands on the single lock-coordinator shard", async (t) => {
    const c = makeClient();
    await skipIfUndeployed(t, "POST /v1/locks/acquire + /v1/semaphores/acquire", async () => {
      const shardCount = await shardCountOf(c);
      if (!shardCount) {
        t.skip("endpoint does not expose consensus.shard_count");
        return;
      }
      const coordinator = shardFor(LOCK_COORDINATION_KEY, shardCount);

      const seen = [];
      for (let i = 0; i < 3; i++) {
        const res = await c.tryLock(uniqueKey(`routing-lock-${i}`), {
          holder: uniqueId("holder"),
          ttlMs: 5_000,
        });
        const shard = shardOf(res);
        if (shard !== undefined) seen.push(shard);
      }
      const sem = await c.semaphoreAcquire(uniqueKey("routing-sem"), {
        holder: uniqueId("holder"),
        ttlMs: 5_000,
        limit: 2,
      });
      if (shardOf(sem) !== undefined) seen.push(shardOf(sem));

      if (seen.length === 0) {
        t.skip("mutation envelope does not report result.shard on this build");
        return;
      }
      // WRONG BEHAVIOR => FAIL: union locks are only atomic because every
      // lock/semaphore op meets in ONE state machine. A stray shard here means
      // two "exclusive" holders can coexist.
      for (const shard of seen) {
        assert.equal(
          shard,
          coordinator,
          `lock-family op committed on shard ${shard}; coordinator is ${coordinator}`,
        );
      }
    });
  });

  it("service registrations land on the discovery-coordinator shard", async (t) => {
    const c = makeClient();
    await skipIfUndeployed(t, "POST /v1/services (register)", async () => {
      const shardCount = await shardCountOf(c);
      if (!shardCount) {
        t.skip("endpoint does not expose consensus.shard_count");
        return;
      }
      const res = await c.serviceRegister(
        `e2e-routing-${uniqueId("svc")}`,
        uniqueId("inst"),
        "http://127.0.0.1:1",
        5_000,
      );
      const shard = shardOf(res);
      if (shard === undefined) {
        t.skip("mutation envelope does not report result.shard on this build");
        return;
      }
      assert.equal(
        shard,
        shardFor(SERVICE_DISCOVERY_KEY, shardCount),
        "discovery must meet in one registry shard or GET /v1/services loses linearizability",
      );
    });
  });

  it("all configured clusters agree on the mapping (same shard_count ⇒ same shard)", async (t) => {
    const urls = endpoints();
    if (urls.length < 2) {
      t.skip("multi-cluster agreement needs FIDUCIA_E2E_ENDPOINTS with 2+ URLs");
      return;
    }
    await skipIfUndeployed(t, "GET /v1/status across clusters", async () => {
      const key = uniqueKey("routing-cross-cluster");
      const mapped = new Map(); // shard_count -> Set<shard>
      for (const url of urls) {
        const c = makeClient(url);
        const shardCount = await shardCountOf(c);
        if (!shardCount) continue;
        const res = await c.kvPut(key, "cross-cluster");
        const shard = shardOf(res);
        if (shard === undefined) continue;
        assert.equal(shard, shardFor(key, shardCount), `cluster ${url} disagrees with the hash`);
        if (!mapped.has(shardCount)) mapped.set(shardCount, new Set());
        mapped.get(shardCount).add(shard);
      }
      // Clusters with the SAME shard_count must map the key identically —
      // that is the whole reason the routing crate exists.
      for (const [count, shards] of mapped) {
        assert.equal(shards.size, 1, `clusters with shard_count=${count} split the key: ${[...shards]}`);
      }
      if (mapped.size === 0) t.skip("no cluster exposed both shard_count and result.shard");
    });
  });
});
