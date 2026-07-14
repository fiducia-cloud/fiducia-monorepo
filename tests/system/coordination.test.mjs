// System: the real coordination composition — 3× fiducia-node (durable, Raft)
// behind 1× fiducia-load-balance, built from sibling checkouts and driven over
// real HTTP on localhost.
//
// What this layer proves that neither unit tests nor deployed conformance can:
//   * the LB and the node cluster agree on key → shard routing END TO END
//     (the fiducia-routing.rs contract, through two independent binaries);
//   * the trusted-hop internal secret composes (LB injects, nodes enforce);
//   * a member crash keeps the service available (quorum), and the crashed
//     member rejoins from its data dir and catches up — across log compaction,
//     so the InstallSnapshot path is exercised with real processes;
//   * lock fencing tokens stay strictly monotonic through all of the above.
//
// Opt-in and heavyweight: FIDUCIA_E2E_SYSTEM=1 (or `npm run test:system`).
// Tests are ORDERED — each stage builds on the cluster state of the previous.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { FiduciaClient, output } from "../../src/client.mjs";
import {
  bootCoordinationStack,
  coordinationSkipReason,
  INTERNAL_AUTH_HEADER,
  INTERNAL_SECRET,
} from "../../src/coordination.mjs";
import { uniqueId, uniqueKey } from "../helpers.mjs";

const SKIP = coordinationSkipReason();

// --- the frozen routing contract (mirrors fiducia-routing.rs) ---------------

