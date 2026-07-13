# tests

The black-box test suite proper, run with Node's built-in runner (`node --test`).
Every spec drives the real HTTP contract via `src/`, and every suite **skips
cleanly** (not fails) when no endpoint is configured.

- `smoke.test.mjs` — reachability of the primary endpoint (`/healthz`,
  `/v1/status`).
- `conformance/` — per-primitive correctness, one file per family (locks,
  semaphores, rw-locks, idempotency, rate-limit, cron, KV, elections, discovery).
- `chaos/` — the multi-cluster quorum / cross-cluster linearizability layer.
- `helpers.mjs` — shared, non-test helpers (no `.test.mjs` suffix so the runner
  ignores it): high-entropy run-namespaced key generation, the `NO_ENDPOINT`
  skip reason, strict `/v1/status` assertions, and `skipIfUndeployed()`, which
  turns a 404/501 route into a skip while letting any wrong behavioral assertion
  still fail.
