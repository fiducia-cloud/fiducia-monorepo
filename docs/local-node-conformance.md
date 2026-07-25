# Running conformance against a local node

The `tests/conformance/` suite is black-box: it exercises the `/v1` coordination
API of whatever endpoint you configure. The cheapest way to run it for real is a
**single local `fiducia-node`** — a lone node self-elects leader of every shard
(Raft quorum of 1), so one process is the whole coordination service. This is
how the secrets + KV suites were validated end to end.

## Boot a single node

Build once (`cargo build` in `../fiducia-node.rs`), then run the binary. A lone
node needs no peers; give it a data dir, a node id, ports, and the trusted-hop
secret:

```sh
DATADIR="$(mktemp -d)/node"
PORT=18090 FIDUCIA_PEER_PORT=19090 FIDUCIA_NODE_ID=e2e-node-1 \
  FIDUCIA_INTERNAL_SECRET=dev-secret FIDUCIA_ALLOW_INSECURE_INTERNAL=1 \
  FIDUCIA_DATA_DIR="$DATADIR" \
  ../fiducia-node.rs/target/debug/fiducia-node &
# wait for readiness:
until curl -fsS http://localhost:18090/readyz >/dev/null; do sleep 1; done
```

- The client/data plane (`/healthz`, `/readyz`, `/v1/*`) binds `PORT` (default
  `8090`); the peer plane (`/raft/*`) binds `FIDUCIA_PEER_PORT` (default `9090`).
- With `FIDUCIA_INTERNAL_SECRET` set, **every `/v1` request must carry
  `x-fiducia-internal-auth: <secret>`** (a constant-time match). A load balancer
  injects this in production; locally the e2e client injects it from env.
- `FIDUCIA_ALLOW_INSECURE_INTERNAL=1` permits the secret over plain HTTP for
  local dev (debug builds only).

> **Port conflict gotcha:** if a stale container (e.g. a `kind` node from the
> multicluster emulator) already publishes `127.0.0.1:8090`, `localhost:8090`
> resolves *there*, not to your binary, and you'll get a confusing `401`
> (different secret). Use a free port like `18090`, or stop the squatter.

> **KV encryption at rest is OFF by default.** Without a local keyring or Vault
> Transit, the node logs a warning and stores KV/secret values in cleartext; a
> secret then reports `protection.at_rest: "plaintext"`. That is a deployment
> posture, not a bug — the secrets conformance records it as a diagnostic and
> only asserts encryption when a provider is actually configured.

## Point the suite at the node

The e2e client requires HTTPS unless you explicitly allow insecure localhost,
and needs the internal secret + an org id:

```sh
export FIDUCIA_E2E_BASE_URL=http://localhost:18090
export FIDUCIA_E2E_INTERNAL_SECRET=dev-secret
export FIDUCIA_E2E_ORG_ID=demo-org
export FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST=1

node --test 'tests/conformance/**/*.test.mjs'
```

Verified result against a single local node (2026-07-25): **58 tests, 55 pass,
0 fail, 3 capability-skipped** (e.g. cross-cluster assurance, which needs more
than one cluster). This includes the secrets suite (5/5) and KV (3/3).

## What the secrets suite proves

`tests/conformance/secrets.test.mjs` certifies the end-user secrets API — a
client convention over the encrypted config KV (reserved `secret/` keyspace,
always written `plaintext:false`):

- a secret round-trips through `secretReveal`, and reports `at_rest:"encrypted"`
  **when** the cluster has a keyring/Vault configured;
- `secretList` returns names + metadata but **never** a value (write-only
  ergonomics);
- a stale-`prev_revision` write cannot overwrite a secret (CAS guard);
- `secretDelete` removes it; reveal then reports not-found;
- a secret is isolated from a same-named plain config key.

See [`../PROTOCOL.md`](../PROTOCOL.md) ("Secrets") for the client-facing
contract and `fiducia-node.rs/src/kv.rs` for the server side.
