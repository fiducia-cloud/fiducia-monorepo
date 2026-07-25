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
| **(b) Strict three-Hetzner proof** | `fiducia-infra/scripts/hetzner-e2e-vcluster-deploy.sh proof <release>` (or invoke `proof:hetzner` with its generated topology + attestation) | fail-closed locks/leases proof with cryptographically linked infra/provider, Kubernetes, Fiducia, source, and image evidence from exactly three API-isolated vclusters on the existing Hetzner host cluster |
| **(c) Local web/auth composition** | `npm run test:webapps` | boots real auth/admin/backend sibling checkouts against ephemeral stub identity/coordination services and scratch Postgres; proves login and authorization-plane separation without cloud dependencies |
| **(d) Local coordination composition** | `npm run test:system` | boots a real 3-node `fiducia-node` Raft cluster (durable data dirs) behind a real `fiducia-load-balance` from sibling checkouts; proves LB↔node routing agreement (org-scoped `key → shard`), trusted-hop identity, lock fencing, log compaction, crash failover, and `InstallSnapshot` rejoin — no Docker, no cloud (see [`tests/system/README.md`](tests/system/README.md)) |
| **(e) Real-browser login journeys** | `npm run test:browser` | boots the same web/auth composition as (c) and drives it through actual Chromium — Playwright for the operator's admin sign-in/sign-out journey, Puppeteer for the separation/negative paths — so redirects, form posts, the cookie jar, and HttpOnly/SameSite are enforced by a real browser (see [`tests/browser/README.md`](tests/browser/README.md)) |
| **(f) Three independent local clusters** | `npm run test:multicluster` after `fiducia-infra/kind/multicluster/up.sh` | drives the real node Raft groups, brain Raft group, and all three LBs across disposable Hetzner `fsn1`/`nbg1`/`hel1` Kind control planes; optional disruptive mode proves a 1–1–1 partition refuses writes and heals (see [`tests/multicluster/README.md`](tests/multicluster/README.md)) |

The web/auth stack's `stop()` is concurrency-safe and retryable: completed
cleanup steps are remembered and failed steps remain pending. Scratch Postgres
cleanup reads and probes `postmaster.pid` even if `pg_ctl -w start` failed
ambiguously; the data directory is never removed while that process is live or
its state is indeterminate.

## Environment variables

