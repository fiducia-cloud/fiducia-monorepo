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
- `webapps.mjs` — opt-in composition for the web-app authentication and plane-
  separation suite. It boots real sibling auth/admin/backend servers with local
  stubs and a disposable, TCP-only scratch Postgres on an available loopback
  port. Startup is transactional: a partial failure stops everything already
  started, while the returned `stop()` drains all services in reverse order and
  reports every cleanup failure. Concurrent calls share one cleanup attempt;
  successfully stopped resources are removed and failed entries remain for a
  later retry. Scratch Postgres probes the authoritative `postmaster.pid` even
  after an ambiguous startup result and never deletes its data directory while
  the postmaster is live or indeterminate. `webAppsSkipReason()` checks the sibling
  checkouts and PostgreSQL tools before the heavyweight cargo builds.

Keeping the wire contract in one place means a PROTOCOL.md change is a one-file
edit here rather than a change across every spec.
