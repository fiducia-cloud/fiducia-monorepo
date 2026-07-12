# CI workflows

GitHub Actions definitions for the fiducia-e2e suite.

- `ci.yml` — the `e2e` workflow. Its default push/PR job (`conformance-no-cluster`)
  runs `node --test` with **no cluster deployed**: because every suite skips
  cleanly when no endpoint is configured, this job passes on a clean checkout and
  proves the specs load, parse, and skip. A second, manual-only
  (`workflow_dispatch`) job (`kind-cluster-e2e`) checks out the sibling
  `fiducia-infra` kind tier, stands up the 3-cluster topology, and runs the full
  conformance + chaos run against real endpoints.

This folder exists because GitHub Actions requires workflow YAML to live under
`.github/workflows/`.