| Var | Meaning |
|-----|---------|
| `FIDUCIA_E2E_BASE_URL` | compatibility input for an ordinary single-endpoint smoke/conformance run; rejected by the strict proof runner |
| `FIDUCIA_E2E_ENDPOINTS` | compatibility input for an ordinary comma-separated multi-endpoint run; rejected by the strict proof runner |
| `FIDUCIA_E2E_TOPOLOGY_FILE` | path to one strict topology JSON document; mutually exclusive with `FIDUCIA_E2E_TOPOLOGY_JSON` |
| `FIDUCIA_E2E_TOPOLOGY_JSON` | inline strict topology JSON; prefer the file form for operator runs and never put secrets in either form |
| `FIDUCIA_E2E_INFRA_ATTESTATION_FILE` | required by `proof:hetzner`; path to fiducia-infra's sibling `proof-input.json`, which hashes the exact topology and infra evidence files |
| `FIDUCIA_E2E_API_KEY` | optional; sent as `Authorization: Bearer <key>` on every request |
| `FIDUCIA_E2E_INTERNAL_SECRET` | direct-node trusted-hop credential; required by strict proof when public LB requests use an API key, because Raft membership is verified against each pinned node endpoint |
| `FIDUCIA_E2E_LOCAL_EDGE_SECRET` | loopback harness only (Kind or tunneled vCluster); emulates the trusted edge for LB conformance and is also reused as the direct-node secret, and is refused unless insecure localhost is explicitly enabled |
| `FIDUCIA_E2E_SCOPES` | scopes sent by the local trusted-edge adapter (default `admin:read admin:write`) |
| `FIDUCIA_E2E_RUN_ID` | optional high-entropy namespace for durable test keys; defaults to the GitHub run/attempt or a random UUID |
| `FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST` | `1` permits plain HTTP only for localhost/loopback harnesses; all other endpoints require HTTPS |
| `FIDUCIA_E2E_TIMEOUT_MS` | per-request timeout in milliseconds (default `15000`) |
| `FIDUCIA_E2E_RAFT_CONVERGENCE_TIMEOUT_MS` | strict proof wait for exact three-member shard convergence, from `1000` to `600000` ms (default `60000`) |
| `FIDUCIA_E2E_ALLOW_DISRUPTIVE` | first gate for cluster mutation; the proof runner additionally requires its explicit `--chaos` flag |
| `FIDUCIA_E2E_CHAOS_HOOK_URL` | preferred authenticated infra-harness endpoint accepting `{action, cluster}` |
| `FIDUCIA_E2E_CHAOS_HOOK_TOKEN` | bearer token for the chaos hook |
| `FIDUCIA_E2E_CHAOS_TARGET` | topology `clusterId` to disrupt (default: the third cluster) |
| `FIDUCIA_E2E_CHAOS_SELECTOR` | node StatefulSet/pod selector (default `app.kubernetes.io/name=fiducia-node`) |
| `FIDUCIA_E2E_KUBECTL` | kubectl binary path (default `kubectl`) |
| `FIDUCIA_E2E_WEBAPPS` | `1` enables the heavyweight web-app composition test (`npm run test:webapps` sets it automatically) |
| `FIDUCIA_E2E_SYSTEM` | `1` enables the heavyweight coordination composition suite (`npm run test:system` sets it automatically) |
| `FIDUCIA_E2E_MULTICLUSTER` | `1` enables the three-Kind-cluster suite (`npm run test:multicluster` sets it automatically) |
| `FIDUCIA_E2E_BROWSER` | `1` enables the real-Chromium login-journey suite (`npm run test:browser` sets it, plus `FIDUCIA_E2E_WEBAPPS=1` for the underlying stack) |
| `FIDUCIA_E2E_SELENIUM_URL` | Selenium Grid endpoint for the `selenium/` browser tiers (default `http://localhost:4444`; `SELENIUM_REMOTE_URL` is a fallback name). Point at a port-forwarded deployed Grid — see [docs/remote-browser-servers.md](docs/remote-browser-servers.md) |
| `FIDUCIA_E2E_PUBLIC_BASE_URL` | rewrites a browser journey's target origin when the (remote) Grid's browser cannot reach the runner's `localhost` stack |
| `FIDUCIA_E2E_PLAYWRIGHT_WS` | connect Playwright to a remote `playwright run-server` (`chromium.connect`) instead of a local browser |
| `FIDUCIA_E2E_PUPPETEER_WS` | connect Puppeteer to a remote browserless/Chrome CDP endpoint (`puppeteer.connect`) instead of a local browser |
| `FIDUCIA_E2E_ORG_ID` | the org id the configured credential resolves to; required with `FIDUCIA_E2E_LOCAL_EDGE_SECRET`, otherwise optional — enables exact org-scoped `key → shard` assertions |
| `FIDUCIA_REPOS_ROOT` | optional parent directory containing sibling checkouts for the composition suites (default: this repo's parent) |

Endpoint resolution order (`src/endpoints.mjs`): validated topology → legacy
`FIDUCIA_E2E_ENDPOINTS` → legacy `FIDUCIA_E2E_BASE_URL` → **none**. Topology
mode requires exactly three clusters and rejects simultaneous legacy endpoint
variables. The default topology is explicitly `provider: "local-mock"` and is
only the disposable Kind emulator. The proof runner owns
`FIDUCIA_E2E_STRICT_PROOF`, refuses every default and inline topology, and
requires `provider: "hetzner"` plus the infra-generated attestation; operators
must not set that internal switch directly.

Topology schema version 1 distinguishes two placement claims:

- `provider: "local-mock"` is limited to three loopback Kind endpoints and can
  never enter strict proof mode. See
  [`topology.local-mock.example.json`](topology.local-mock.example.json).
- `provider: "hetzner"`, `isolationMode: "logical"` requires three distinct cluster IDs, kubectl
  contexts, Kubernetes API identities (`kube-system` UIDs), Fiducia member IDs,
  node endpoints, and LB endpoints, but permits the same physical Hetzner
  region. It requires `kubernetesDistribution: "vcluster"` for the
  zero-new-machine test on the existing host cluster.
- `isolationMode: "regional"` adds a distinct-region requirement and normally
  uses `kubernetesDistribution: "k3s"`.

Each cluster may include `expectedKubernetesClusterUid` and
`expectedFiduciaMemberId` pins plus an optional local-path-only `kubeconfig`.
[`topology.hetzner-vcluster.example.json`](topology.hetzner-vcluster.example.json)
documents the shape only. A passing Hetzner proof must consume the three files
generated together by `fiducia-infra`: `proof-topology.json`,
`infra-evidence.json`, and `proof-input.json`. The runner rehashes both sibling
inputs, checks clean `fiducia-infra` source and the exact node/brain/LB image
contract, matches cluster IDs and Kubernetes UIDs, requires one distinct
`hcloud://` physical Node per logical cluster, and rejects unready containers,
unresolved runtime image IDs, or workloads placed outside that Node.

## Skips cleanly with nothing deployed

> **Running `npm test` with nothing configured is safe, offline, and exits 0.**

When no endpoint is set, operational suites are **skipped, not failed** — so the
default CI push/PR job is only a parser, unit-test, and clean-skip sentinel. It
does not prove a deployment is ready. Two further resilience rules keep a
configured run honest:

- In an ordinary run, a route that returns **404/501** (primitive not deployed on this build — e.g.
  reader-writer locks, which `PROTOCOL.md` marks as a not-yet-live client
  extension) is recorded as a **skip**, not a failure.
- A **wrong** behavior — two holders of a mutex, a split-brain election, a
  duplicate cron run, a stale-CAS overwrite — always **FAILS**.

The strict proof runner changes the first rule: missing endpoints, undeployed
routes, incomplete capabilities, unhealthy status, duplicate identities,
runtime/attestation drift, a non-converged three-member Raft group, or a dirty
proof-source worktree all fail. A green ordinary `npm test` is useful CI, but
only a green `proof:hetzner` run is deployment evidence.

## Test layers

```
tests/
  smoke.test.mjs            /healthz + /v1/status reachability (primary endpoint)
  conformance/              per-primitive correctness (one file per family)
    locks.test.mjs          validation, exclusion, exact-union renewal, expiry, monotonic fencing
    leases.test.mjs         expiry, attempt-scoped cancel-before-acquire, stale-token rejection
    semaphores.test.mjs     immutable limit, cap, renewal, expiry, next-holder admission
    rwlocks.test.mjs        concurrent readers; writer excludes readers & vice-versa
    idempotency.test.mjs    first claim vs duplicate replay; complete + fencing
    ratelimit.test.mjs      N within budget pass, N+1 rejected; fresh key full budget
    cron.test.mjs           schedule upsert/read; exactly-once run-record dedup
    kv.test.mjs             put/get + monotonic version; stale CAS fails; watch SSE
    elections.test.mjs      one winner, second sees leader; renew fencing; not_leader
    discovery.test.mjs      register→resolve; metadata filter narrows; deregister drops
  chaos/
    cluster-failure.test.mjs multi-cluster quorum + cross-cluster linearizability
  proof/
    identity.test.mjs       distinct K8s cluster UID + Fiducia member identity proof
  webapps/
    login-separation.test.mjs real auth/admin/backend + isolated local fixtures
  helpers.mjs               shared skip/uniqueKey helpers (not a test file)
src/
  client.mjs                fetch-based client mirroring PROTOCOL.md routes
  attestation.mjs           exact-byte infra/topology/provider proof verification
  endpoints.mjs             strict topology or legacy env → endpoint list
  topology.mjs              bounded, secret-free three-Hetzner topology validation
  proof.mjs                 identity checks and evidence redaction
  webapps.mjs               disposable web/auth composition + cleanup helpers
```

Each conformance file frames the invariant with the real-world use case it
protects (Terraform state locks, Stripe webhook dedup, LLM spend caps, canary
member sets, active/standby failover, …) in comments.

## The chaos layer

`tests/chaos/cluster-failure.test.mjs` encodes the fiducia-infra guarantee:
**one shard replica per cluster (RF=3), so losing any one cluster keeps a 2/3
quorum serving** (see [`fiducia-infra/README.md`](../fiducia-infra/README.md)).
With a validated topology containing exactly three cluster LBs it asserts:

- **(a)** every endpoint's `/v1/status` reports a healthy quorum;
- **(b)** a lock acquired via endpoint **A** is observable (and still exclusive)
  through **all three** endpoints — cross-cluster linearizability, because all
  lock state is a single Raft group;
- **(c)** a gated cluster-loss flow: with
  `FIDUCIA_E2E_ALLOW_DISRUPTIVE=1` **and** the proof runner's `--chaos` flag, it
  prefers the authenticated infrastructure hook; otherwise the selected
  topology entry supplies the Kubernetes context and optional kubeconfig used
  to scale matching `fiducia-node` StatefulSets to zero. It confirms the
  endpoint is unavailable, proves the pre-existing lock stays observable and a
  new lock still commits on the surviving 2/3, then heals and verifies that the
  member rejoins healthy.

Disruptive mode changes live Kubernetes workloads. Keep it disabled except in a
dedicated chaos environment with verified topology, hook/context, and selector.

An ordinary run without exactly three independently routed endpoints skips the
chaos suite; strict proof mode fails closed. The legacy `tools/kind-up.sh`
harness is one cluster and remains smoke/conformance-only;
`kind/multicluster/up.sh` creates the three independent control planes exercised
by `npm run test:multicluster` and the loopback trusted-edge conformance example.

## Run

```sh
npm test                    # everything (skips cleanly with no endpoint)
npm run test:conformance    # just tests/conformance/
npm run test:chaos          # just tests/chaos/
npm run test:smoke          # just the reachability smoke
npm run test:webapps        # real auth/admin/backend + local stubs/scratch PG
npm run test:system         # real 3-node fiducia-node cluster + fiducia-load-balance
npm run test:multicluster   # real Kind x3 node + brain Raft and three LBs
npm run test:browser        # web/auth stack driven through Playwright + Puppeteer
npm run lint                # ESM syntax check (dependency-light, no ESLint)
npm run proof:hetzner       # strict fail-closed proof + sanitized evidence bundle

# Keep the same isolated web/auth stack running for interactive local use:
node scripts/dev-stack.mjs

# Local kind conformance (one cluster; no cross-cluster assurance):
bash ../fiducia-infra/tools/kind-up.sh
FIDUCIA_E2E_BASE_URL=http://127.0.0.1:8090 \
FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST=1 npm test

# Three independent local mock clusters through their real LBs.
# The local-mock topology uses contexts kind-fiducia-hetzner-{fsn1,nbg1,hel1},
# direct nodes on 8100-8102, and LBs on 8103-8105. These are disposable harness
# credentials from fiducia-infra/kind/multicluster/lib.sh, never deployment credentials:
FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST=1 \
FIDUCIA_E2E_LOCAL_EDGE_SECRET="emulation-internal-secret-do-not-use-in-prod" \
FIDUCIA_E2E_ORG_ID="emulation-org" npm run test:multicluster

# Preferred: fiducia-infra captures and links live topology/provider evidence,
# then supplies both required inputs to this runner:
../fiducia-infra/scripts/hetzner-e2e-vcluster-deploy.sh proof "$RELEASE_ID"

# Equivalent direct invocation using that generated evidence directory:
FIDUCIA_E2E_TOPOLOGY_FILE="$EVIDENCE/proof-topology.json" \
FIDUCIA_E2E_INFRA_ATTESTATION_FILE="$EVIDENCE/proof-input.json" \
FIDUCIA_E2E_API_KEY="$KEY" \
FIDUCIA_E2E_INTERNAL_SECRET="$INTERNAL_SECRET" npm run proof:hetzner

# Disruptive outage/rejoin proof: both gates are intentional.
FIDUCIA_E2E_TOPOLOGY_FILE="$EVIDENCE/proof-topology.json" \
FIDUCIA_E2E_INFRA_ATTESTATION_FILE="$EVIDENCE/proof-input.json" \
FIDUCIA_E2E_API_KEY="$KEY" \
FIDUCIA_E2E_INTERNAL_SECRET="$INTERNAL_SECRET" \
FIDUCIA_E2E_ALLOW_DISRUPTIVE=1 npm run proof:hetzner -- --chaos
```

The runner refuses an uncommitted `fiducia-e2e` source tree and writes a
mode-`0600` bundle beneath ignored `evidence/` (or `--evidence-dir PATH`). The
bundle contains the source SHA/date, exact topology/infra/attestation hashes,
the attested clean fiducia-infra source/release and Hetzner provider placement,
three Kubernetes API server URLs/UIDs, exact RF=3 peer membership plus
per-shard leader/term/commit convergence, three Fiducia member IDs, server
versions, release-matched declared images and resolved runtime image IDs,
visible physical node/provider placement, per-cluster status JSON, and TAP
output. It recursively removes
secret-shaped fields and redacts configured secret values before writing or
printing evidence.

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
`FIDUCIA_E2E_CHAOS_HOOK_TOKEN`, and the chaos selector — and the
fixtures use only ephemeral, run-namespaced keys (`uniqueKey()` helpers backed by
an explicit run ID or random UUID), never real tenant data. The opt-in web-app
composition intentionally uses deterministic test-only users/passwords and
internal secrets, but they are confined to loopback stub services and a
throwaway Postgres cluster and are never sent to a deployment. There are no
`.env` files or hardcoded production tokens in `tests/` or `src/`. Disruptive
chaos that mutates live Kubernetes workloads stays gated
behind `FIDUCIA_E2E_ALLOW_DISRUPTIVE=1` plus the runner's explicit `--chaos`
flag. Topology accepts only a bounded, exact-field JSON schema; it rejects
secret-bearing fields, remote or inline kubeconfig material, duplicate cluster
identities, non-Hetzner providers, and non-HTTPS deployment endpoints. An
optional per-cluster `kubeconfig` value is a local path only.
The separate `FIDUCIA_E2E_LOCAL_EDGE_SECRET` adapter is restricted to an
explicitly enabled loopback origin, pins each request to that exact origin, and
refuses to run alongside an API key; it exercises the real LBs through a local
Kind harness or an operator-owned vcluster tunnel when no public identity
provider is present.
The deployment-facing suites have no third-party runtime packages. CI installs
the local, commit-pinned `@fiducia/test-config` development harness from the
lockfile for the opt-in composition contract, with package lifecycle scripts
disabled.

## Documentation

Deeper references live in [`docs/`](docs/):

- [docs/browser-automation.md](docs/browser-automation.md) — the
  Selenium/Playwright/Puppeteer browser tiers, the composed stack, and the htmx
  patterns/gotchas.
- [docs/remote-browser-servers.md](docs/remote-browser-servers.md) — driving the
  **deployed** Selenium Grid in `~/codes/ores/k8s-cluster` on AWS/Hetzner.
- [docs/local-node-conformance.md](docs/local-node-conformance.md) — running the
  conformance suite (incl. the **secrets** API) against a single local node.

## Related

- [`fiducia-clients`](../fiducia-clients) — `PROTOCOL.md` is the endpoint/method source of truth this suite mirrors.
- [`fiducia-node.rs`](../fiducia-node.rs) — the coordination engine and `/v1` route semantics.
- [`fiducia-infra`](../fiducia-infra) — multi-cluster topology; the single-cluster kind tier is the local conformance target.
- [`~/codes/ores/k8s-cluster`](../../ores/k8s-cluster) — hosts the deployed `dd-selenium-server` browser Grid (AWS/Hetzner).
