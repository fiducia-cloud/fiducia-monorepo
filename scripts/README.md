# scripts

Standalone maintenance/CI scripts for the suite.

- `lint.mjs` — the dependency-light "lint" run by `npm run lint` and in CI.
  It walks `src/`, `tests/`, and `scripts/`, and syntax-checks every `.mjs`
  with `node --check` (the same parser Node uses to run them). This deliberately
  avoids pulling ESLint so the repo stays dependency-light; it catches parse
  errors before the specs run. The test runner, not this syntax-only check,
  resolves and loads imports.
- `dev-stack.mjs` — boots the real sibling `fiducia-auth`, `fiducia-admin`, and
  `fiducia-backend` servers against disposable loopback-only Postgres and local
  Supabase, Fiducia KV, and brain stubs. It prints the local URLs and deterministic
  test-only accounts, then tears every process and temporary database down on
  `SIGINT`/`SIGTERM`. Set `FIDUCIA_REPOS_ROOT` when the sibling checkouts are not
  adjacent to this repository. PostgreSQL command-line tools must be on `PATH`.
- `prove-hetzner.mjs` — fail-closed operator runner for exactly three
  infra-attested Hetzner clusters. It refuses defaults, inline topology, and
  local Kind; rehashes fiducia-infra's exact topology/evidence siblings; checks
  their clean source/release, exact runtime workload images, and distinct
  `hcloud://` placement; supports regional k3s and co-located vcluster
  topologies; confirms distinct Kubernetes cluster UIDs and Fiducia member IDs,
  polls the three pinned node endpoints until every shard has exact RF=3
  membership/leader/term/commit convergence, records API server and visible
  physical node/provider placement plus source/image/status identity, runs smoke + lock + lease +
  semaphore + cross-endpoint tests, and writes mode-`0600` sanitized JSON/TAP
  evidence beneath ignored `evidence/`. It refuses legacy endpoint variables
  and a dirty proof-source tree. Cluster outage/rejoin mutation is double gated
  by `FIDUCIA_E2E_ALLOW_DISRUPTIVE=1` and `--chaos`.

Scripts here are tooling around the tests, not part of the client or the specs
themselves.
