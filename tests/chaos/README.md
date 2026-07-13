# tests/chaos

The multi-cluster resilience layer that justifies the whole repo. Where
`conformance/` checks one endpoint's correctness, this asserts the cross-cluster
quorum guarantee from `fiducia-infra`: one shard replica per cluster (RF=3), so
losing any one cluster leaves a 2/3 quorum serving.

- `cluster-failure.test.mjs` — with `FIDUCIA_E2E_ENDPOINTS` listing ≥3 cluster
  LBs, asserts (a) every endpoint reports a healthy quorum, (b) a lock acquired
  via endpoint A is observable and still exclusive via endpoint B
  (cross-cluster linearizability), and (c) a **gated, real** kill-a-cluster flow.
  With `FIDUCIA_E2E_ALLOW_DISRUPTIVE=1`, `FIDUCIA_E2E_CHAOS_HOOK_URL`, and
  `FIDUCIA_E2E_CHAOS_HOOK_TOKEN`, the test invokes the infra harness, confirms
  the target endpoint is down, verifies 2/3 progress, and heals in `finally`.

Fewer than 3 endpoints → the suite skips.
