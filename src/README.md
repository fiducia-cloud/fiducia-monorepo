# src

The small, dependency-light library the specs are built on. Not tests
themselves — the shared client and endpoint plumbing every suite imports.

- `client.mjs` — `FiduciaClient`, a `fetch`-based mirror of the fiducia.cloud
  HTTP contract (`fiducia-clients/PROTOCOL.md`). One method per route across all
  primitives (locks, semaphores, rw-locks, idempotency, rate-limit, KV + watch,
  elections, cron, discovery), plus the `HttpError` class and `output()` envelope
  helper that let tests treat 404/501 as "not deployed → skip". Requests have a
  bounded timeout, never follow redirects, and refuse to send an API key over
  cleartext except to an explicitly enabled loopback harness. Uses only global
  `fetch`, no SDK.
- `endpoints.mjs` — env → endpoint resolution. `endpoints()` / `primary()` read
  `FIDUCIA_E2E_ENDPOINTS` (multi-cluster) then `FIDUCIA_E2E_BASE_URL` (smoke),
  validate credential-free HTTPS origins, and return empty/null so suites skip
  when nothing is configured; `makeClient()` builds a client with the optional
  Bearer key. Plain HTTP is limited to loopback with an explicit opt-in.

Keeping the wire contract in one place means a PROTOCOL.md change is a one-file
edit here rather than a change across every spec.
