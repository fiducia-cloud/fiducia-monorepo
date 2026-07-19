# tests

The black-box test suite proper, run with Node's built-in runner (`node --test`).
Every spec drives the real HTTP contract via `src/`. Ordinary offline CI
**skips cleanly** when no endpoint is configured; the operator proof runner
enables strict mode so missing routes, capabilities, endpoints, or identities
fail instead.

- `smoke.test.mjs` — reachability of the primary endpoint (`/healthz`,
  `/v1/status`).
- `conformance/` — per-primitive correctness, one file per family (locks,
  semaphores, rw-locks, idempotency, rate-limit, cron, KV, elections, discovery).
- `chaos/` — the multi-cluster quorum / cross-cluster linearizability layer.
- `proof/` — live Kubernetes/Fiducia identity proof. It is inert in ordinary CI
  and is enabled only by `npm run proof:hetzner` after the runner verifies the
  explicit fiducia-infra topology/provider attestation.
- `webapps/` — the web-app login & separation layer: boots the real
  fiducia-auth + fiducia-admin + fiducia-backend locally against stub
  Supabase/KV/brain and a scratch Postgres (opt-in via `FIDUCIA_E2E_WEBAPPS=1`;
  see its README). `scripts/dev-stack.mjs` reuses the same boot to run the
  stack interactively.
- `helpers.mjs` — shared, non-test helpers (no `.test.mjs` suffix so the runner
  ignores it): high-entropy run-namespaced key generation, the `NO_ENDPOINT`
  skip reason, strict `/v1/status` assertions requiring complete
  `0..shard_count-1` coverage, and `skipIfUndeployed()`, which
  turns a 404/501 route into a skip during ordinary runs while letting any wrong
  behavioral assertion still fail. In strict proof mode, 404/501 and missing
  required capabilities are failures.
