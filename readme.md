# fiducia-monorepo

Pinned integration and GitOps superproject for the Fiducia service repositories.

The repository root is the `fiducia-cloud/fiducia-monorepo` Zed package. Runtime
and service repositories are tracked as exact Git submodule commits under
`apps/`; `.gitmodules` sets `branch = main` so pin updates intentionally follow
each repository's reviewed main branch.

Two repository classes are deliberately outside the superproject ownership
graph:

- `fiducia-cli.rs` is an independently installed Zed/global-tool package and is
  not a monorepo dependency or gitlink.
- `fiducia-infra` is not a submodule. Production rendering reads the immutable
  repository/commit pair in `gitops/infra-source.json`, checks that source out to
  ignored `.external/fiducia-infra`, and verifies the exact commit before use.

The monorepo has no `*-cli` or `*-infra` Zed dependency and no repository is
represented both as a Zed dependency and a gitlink.

This repo is the all-up integration and GitOps view and is intended to be
private. Its live GitHub visibility was still `PUBLIC` on 2026-07-13; changing
that setting has fork, release, and collaborator consequences, so the audit
reports it for an explicit owner decision rather than mutating visibility.
Individual app repos keep their own visibility boundaries; see
`docs/repo-boundaries.md`.

The fleet reliability contract for Raft, NATS, and telemetry is
[`docs/messaging-consensus-observability.md`](docs/messaging-consensus-observability.md).
The verified state-machine inventory and `formal/fm.toml`/`fmctl` contract are
documented in
[`docs/formal-methods-state-machines.md`](docs/formal-methods-state-machines.md).

## Managed public beta launch controls

- [Managed public beta service contract v0.1](docs/production/managed-public-beta-service-contract-v0.1.md) — proposed customer and operator contract for DEN-1390.
- [Machine-readable SLO catalog](docs/production/managed-public-beta-slos.json) — exact source-series contracts, objective calculations, alerts, owners, review cadence, readiness state, and evidence.
- [Derived SLO series registry](docs/production/managed-public-beta-slo-derived-series.json) — explicit declarations for query inputs produced by controlled failure/incident harnesses rather than ordinary service scrapes.
- [Managed beta incident runbook](docs/operations/managed-beta-incident-runbook.md) — severity, command, containment, recovery, evidence, and required tabletop procedure.
- [Incident and maintenance communication templates](docs/operations/managed-beta-communication-templates.md) — partner-safe status language and handoff structure.
- [Production safety release gate](docs/security/production-safety-release-gate.md) — threat model, invariants, evidence policy, and route coverage for DEN-1391.
- [Machine-readable gate matrix](docs/security/production-safety-release-gate.json) — required adversarial tests and their current certification state.
- [Bounded automated evidence index](docs/security/automated-evidence/den-1391.json) — passing CI/process evidence with explicit limitations; it cannot mark a row production-certified.
- [Production gate evidence bundle template](docs/security/production-gate-evidence-template.md) — exact-candidate measurements, artifacts, exceptions, and independent sign-off.

Validate the documents, SLO catalog/series, gate matrix, and bounded automation evidence without installing dependencies:

```bash
node tools/validate-production-gates.mjs
node tools/validate-slo-series.mjs
node tools/validate-automated-evidence.mjs
```

A release candidate is not launchable until every SLO source is `measured` with exact-candidate evidence, every required gate row is `passed`, and both strict certification checks succeed:

```bash
node tools/validate-production-gates.mjs --require-pass
node tools/validate-slo-series.mjs --require-pass
```

The automated-evidence overlay deliberately has no `--require-pass` mode: it records useful lower-tier proof while preventing that proof from being confused with live exact-release certification.

The service contract is an engineering launch proposal until DEN-1390 is independently reviewed and approved. It is not a contractual SLA.

## Clone

```sh
git clone --recurse-submodules git@github.com:fiducia-cloud/fiducia-monorepo.git
```

For an existing checkout:

```sh
git submodule sync --recursive
git submodule update --init --recursive
```

Materialized Zed dependencies, when used, belong under `.vendor/.zed` and are
ignored. The current monorepo package intentionally has no package-layer
dependencies because clients and interfaces remain reviewed gitlinks in this
workspace.

## Update Pins

```sh
scripts/pin-submodules.sh main
git status
git diff --cached --submodule
git commit -m "Pin Fiducia apps to main"
```

The script accepts only `main` under the current branch policy. It verifies that
the branch exists on every submodule remote, refuses dirty submodule checkouts,
fast-forwards each submodule, and stages the resulting gitlink pins. It does not
change the independently reviewed `gitops/infra-source.json` pin.

Preview without changing files:

