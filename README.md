# fiducia-e2e

Cross-cluster **end-to-end + conformance** test suite for
[fiducia.cloud](https://fiducia.cloud) — the Raft-replicated coordination
service. This repo is the black-box companion to the per-repo unit tests: it
drives the **real HTTP contract** (`fiducia-clients/PROTOCOL.md`) against a
running deployment and asserts that every coordination primitive behaves
correctly, then adds a **multi-cluster quorum / chaos** layer on top.

It follows the org test convention: Node's built-in runner (`node --test`) and
ESM `.mjs`. The conformance, chaos, and smoke layers have no third-party runtime
packages (global `fetch` + `node:test` + `node:assert`); the opt-in local web-app
composition uses the sibling `@fiducia/test-config` development harness.

## Run modes

| Mode | How | When |
|------|-----|------|
| **(a) Local single-cluster conformance** | `FIDUCIA_E2E_BASE_URL=http://127.0.0.1:8090` with `FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST=1` after `fiducia-infra/tools/kind-up.sh` | smoke and primitive conformance only; this cannot prove cross-cluster failover |
| **(b) Real cross-cluster deployment** | `FIDUCIA_E2E_ENDPOINTS` = three independently routed `lb_endpoint` URLs from [`fiducia-infra/topology.toml`](../fiducia-infra/topology.toml) | staging or production quorum and chaos validation |
| **(c) Local web/auth composition** | `npm run test:webapps` | boots real auth/admin/backend sibling checkouts against ephemeral stub identity/coordination services and scratch Postgres; proves login and authorization-plane separation without cloud dependencies |
| **(d) Local coordination composition** | `npm run test:system` | boots a real 3-node `fiducia-node` Raft cluster (durable data dirs) behind a real `fiducia-load-balance` from sibling checkouts; proves LB↔node routing agreement (org-scoped `key → shard`), trusted-hop identity, lock fencing, log compaction, crash failover, and `InstallSnapshot` rejoin — no Docker, no cloud (see [`tests/system/README.md`](tests/system/README.md)) |

The web/auth stack's `stop()` is concurrency-safe and retryable: completed
cleanup steps are remembered and failed steps remain pending. Scratch Postgres
cleanup reads and probes `postmaster.pid` even if `pg_ctl -w start` failed
ambiguously; the data directory is never removed while that process is live or
its state is indeterminate.

## Environment variables

| Var | Meaning |
|-----|---------|
| `FIDUCIA_E2E_BASE_URL` | single endpoint for a smoke run (e.g. `https://gcp.lb.fiducia.cloud`) |
| `FIDUCIA_E2E_ENDPOINTS` | comma-separated list of cluster LB URLs for multi-cluster / chaos (e.g. `https://gcp.lb.fiducia.cloud,https://aws.lb.fiducia.cloud,https://hetzner.lb.fiducia.cloud`) |
| `FIDUCIA_E2E_API_KEY` | optional; sent as `Authorization: Bearer <key>` on every request |
| `FIDUCIA_E2E_RUN_ID` | optional high-entropy namespace for durable test keys; defaults to the GitHub run/attempt or a random UUID |
| `FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST` | `1` permits plain HTTP only for localhost/loopback harnesses; all other endpoints require HTTPS |
| `FIDUCIA_E2E_TIMEOUT_MS` | per-request timeout in milliseconds (default `15000`) |
| `FIDUCIA_E2E_ALLOW_DISRUPTIVE` | `1` to enable the gated cluster-loss flow |
| `FIDUCIA_E2E_CHAOS_HOOK_URL` | preferred authenticated infra-harness endpoint accepting `{action, cluster}` |
| `FIDUCIA_E2E_CHAOS_HOOK_TOKEN` | bearer token for the chaos hook |
| `FIDUCIA_E2E_CHAOS_CONTEXTS` | JSON target-to-kubectl-context map, e.g. `{"hetzner":"fiducia-hetzner"}` |
| `FIDUCIA_E2E_CHAOS_TARGET` | target name to disrupt (default `hetzner`) |
| `FIDUCIA_E2E_CHAOS_NAMESPACE` | namespace containing node StatefulSets (default `fiducia`) |
| `FIDUCIA_E2E_CHAOS_SELECTOR` | node StatefulSet/pod selector (default `app.kubernetes.io/name=fiducia-node`) |
| `FIDUCIA_E2E_KUBECTL` | kubectl binary path (default `kubectl`) |
| `FIDUCIA_E2E_WEBAPPS` | `1` enables the heavyweight web-app composition test (`npm run test:webapps` sets it automatically) |
| `FIDUCIA_E2E_SYSTEM` | `1` enables the heavyweight coordination composition suite (`npm run test:system` sets it automatically) |
| `FIDUCIA_E2E_ORG_ID` | optional; the org id the configured credential resolves to — enables the routing conformance suite's *exact* org-scoped `key → shard` assertions (bounds + stability are checked regardless) |
| `FIDUCIA_REPOS_ROOT` | optional parent directory containing sibling checkouts for the composition suites (default: this repo's parent) |

Endpoint resolution order (`src/endpoints.mjs`): `FIDUCIA_E2E_ENDPOINTS` →
`FIDUCIA_E2E_BASE_URL` → **none** (every suite skips).

## Skips cleanly with nothing deployed

> **Running `npm test` with nothing configured is safe and exits 0.**

When no endpoint is set, operational suites are **skipped, not failed** — so the
default CI push/PR job is only a parser, unit-test, and clean-skip sentinel. It
does not prove a deployment is ready. Two further resilience rules keep a
configured run honest:

- A route that returns **404/501** (primitive not deployed on this build — e.g.
  reader-writer locks, which `PROTOCOL.md` marks as a not-yet-live client
  extension) is recorded as a **skip**, not a failure.
- A **wrong** behavior — two holders of a mutex, a split-brain election, a
  duplicate cron run, a stale-CAS overwrite — always **FAILS**.

## Test layers

```
tests/
  smoke.test.mjs            /healthz + /v1/status reachability (primary endpoint)
  conformance/              per-primitive correctness (one file per family)
    locks.test.mjs          mutual exclusion, union all-or-nothing, monotonic fencing
    semaphores.test.mjs     up to `limit` holders, limit+1 refused, release admits next
    rwlocks.test.mjs        concurrent readers; writer excludes readers & vice-versa
    idempotency.test.mjs    first claim vs duplicate replay; complete + fencing
    ratelimit.test.mjs      N within budget pass, N+1 rejected; fresh key full budget
    cron.test.mjs           schedule upsert/read; exactly-once run-record dedup
    kv.test.mjs             put/get + monotonic version; stale CAS fails; watch SSE
    elections.test.mjs      one winner, second sees leader; renew fencing; not_leader
    discovery.test.mjs      register→resolve; metadata filter narrows; deregister drops
  chaos/
    cluster-failure.test.mjs multi-cluster quorum + cross-cluster linearizability
  webapps/
    login-separation.test.mjs real auth/admin/backend + isolated local fixtures
  helpers.mjs               shared skip/uniqueKey helpers (not a test file)
src/
  client.mjs                fetch-based client mirroring PROTOCOL.md routes
  endpoints.mjs             env → endpoint list; endpoints() / primary()
  webapps.mjs               disposable web/auth composition + cleanup helpers
```

Each conformance file frames the invariant with the real-world use case it
protects (Terraform state locks, Stripe webhook dedup, LLM spend caps, canary
member sets, active/standby failover, …) in comments.

## The chaos layer

`tests/chaos/cluster-failure.test.mjs` encodes the fiducia-infra guarantee:
**one shard replica per cluster (RF=3), so losing any one cluster keeps a 2/3
quorum serving** (see [`fiducia-infra/README.md`](../fiducia-infra/README.md)).
With `FIDUCIA_E2E_ENDPOINTS` listing ≥3 cluster LBs it asserts:

- **(a)** every endpoint's `/v1/status` reports a healthy quorum;
- **(b)** a lock acquired via endpoint **A** is observable (and still exclusive)
  via endpoint **B** — cross-cluster linearizability, because all lock state is
  a single Raft group;
- **(c)** a gated cluster-loss flow: with
  `FIDUCIA_E2E_ALLOW_DISRUPTIVE=1`, it prefers the authenticated infrastructure
  hook; otherwise an explicit context map lets it scale the selected cluster's
  matching `fiducia-node` StatefulSets to zero. It confirms the endpoint is
  unavailable, proves the pre-existing lock stays observable and a new lock
  still commits on the surviving 2/3, then heals through the same provider.

Disruptive mode changes live Kubernetes workloads. Keep it disabled except in a
dedicated chaos environment with a verified hook or context mapping and selector.

Fewer than 3 independently routed endpoints → the chaos suite skips. The local
kind harness is one cluster with multiple labeled zones, so it is intentionally
used only for smoke and conformance in CI.

## Run

```sh
npm test                    # everything (skips cleanly with no endpoint)
npm run test:conformance    # just tests/conformance/
npm run test:chaos          # just tests/chaos/
npm run test:smoke          # just the reachability smoke
npm run test:webapps        # real auth/admin/backend + local stubs/scratch PG
npm run test:system         # real 3-node fiducia-node cluster + fiducia-load-balance
npm run lint                # ESM syntax check (dependency-light, no ESLint)

# Keep the same isolated web/auth stack running for interactive local use:
node scripts/dev-stack.mjs

# Local kind conformance (one cluster; no cross-cluster assurance):
bash ../fiducia-infra/tools/kind-up.sh
FIDUCIA_E2E_BASE_URL=http://127.0.0.1:8090 \
FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST=1 npm test

# Point at a live deployment:
FIDUCIA_E2E_ENDPOINTS="https://gcp.lb.fiducia.cloud,https://aws.lb.fiducia.cloud,https://hetzner.lb.fiducia.cloud" \
FIDUCIA_E2E_API_KEY="$KEY" npm test
```

Requires Node ≥ 22 (CI and the conformance image use 22.17.0; see `.nvmrc`). No
`tsconfig` — the org runs plain ESM `.mjs`.

## Reproducible CI and container inputs

CI resolves `fiducia-test-config` at
`825220281fdc16bbf47a035177001d2fe29bdabf` and the manual kind tier resolves
`fiducia-infra` at `1d5dc84eecc0f5e9c35bbe1f274035a70bfc6fa8`.
All actions are commit-pinned and npm uses the lockfile with lifecycle scripts
disabled. The container runs as the upstream `node` user, pins its Node base
manifest by digest, and deliberately contains only the dependency-free default
conformance suite. Docker Dependabot tracks reviewed digest updates. The opt-in
web-app composition remains a source-checkout test because it needs sibling
services, schemas, and disposable PostgreSQL.

## Security posture

No live credentials are baked into the suite. Deployment-facing secrets are
read from the environment at run time — `FIDUCIA_E2E_API_KEY` (sent only to HTTPS endpoints,
apart from an explicitly enabled loopback harness, and never followed across a redirect),
`FIDUCIA_E2E_CHAOS_HOOK_TOKEN`, and the chaos context/selector vars — and the
fixtures use only ephemeral, run-namespaced keys (`uniqueKey()` helpers backed by
an explicit run ID or random UUID), never real tenant data. The opt-in web-app
composition intentionally uses deterministic test-only users/passwords and
internal secrets, but they are confined to loopback stub services and a
throwaway Postgres cluster and are never sent to a deployment. There are no
`.env` files or hardcoded production tokens in `tests/` or `src/`. Disruptive
chaos that mutates live Kubernetes workloads stays gated
behind `FIDUCIA_E2E_ALLOW_DISRUPTIVE=1` plus an explicit hook/context mapping.
The deployment-facing suites have no third-party runtime packages. CI installs
the local, commit-pinned `@fiducia/test-config` development harness from the
lockfile for the opt-in composition contract, with package lifecycle scripts
disabled.

## Related

- [`fiducia-clients`](../fiducia-clients) — `PROTOCOL.md` is the endpoint/method source of truth this suite mirrors.
- [`fiducia-node.rs`](../fiducia-node.rs) — the coordination engine and `/v1` route semantics.
- [`fiducia-infra`](../fiducia-infra) — multi-cluster topology; the single-cluster kind tier is the local conformance target.
