# tests/conformance

Per-primitive correctness specs — one file per coordination family. Each frames
its invariant with the real-world use case it protects (in the file's header
comment) and then asserts that fiducia.cloud gets it right; a wrong behavior
always fails, while a route the build doesn't expose (404/501) is skipped.

- `locks.test.mjs` — rejects empty holders and zero TTL, proves multi-key UNION
  all-or-nothing exclusion, requires renewal to present the exact canonical
  union, and verifies explicit token-bound renewal preserves the fencing token
  while extending expiry.
- `leases.test.mjs` — proves queued progress after dead-holder expiry, models
  durable attempt-scoped queue cancellation and the cancel-versus-promotion
  race, proves cancel-before-late-acquire suppression with the same unique
  `request_id`, rules out zombie ownership, rejects stale release, and requires
  the successor's fencing token to increase.
- `semaphores.test.mjs` — rejects empty holders and zero TTL, enforces the
  immutable initial limit and holder cap, admits the next waiter, and verifies
  explicit token-bound renewal preserves the fencing token while extending expiry.
- `rwlocks.test.mjs` — concurrent readers; writer exclusive vs readers/writers.
- `idempotency.test.mjs` — first claim vs duplicate replay; complete + fencing.
- `ratelimit.test.mjs` — N within budget pass, N+1 rejected, refill re-admits.
- `cron.test.mjs` — schedule upsert/read; exactly-once run-record dedup.
- `kv.test.mjs` — put/get + monotonic version; stale CAS fails; watch SSE.
- `elections.test.mjs` — one winner, second sees leader; renew fencing.
- `discovery.test.mjs` — register→resolve; metadata filter; deregister drops.

Cancellation uses a fresh `request_id` per acquisition attempt and repeats that
exact ID through retries and `/v1/locks/cancel` or `/v1/semaphores/cancel`.
This lets a replicated cancellation tombstone suppress an acquire that arrives
late without blocking a later attempt by the same holder. If expiry/release
promotes the waiter first, cancellation must not silently release live authority:
the response reports `acquired:true` and its fencing token so the aborting client
can safely release it.
