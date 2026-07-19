# Strict three-Hetzner proof

`identity.test.mjs` is intentionally inert during ordinary offline CI. The
operator proof runner enables it only after verifying the explicit
fiducia-infra attestation, exact topology/evidence hashes, and Hetzner provider
placement. It then requires exactly three topology entries. For every entry it
reads the `kube-system` namespace UID from the configured Kubernetes context and
the Fiducia member status from that cluster's pinned direct-node endpoint.
Cluster IDs, kube contexts, Kubernetes UIDs, and Fiducia member IDs must each be
nonempty and pairwise distinct. Three URLs or three contexts pointing at one
underlying API therefore cannot produce a passing proof. The three statuses
must also describe one closed RF=3 peer group: every member hosts every shard,
all replicas agree on leader/term/commit index, storage is healthy, and each
leader reports both peers caught up. `regional` mode also
requires three regions; `logical` mode permits three vcluster/Kind control
planes on one physical Hetzner host cluster and requires exact attested/live
physical node and workload-image placement. The localhost Kind default is a
`local-mock` test fixture and cannot run this proof.

Use `npm run proof:hetzner`; do not invoke this test directly.