const utf8 = new TextEncoder();
function fnv1a(key) {
  let hash = 0x811c9dc5;
  for (const byte of utf8.encode(key)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
const shardFor = (key, count) => fnv1a(key) % count;
const LOCK_COORDINATION_KEY = "\u0000fiducia-lock-coordinator";

// The org this suite acts as (via trusted-edge identity headers). The node
// commits org-owned keys under their SCOPED form (`\\u0001{org}\\u0001{key}` --
// fiducia_routing::org_scoped_key), so shard predictions must hash that.
const ORG = "e2e-system";
const orgScopedKey = (key) => `\u0001${ORG}\u0001${key}`;
const shardForOrgKey = (key, count) => shardFor(orgScopedKey(key), count);

// --- small helpers -----------------------------------------------------------

/** Retry `fn` until it stops throwing or the deadline passes. */
async function eventually(fn, { timeoutMs = 60_000, intervalMs = 250, label = "condition" } = {}) {
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
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}: ${lastError?.message ?? lastError}`);
}

/** Direct node `/v1/status` (the node plane enforces the internal secret). */
async function nodeStatus(nodeUrl) {
  const res = await fetch(`${nodeUrl}/v1/status`, {
    headers: { [INTERNAL_AUTH_HEADER]: INTERNAL_SECRET },
    signal: AbortSignal.timeout(3_000),
  });
  assert.ok(res.ok, `GET ${nodeUrl}/v1/status → HTTP ${res.status}`);
  return res.json();
}

const shardOf = (res) => res?.result?.shard;
const committed = (res) => res?.committed === true;

describe("coordination system: 3-node cluster behind the load balancer", { skip: SKIP, concurrency: 1 }, () => {
  /** @type {Awaited<ReturnType<typeof bootCoordinationStack>>} */
  let stack;
  /** @type {FiduciaClient} */
  let lb;
  let coordinatorShard;
  let fencingBeforeCrash;
  const contestedKey = uniqueKey("system-contested-lock");

  before(async () => {
    stack = await bootCoordinationStack({ shardCount: 4, compactThreshold: 16 });
    // Act as the trusted edge: present the shared secret plus a verified
    // identity (org + scopes) on every request, exactly as fiducia-edge does
    // after authenticating a customer. The LB checks the secret, adopts the
    // identity, enforces scopes, and injects the org toward the node.
    const edgeFetch = (url, init = {}) =>
      fetch(url, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          "x-fiducia-edge-auth": INTERNAL_SECRET,
          "x-fiducia-org-id": ORG,
          "x-fiducia-scopes": "*",
        },
      });
    lb = new FiduciaClient(stack.lbUrl, { fetch: edgeFetch });
    coordinatorShard = shardFor(LOCK_COORDINATION_KEY, stack.shardCount);
  }, { timeout: 900_000 }); // first run compiles two Rust workspaces

  after(async () => {
    await stack?.stop();
  }, { timeout: 120_000 });

  it("forms a full cluster: every shard elects exactly one leader across the members", { timeout: 120_000 }, async () => {
    await eventually(async () => {
      const statuses = await Promise.all(stack.nodeUrls.map(nodeStatus));
      const leaders = new Map(); // shard_id -> node_id[]
      for (const status of statuses) {
        assert.equal(status?.consensus?.shard_count, stack.shardCount, "shard_count agrees on every member");
        for (const shard of status.consensus.shards) {
          if (shard.role === "leader") {
            leaders.set(shard.shard_id, [...(leaders.get(shard.shard_id) ?? []), status.consensus.node_id]);
            assert.equal(shard.has_quorum, true, "a leader must hold quorum");
          }
        }
      }
      for (let shard = 0; shard < stack.shardCount; shard++) {
        const owners = leaders.get(shard) ?? [];
        assert.equal(owners.length, 1, `shard ${shard} must have exactly one leader, saw [${owners}]`);
      }
    }, { timeoutMs: 60_000, label: "one leader per shard" });
  });

  it("routes every key through the LB onto the shard the frozen hash predicts", { timeout: 120_000 }, async () => {
    for (let i = 0; i < 24; i++) {
      const key = uniqueKey(`system-routing-${i}`);
      // Failover-free steady state, but the LB may still be repairing its
      // shard→leader map on the first touches — retry until committed.
      const res = await eventually(() => lb.kvPut(key, `v-${i}`), { timeoutMs: 20_000, label: `kvPut ${key}` });
      assert.ok(committed(res), `write must commit: ${JSON.stringify(res)}`);
      assert.equal(
        shardOf(res),
        shardForOrgKey(key, stack.shardCount),
        `LB+node committed ${key} on shard ${shardOf(res)}; fiducia-routing says ${shardForOrgKey(key, stack.shardCount)}`,
      );
      const read = await eventually(() => lb.kvGet(key), { timeoutMs: 10_000, label: `kvGet ${key}` });
      assert.equal(read?.entry?.value, `v-${i}`, "read-your-write through the LB");
    }
  });

  it("coordinates every lock on the single coordinator shard with monotonic fencing", { timeout: 120_000 }, async () => {
    const holder1 = uniqueId("holder");
    const first = await eventually(
      () => lb.tryLock(contestedKey, { holder: holder1, ttlMs: 120_000 }),
      { timeoutMs: 20_000, label: "first lock acquire" },
    );
    assert.equal(output(first).acquired, true);
    assert.equal(shardOf(first), coordinatorShard, "lock ops must meet on the coordinator shard");
    const token1 = output(first).fencing_token;
    assert.ok(Number.isInteger(token1) && token1 > 0);

    // Contested try-lock loses without queueing.
    const holder2 = uniqueId("holder");
    const contest = await lb.tryLock(contestedKey, { holder: holder2, ttlMs: 120_000 });
    assert.equal(output(contest).acquired, false, "second holder must not steal a held lock");
    assert.equal(shardOf(contest), coordinatorShard);

    // Release → the next grant carries a STRICTLY higher fencing token.
    await lb.lockRelease(contestedKey, { holder: holder1, fencingToken: token1 });
    const second = await lb.tryLock(contestedKey, { holder: holder2, ttlMs: 120_000 });
    assert.equal(output(second).acquired, true, "released lock must be acquirable");
    const token2 = output(second).fencing_token;
    assert.ok(token2 > token1, `fencing must advance: ${token2} > ${token1}`);
    fencingBeforeCrash = { holder: holder2, token: token2 };
  });

  it("compacts each shard's log once writes cross the threshold", { timeout: 180_000 }, async () => {
    // Deterministically push ≥ threshold+4 writes into EVERY shard (bucket the
    // keys with the same hash the cluster uses).
    const perShard = new Array(stack.shardCount).fill(0);
    const target = stack.compactThreshold + 4;
    for (let i = 0; perShard.some((n) => n < target); i++) {
      assert.ok(i < 10_000, "key generation runaway");
      const key = uniqueKey(`system-compaction-${i}`);
      const shard = shardForOrgKey(key, stack.shardCount);
      if (perShard[shard] >= target) continue;
      const res = await eventually(() => lb.kvPut(key, "fill"), { timeoutMs: 20_000, label: `kvPut ${key}` });
      assert.ok(committed(res));
      perShard[shard] += 1;
    }
    // Every replica applies every committed entry, so every member's every
    // shard must eventually have folded its prefix into a snapshot.
    await eventually(async () => {
      for (const url of stack.nodeUrls) {
        const status = await nodeStatus(url);
        for (const shard of status.consensus.shards) {
          assert.ok(
            shard.snapshot_index > 0,
            `${status.consensus.node_id} shard ${shard.shard_id} never compacted (snapshot_index=${shard.snapshot_index}, log=${shard.last_log_index})`,
          );
          assert.ok(
            shard.retained_log_entries <= stack.compactThreshold * 2,
            `live log stays bounded (shard ${shard.shard_id}: ${shard.retained_log_entries} retained entries)`,
          );
        }
      }
    }, { timeoutMs: 60_000, label: "every shard compacted on every member" });
  });

  it("keeps serving writes through the LB while a member is down (quorum)", { timeout: 180_000 }, async () => {
    stack.crashNode(2); // SIGKILL — no graceful anything
    for (let i = 0; i < 8; i++) {
      const key = uniqueKey(`system-failover-${i}`);
      // Shards led by the dead member need an election; the LB needs redirect
      // repair. Both are bounded — writes must come back well inside the window.
      const res = await eventually(() => lb.kvPut(key, "post-crash"), {
        timeoutMs: 30_000,
        label: `kvPut ${key} during failover`,
      });
      assert.ok(committed(res));
      assert.equal(
        shardOf(res),
        shardForOrgKey(key, stack.shardCount),
        "routing agreement holds during failover",
      );
    }
  });

  it("a crashed member rejoins from disk and catches up past compacted history", { timeout: 240_000 }, async () => {
    // Push more history while the member is down so the survivors' logs (and
    // compaction bases) move past anything it still has on disk.
    for (let i = 0; i < 40; i++) {
      const res = await eventually(() => lb.kvPut(uniqueKey(`system-catchup-${i}`), "while-down"), {
        timeoutMs: 30_000,
        label: "kvPut while member down",
      });
      assert.ok(committed(res));
    }
    // Commit frontier the rejoined member must reach, per shard.
    const frontier = new Map();
    for (const url of [stack.nodeUrls[0], stack.nodeUrls[1]]) {
      const status = await nodeStatus(url);
      for (const shard of status.consensus.shards) {
        if (shard.role === "leader") frontier.set(shard.shard_id, shard.commit_index);
      }
    }
    assert.ok(frontier.size > 0, "survivors must be leading");

    await stack.restartNode(2);
    await eventually(async () => {
      const status = await nodeStatus(stack.nodeUrls[2]);
      for (const shard of status.consensus.shards) {
        const needed = frontier.get(shard.shard_id) ?? 0;
        assert.ok(
          shard.last_applied >= needed,
          `shard ${shard.shard_id}: rejoined member applied ${shard.last_applied} < frontier ${needed}`,
        );
        assert.ok(
          shard.snapshot_index > 0,
          `shard ${shard.shard_id}: rejoined member should hold compacted state (snapshot_index > 0)`,
        );
      }
    }, { timeoutMs: 120_000, label: "rejoined member catches up to the commit frontier" });
  });

  it("fencing tokens stay strictly monotonic across the crash and rejoin", { timeout: 120_000 }, async () => {
    assert.ok(fencingBeforeCrash, "earlier lock stage must have run");
    await eventually(
      () => lb.lockRelease(contestedKey, { holder: fencingBeforeCrash.holder, fencingToken: fencingBeforeCrash.token }),
      { timeoutMs: 30_000, label: "release pre-crash lock" },
    );
    const res = await eventually(
      () => lb.tryLock(contestedKey, { holder: uniqueId("holder"), ttlMs: 30_000 }),
      { timeoutMs: 30_000, label: "post-rejoin lock acquire" },
    );
    assert.equal(output(res).acquired, true);
    assert.equal(shardOf(res), coordinatorShard, "coordinator shard survives the crash");
    assert.ok(
      output(res).fencing_token > fencingBeforeCrash.token,
      `token must outrank every pre-crash grant: ${output(res).fencing_token} > ${fencingBeforeCrash.token}`,
    );
  });
});
