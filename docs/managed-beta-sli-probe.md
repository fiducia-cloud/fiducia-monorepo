# Managed-beta external SLI probe

`managed-beta-sli-probe.mjs` is the cumulative external availability producer for DEN-1404, DEN-1619, and `SLO-AVAIL-01`. It is a dependency-free one-shot probe intended for a hardened cron container, node-exporter textfile collector, or another bounded scheduler.

## Required deployment shape

Run the probe from at least two failure-independent locations. A probe in the same cluster, laptop, ingress process, DNS path, scheduler, state volume, credential identity, or outbound network failure domain as another source does not satisfy the independence requirement.

Each instance receives bounded configuration and owns one durable state file for one exact `cell` / `operation_class` / `probe_location` identity:

```bash
FIDUCIA_PROBE_ENDPOINT=https://api.example.invalid/healthz \
FIDUCIA_PROBE_CELL=cell-a \
FIDUCIA_PROBE_OPERATION_CLASS=health \
FIDUCIA_PROBE_LOCATION=probe-a \
FIDUCIA_PROBE_EXPECT_STATUS=200 \
FIDUCIA_PROBE_STATE_FILE=/var/lib/fiducia-probe/cell-a-health-probe-a.json \
FIDUCIA_PROBE_TEXTFILE=/var/lib/node_exporter/textfile/fiducia-cell-a-health-probe-a.prom \
node scripts/managed-beta-sli-probe.mjs
```

`probe_location` is an opaque reviewed deployment ID such as `probe-a` or `edge-observer-2`. It must not contain a hostname, IP address, cloud account, home/site description, customer identifier, credential, endpoint, or other free-form value. The evidence bundle separately documents why two opaque IDs are failure-independent.

For an authenticated synthetic operation, mount a short-lived credential in a read-only file and set `FIDUCIA_PROBE_BEARER_FILE`. Never place a bearer in arguments, URLs, metric labels, logs, state, image layers, or the scheduler command line.

The state/textfile directories must be writable only by the probe identity. No state file or credential is shared between probe locations.

## State schema and migration

State schema version 2 adds `probeLocation` to the cumulative authority. Schema-v1 state is rejected before any external operation because its counter lineage cannot be assigned safely to a location after the fact.

To migrate a real source:

1. Stop the scheduler and prove no probe process is running.
2. Choose the reviewed opaque `probe_location` ID.
3. Preserve the schema-v1 file in the restricted evidence store with its checksum.
4. Create a schema-v2 file by copying only the validated cumulative fields and adding the exact location ID, or start a deliberately new lineage under a new state path.
5. Record whether continuity was preserved or reset; never conceal a reset.
6. Restart one location, verify its labels/state, then migrate the second location independently.

Changing `cell`, `operation_class`, or `probe_location` against an existing file fails closed before the request. Do not edit identity merely to silence the check.

## Cumulative authority

Prometheus counters cannot be rewritten to `1` on every invocation. The versioned state contains only:

- bounded cell, operation class, and opaque probe location;
- cumulative success/failure integers;
- last result and duration;
- last-run and last-success timestamps.

Each execution takes an exclusive non-polling lock, validates state identity and counters before making an external request, performs one bounded operation, increments exactly one counter, atomically replaces state, then atomically replaces the textfile. Concurrent runs fail closed.

Writing state before textfile means a crash can leave the scrape file one observation behind; the next valid run re-renders the complete cumulative state rather than double-counting or resetting.

## Emitted series

- `fiducia_external_probe_total{cell,operation_class,probe_location,result}`;
- `fiducia_external_probe_duration_seconds{cell,operation_class,probe_location,result}`;
- `fiducia_external_probe_last_run_unixtime{cell,operation_class,probe_location}`;
- `fiducia_external_probe_last_success_unixtime{cell,operation_class,probe_location}`.

Success and failure counters are always present. Last success remains zero until a real success and survives later failures.

Only bounded `cell`, `operation_class`, `probe_location`, and `result` labels are emitted. Endpoint, path, organization, project, environment, resource key, credential, request/trace ID, response header/body, transport error, scheduler ID, and filesystem path are forbidden.

## Failure semantics

A non-expected status, redirect, timeout, TLS/network error, or connection failure increments `result="failure"` and exits nonzero. Response bodies are consumed only to a fixed bound and never enter metrics or errors.

Configuration, legacy/corrupt/mismatched state, invalid location, counter overflow, and overlapping execution fail separately without issuing or recording an external operation.

HTTP status alone is sufficient only for the health availability probe. Read, write, secret, renewal, and watch SLOs require separately reviewed semantic request/response validators before their operation classes become contractual signals.

## Evidence maturity

Source code and tests do not prove deployment independence. The source remains:

- `specified` until the exact contract exists;
- `instrumented` only after named deployments emit location-scoped series;
- `queryable` only after central Prometheus, location-aware rules, no-data/freshness/duplicate/reset alerts, and dashboards are live;
- `measured` only after a completed exact-candidate window is exported and independently reviewed.
