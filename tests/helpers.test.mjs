import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertHealthyNodeStatus } from "./helpers.mjs";

function healthyStatus() {
  return {
    service: "fiducia-node",
    consensus: {
      node_id: "member-a",
      shard_count: 2,
      shards: [0, 1].map((shardId) => ({
        shard_id: shardId,
        role: "leader",
        term: 3,
        commit_index: 11,
        last_applied: 11,
        has_quorum: true,
        leader_id: "member-a",
      })),
    },
  };
}

describe("node status health coverage", () => {
  it("requires every expected shard exactly once", () => {
    assert.doesNotThrow(() => assertHealthyNodeStatus(healthyStatus()));

    const missing = healthyStatus();
    missing.consensus.shards.pop();
    assert.throws(
      () => assertHealthyNodeStatus(missing),
      /cover every expected shard/,
    );

    const duplicate = healthyStatus();
    duplicate.consensus.shards[1].shard_id = 0;
    assert.throws(
      () => assertHealthyNodeStatus(duplicate),
      /complete 0\.\.shard_count-1 set/,
    );
  });
});
