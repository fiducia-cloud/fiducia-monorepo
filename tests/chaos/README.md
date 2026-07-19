# tests/chaos

The multi-cluster resilience layer that justifies the whole repo. Where
`conformance/` checks one endpoint's correctness, this asserts the cross-cluster
quorum guarantee from `fiducia-infra`: one shard replica per cluster (RF=3), so
losing any one cluster leaves a 2/3 quorum serving.

- `cluster-failure.test.mjs` — with a validated topology containing exactly
  three independently routed Hetzner cluster LBs, asserts (a) every endpoint reports the
  concrete healthy consensus schema, (b) a lock acquired
  via endpoint A is observable and still exclusive through all three endpoints
  (cross-cluster linearizability), and (c) a gated cluster-loss flow using an
  authenticated infrastructure hook or the selected topology entry's explicit
  kubectl context and optional local kubeconfig. It confirms the target is
  down, verifies the surviving quorum, heals, and checks the member rejoined
  healthy.

Disruption requires both `FIDUCIA_E2E_ALLOW_DISRUPTIVE=1` and
`npm run proof:hetzner -- --chaos`. Configure the authenticated hook or verify
the topology's context, namespace, target, and selector first; it changes live
workloads.

An ordinary run without exactly three independently routed endpoints skips.
Strict proof mode fails closed. A single local Kind cluster is not a substitute
for this layer.
