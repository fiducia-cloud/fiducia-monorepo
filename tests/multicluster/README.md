# Three-cluster Raft tests

This directory drives the Tier-2 environment in
`fiducia-infra/kind/multicluster`: three independent Kind control planes named
Hetzner, Vultr, and Civo, each with a real `fiducia-node`, `fiducia-brain`, and
`fiducia-load-balance` process.

Run `fiducia-infra/kind/multicluster/up.sh`, then:

```sh
npm run test:multicluster
```

The safe tier checks node leader/term agreement, the brain's own three-member
Raft leadership and placement replication, cross-LB linearizable reads, and the
deployment contract that neither consensus service is configured with NATS.
Set `FIDUCIA_E2E_ALLOW_DISRUPTIVE=1` to add a gated 1–1–1 network partition: no
minority may commit, and the healed group must converge and accept a new write.
The gated tier also applies continental (~90 ms pairwise) WAN latency, injects
a one-way Hetzner→Vultr partition, isolates the entire Civo cluster, and replaces
one node pod while retaining its PVC. During whole-cluster isolation it proves
that the two surviving regions preserve an existing multi-key union lock and a
three-holder semaphore cap, continue committing independent coordination work,
and deny write authority to the isolated minority. It verifies quorum and
cross-region reads throughout, then checks durable applied-index catch-up and
committed data after the restarted member rejoins.

The suite starts temporary `kubectl port-forward` processes for the brain peer
Services and always terminates them. It never creates or deletes clusters.
