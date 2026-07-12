# tests/conformance

Per-primitive correctness specs — one file per coordination family. Each frames
its invariant with the real-world use case it protects (in the file's header
comment) and then asserts that fiducia.cloud gets it right; a wrong behavior
always fails, while a route the build doesn't expose (404/501) is skipped.

- `locks.test.mjs` — multi-key UNION locks: mutual exclusion, all-or-nothing,
  monotonic fencing (the flagship primitive).
- `semaphores.test.mjs` — up to `limit` holders succeed, limit+1 refused, release
  admits next.
- `rwlocks.test.mjs` — concurrent readers; writer exclusive vs readers/writers.
- `idempotency.test.mjs` — first claim vs duplicate replay; complete + fencing.
- `ratelimit.test.mjs` — N within budget pass, N+1 rejected, refill re-admits.
- `cron.test.mjs` — schedule upsert/read; exactly-once run-record dedup.
- `kv.test.mjs` — put/get + monotonic version; stale CAS fails; watch SSE.
- `elections.test.mjs` — one winner, second sees leader; renew fencing.
- `discovery.test.mjs` — register→resolve; metadata filter; deregister drops.
