# tests

The black-box test suite proper, run with Node's built-in runner (`node --test`).
Every spec drives the real HTTP contract via `src/`, and every suite **skips
cleanly** (not fails) when no endpoint is configured.

- `smoke.test.mjs` — reachability of the primary endpoint (`/healthz`,
  `/v1/status`).
- `conformance/` — per-primitive correctness, one file per family (locks,
  semaphores, rw-locks, idempotency, rate-limit, cron, KV, elections, discovery).
- `chaos/` — the multi-cluster quorum / cross-cluster linearizability layer.
- `webapps/` — the web-app login & separation layer: boots the real
  fiducia-auth + fiducia-admin + fiducia-backend locally against stub
  Supabase/KV/brain and a scratch Postgres (opt-in via `FIDUCIA_E2E_WEBAPPS=1`;
  see its README). `scripts/dev-stack.mjs` reuses the same boot to run the
  stack interactively.
- `helpers.mjs` — shared, non-test helpers (no `.test.mjs` suffix so the runner
  ignores it): high-entropy run-namespaced key generation, the `NO_ENDPOINT`
  skip reason, strict `/v1/status` assertions, and `skipIfUndeployed()`, which
  turns a 404/501 route into a skip while letting any wrong behavioral assertion
  still fail.
