# tests/system — local coordination composition

Boots the **real coordination tier** from sibling checkouts on localhost — a
3-member `fiducia-node` Raft cluster (durable data dirs, low compaction
threshold) behind one `fiducia-load-balance` — and drives it over real HTTP.
No Docker, no kind, no cloud.

This is the layer between the per-repo unit tests (in-process loopback
clusters) and `tests/conformance/` (a live deployment): it proves the
**composition** with the binaries that actually ship.

What it asserts, in order (stages share cluster state):

1. every shard elects exactly one leader across the three members;
2. the LB and the cluster agree with `fiducia-routing.rs` on key → shard
   (`result.shard` == FNV-1a(key) % shard_count) for every write;
3. all lock traffic meets on the single lock-coordinator shard, with strictly
   monotonic fencing tokens;
4. each shard's log compacts into a snapshot once writes cross the threshold,
   and the live log stays bounded on every member;
5. a SIGKILL'd member does not interrupt service (quorum keeps committing
   through the LB, routing agreement intact);
6. the crashed member rejoins from its data dir and catches up past the
   survivors' compacted history (the `InstallSnapshot` path, with real
   processes) to the commit frontier;
7. fencing tokens stay strictly monotonic across the crash and rejoin.

## Running

```sh
npm run test:system            # sets FIDUCIA_E2E_SYSTEM=1 for you
```

Opt-in because it is heavyweight: the first run `cargo build`s the sibling
`fiducia-node.rs` and `fiducia-load-balance.rs` checkouts (minutes); warm runs
are seconds. Without `FIDUCIA_E2E_SYSTEM=1` the suite skips cleanly, so plain
`npm test` stays safe everywhere.

Requirements:

- sibling checkouts `fiducia-node.rs` and `fiducia-load-balance.rs`
  (override the parent directory with `FIDUCIA_REPOS_ROOT`);
- `cargo` on `PATH`.