```sh
scripts/pin-submodules.sh main --dry-run
```

## Branch policy

The current integration policy is **main-only** for the superproject and every
application repository. Keep each checkout on `main`, preserve any existing
uncommitted work, and use fast-forward pulls only after confirming that the
tree is clean. Do not create feature branches or linked worktrees while this
temporary policy is in force.

The historical `scripts/checkout-feature-branch.sh` helper remains in the
repository for a future policy change, but it is not part of the authorized
workflow today.

## Audit

Run the monorepo audit before publishing a deployable pin set:

```sh
scripts/audit-repo-state.sh
```

The audit checks for dirty submodules, stale conflict markers, tracked secret
files, secret-looking values, mutable or fail-open workflows, unlocked Cargo
commands, enabled npm dependency hooks, moving sibling refs, container bases
without immutable digests, unsafe runtime identities, missing Docker update
automation, unreproducible README examples, missing tracked-directory READMEs,
README app-list drift, and visibility-policy drift. Workflow actions must use an
immutable 40-character commit SHA; retain a version comment so dependency
automation can keep the pin current.

The contract tests additionally require exactly 25 gitlinks, reject CLI/infra
ownership, validate the root Zed manifest, and validate the immutable external
infra source document.

During local edits, preview the non-dirty checks with:

```sh
scripts/audit-repo-state.sh --allow-dirty
```

## Production deployment

This repository is the data-plane production source and the intended source for
the ORES web plane. Dispatch `deploy` from protected `main`; the `prod`
Environment approves the exact recursive service gitlinks and the exact
`gitops/infra-source.json` commit. The workflow checks out that infra source
separately, resolves GHCR images to immutable digests, renders Hetzner/Civo/Vultr
state under `gitops/data-plane`, and commits the release bill of materials.
Argo CD pulls that commit and continuously reconciles the three provider
clusters.

Actions has no kubeconfig and performs no direct cluster mutation. The only
production secret it needs is a read-only `FIDUCIA_SUBMODULE_TOKEN`, used for
private service submodules and the separately pinned infra checkout. The
ORESoftware Kubernetes cluster currently hosts the admin, customer/backend, and
auth web plane through its existing Argo CD setup; the data-plane ApplicationSet
is label-isolated from that cluster. The safe transfer of that desired state
into this monorepo is tracked in `docs/k8s-cluster-gitops-todos-2026-07.md`. See
`docs/deploy.md` for placement, bootstrap labels, approval controls, and the
legacy-Application cutover.

## Apps

- `apps/fiducia-admin.rs`
- `apps/fiducia-ai-agent-bridge.rs`
- `apps/fiducia-ai-agent-control-plane`
- `apps/fiducia-ai-agent-manager.rs`
- `apps/fiducia-auth.rs`
- `apps/fiducia-brain.rs`
- `apps/fiducia-clients`
- `apps/fiducia-customer.rs`
- `apps/fiducia-e2e`
- `apps/fiducia-edge`
- `apps/fiducia-interfaces`
- `apps/fiducia-lambda-service.rs`
- `apps/fiducia-load-balance.rs`
- `apps/fiducia-marketing.web`
- `apps/fiducia-mcp-server.rs`
- `apps/fiducia-memory.rs`
- `apps/fiducia-messaging.rs`
- `apps/fiducia-node-sidecar.rs`
- `apps/fiducia-node.rs`
- `apps/fiducia-operations-control-plane`
- `apps/fiducia-payments.rs`
- `apps/fiducia-routing.rs`
- `apps/fiducia-sync`
- `apps/fiducia-telemetry.rs`
- `apps/fiducia-test-config`

## Security posture

The superproject itself ships no application code and no secrets — it pins
service commits plus one immutable external infrastructure source. `.env*` are
git-ignored (`!.env.example` excepted), `.external/` and `.vendor/.zed/` are
ignored, and `.env.example` carries placeholder values only. Secret hygiene is
enforced by `scripts/audit-repo-state.sh`, which fails on tracked secret files,
secret-looking values, stale conflict markers, mutable/fail-open workflows,
unlocked or moving dependency inputs, non-digest container bases, missing
Docker Dependabot coverage, and unsafe runtime users. Rust services use
distroless/nonroot by default; an explicitly labeled uid/gid `65532:65532` tool
runner is reserved for contracts requiring executables such as `psql` or agent
CLIs. The superproject tooling image follows that same labeled non-root profile.
Each app repo keeps its own visibility boundary (see
`docs/repo-boundaries.md`), so public SDK/protocol repos can coexist with private
control-plane/customer repos under one integration view. Per-app security
posture lives in each submodule's own README; submodule internals are never
edited from here.
