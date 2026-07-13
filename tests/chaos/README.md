# tests/chaos

The multi-cluster resilience layer that justifies the whole repo. Where
`conformance/` checks one endpoint's correctness, this asserts the cross-cluster
quorum guarantee from `fiducia-infra`: one shard replica per cluster (RF=3), so
losing any one cluster leaves a 2/3 quorum serving.

- `cluster-failure.test.mjs` — with `FIDUCIA_E2E_ENDPOINTS` listing ≥3 cluster
  LBs, asserts (a) every endpoint reports a healthy quorum, (b) a lock acquired
  via endpoint A is observable and still exclusive via endpoint B
  (cross-cluster linearizability), and (c) a gated cluster-loss flow using an
  authenticated infrastructure hook or an explicit kubectl-context fallback.
  It confirms the target is down, verifies the surviving quorum, and heals.

Configure the authenticated hook, or `FIDUCIA_E2E_CHAOS_CONTEXTS` with a
verified namespace and selector, before enabling disruption; it changes workloads.

Fewer than 3 endpoints → the suite skips.
