# CI workflows

GitHub Actions definitions for the fiducia-e2e suite.

- `ci.yml` — the `e2e` workflow. Its default push/PR job (`conformance-no-cluster`)
  runs `node --test` with **no cluster deployed**: because every suite skips
  cleanly when no endpoint is configured, this job is a parser/unit/skip sentinel,
  not deployment assurance. A second, manual-only (`workflow_dispatch`) job
  (`kind-cluster-e2e`) checks out `fiducia-infra`, stands up its real single kind
  cluster, and runs smoke plus conformance against `127.0.0.1:8090`.

Both jobs pin `fiducia-test-config` to
`825220281fdc16bbf47a035177001d2fe29bdabf`; the kind job pins
`fiducia-infra` to `1d5dc84eecc0f5e9c35bbe1f274035a70bfc6fa8`.
Third-party actions are commit-pinned, Node is fixed to 22.17.0, dependency
installation is lockfile-only with lifecycle scripts disabled, and every job
has a finite timeout.

Cross-cluster quorum and disruptive chaos require three independently routed
cluster endpoints. The single-cluster kind job intentionally does not run or
claim that layer.

This folder exists because GitHub Actions requires workflow YAML to live under
`.github/workflows/`.
