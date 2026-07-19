# src

The small, dependency-light library the specs are built on. Not tests
themselves — the shared client and endpoint plumbing every suite imports.

- `client.mjs` — `FiduciaClient`, a `fetch`-based mirror of the fiducia.cloud
  HTTP contract (`fiducia-clients/PROTOCOL.md`). One method per route across all
  primitives (locks, semaphores, rw-locks, idempotency, rate-limit, KV + watch,
  elections, cron, discovery), plus the `HttpError` class and `output()` envelope
  helper that let tests treat 404/501 as "not deployed → skip". Requests have a
  bounded timeout, never follow redirects, and refuse to send an API key over
  cleartext except to an explicitly enabled loopback harness. Explicit
  token-bound methods exercise the explicit lock/semaphore renew and durable
  queue-cancel routes. Uses only global `fetch`, no SDK.
- `attestation.mjs` — exact-byte verifier for the `proof-input.json`,
  `proof-topology.json`, and `infra-evidence.json` bundle emitted by
  `fiducia-infra`. It binds clean source/release identity, topology UIDs, and
  distinct `hcloud://` Node placement before the Hetzner proof can start. The
  same validator requires the exact node/brain/LB container set, release image
  digests, readiness, resolved runtime image IDs, and placement on the one
  attested visible Node.
- `origin.mjs` — shared credential-free origin validation. HTTPS is mandatory
  except for an explicitly enabled loopback harness; userinfo, paths, queries,
  fragments, and ambiguous origins are rejected.
- `topology.mjs` — exact-schema topology loader. It accepts one JSON env value
  or one file and requires exactly three distinct
  cluster IDs/contexts/node endpoints/LB endpoints. `regional` mode requires
  distinct regions; `logical` mode accepts three vcluster APIs on one physical
  host cluster. The built-in Kind topology is explicitly `local-mock`,
  loopback-only, and rejected by strict proof. Unknown and secret-bearing fields are rejected. An
  optional kubeconfig must be a bounded local path, never inline or remote
  credential material.
- `endpoints.mjs` — endpoint resolution. A configured topology is validated and
  takes precedence; strict mode rejects legacy endpoint variables. Ordinary
  compatibility runs may still use `FIDUCIA_E2E_ENDPOINTS` or
  `FIDUCIA_E2E_BASE_URL`, and return empty/null so offline suites skip when
  nothing is configured. `makeClient()` passes the validated endpoint set as
  the explicit redirect/failover allowlist and adds the optional Bearer key.
- `proof.mjs` — pure identity and evidence safety helpers. It requires distinct
  configured cluster IDs/contexts and distinct live Kubernetes cluster UIDs and
  Fiducia member IDs, exact three-member Raft peer/shard convergence from the
  pinned node endpoints, and fresh pod/image/physical-Node observations matching
  the attested release. It conditionally enforces regional placement, validates
  optional expected IDs, recursively strips secret-shaped fields, and redacts
  configured secret values from text.
- `webapps.mjs` — opt-in composition for the web-app authentication and plane-
  separation suite. It boots real sibling auth/admin/backend servers with local
  stubs and a disposable, TCP-only scratch Postgres on an available loopback
  port. Startup is transactional: a partial failure stops everything already
  started, while the returned `stop()` drains all services in reverse order and
  reports every cleanup failure. Concurrent calls share one cleanup attempt;
  successfully stopped resources are removed and failed entries remain for a
  later retry. Scratch Postgres probes the authoritative `postmaster.pid` even
  after an ambiguous startup result and never deletes its data directory while
  the postmaster is live or indeterminate. `webAppsSkipReason()` checks the local
  test harness, sibling checkouts, and PostgreSQL tools before the heavyweight
  cargo builds. The test-config modules are dynamically imported only after
  those checks, so the default conformance image retains no runtime dependency.

Keeping the wire contract in one place means a PROTOCOL.md change is a one-file
edit here rather than a change across every spec.
