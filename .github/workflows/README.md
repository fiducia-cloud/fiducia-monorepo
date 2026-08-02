# CI workflows

GitHub Actions definitions for the fiducia-e2e suite.

- `ci.yml` — the `e2e` workflow. Its default push/PR job (`conformance-no-cluster`)
  runs `node --test` with **no cluster deployed**: because every suite skips
  cleanly when no endpoint is configured, this job is a parser/unit/skip sentinel,
  not deployment assurance. A second, manual-only (`workflow_dispatch`) job
  (`kind-cluster-e2e`) checks out `fiducia-infra`, stands up its real single kind
  cluster, and runs smoke plus conformance against `127.0.0.1:8090`.
- `upstream-contracts.yml` — pins exact reviewed `fiducia-interfaces`,
  `fiducia-clients`, and `fiducia-sync` revisions, then verifies byte-identical
  sync schemas, generated/embed drift, TypeScript client-to-sync type
  compatibility, package export boundaries, and parity of the KV list/watch and
  encrypted secret ergonomics mirrored by this E2E suite. It needs no cluster or
  credentials and prevents independently green repositories from drifting at
  their integration seams.

Both jobs in `ci.yml` pin `fiducia-test-config` to
`825220281fdc16bbf47a035177001d2fe29bdabf`; the kind job pins
`fiducia-infra` to `1d5dc84eecc0f5e9c35bbe1f274035a70bfc6fa8`.
Third-party actions are commit-pinned, Node is fixed, dependency installation is
lockfile-only with lifecycle scripts disabled, and every job has a finite
timeout.

Cross-cluster quorum and disruptive chaos require three independently routed
cluster endpoints. The single-cluster kind job intentionally does not run or
claim that layer.

This folder exists because GitHub Actions requires workflow YAML to live under
`.github/workflows/`.

## Security baseline

Every executable workflow uses explicit least-privilege permissions, immutable
third-party action or container references, non-persisted checkout credentials,
concurrency control, and a job timeout. Each workflow is actionlint-validated;
the main CI workflow also validates the permanent deployment-oriented workflows.
Environment mutation is forbidden unless this README documents a
repository-specific platform exception.
