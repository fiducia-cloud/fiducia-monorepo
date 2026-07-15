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
3. all lock and semaphore traffic meets on the single lock-coordinator shard,
   while different user keys remain independent;
4. overlapping multi-key unions conflict atomically, failed unions reserve no
   partial keys, retries are idempotent, and expired leases are fenced;
5. a semaphore with `limit=3` admits exactly three concurrent holders, rejects
   the fourth, and remains independent from semaphores under other keys;
6. each shard's log compacts into a snapshot once writes cross the threshold,
   and the live log stays bounded on every member;
7. a SIGKILL'd member does not interrupt service: quorum keeps committing and
   pre-crash union-lock/semaphore state remains authoritative;
8. the crashed member rejoins from its data dir and catches up past the
   survivors' compacted history (the `InstallSnapshot` path, with real
   processes) to the commit frontier;
9. fencing tokens stay strictly monotonic across the crash and rejoin.

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
