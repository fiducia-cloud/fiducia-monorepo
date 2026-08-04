# Managed-beta external SLI probe

`managed-beta-sli-probe.mjs` is the first concrete producer for DEN-1404 and
`SLO-AVAIL-01`. It is a dependency-free one-shot probe intended for a Prometheus
node-exporter textfile collector, a hardened cron container, or another bounded
scheduler.

## Required deployment shape

Run the probe from at least two failure-independent locations. A probe running in
the same cluster, laptop, DNS path, or ingress process as the service is useful
diagnostics but is not sufficient public-availability evidence.

Each instance receives only bounded configuration and owns one durable state file
for one `cell`/`operation_class` identity:

```bash
FIDUCIA_PROBE_ENDPOINT=https://api.example.invalid/healthz \
FIDUCIA_PROBE_CELL=cell-a \
FIDUCIA_PROBE_OPERATION_CLASS=health \
FIDUCIA_PROBE_EXPECT_STATUS=200 \
FIDUCIA_PROBE_STATE_FILE=/var/lib/fiducia-probe/cell-a-health.json \
FIDUCIA_PROBE_TEXTFILE=/var/lib/node_exporter/textfile/fiducia-cell-a-health.prom \
node scripts/managed-beta-sli-probe.mjs
```

For an authenticated synthetic operation, mount a short-lived credential in a
read-only file and set `FIDUCIA_PROBE_BEARER_FILE`. Do not put the bearer value in
arguments, URLs, metric labels, logs, state, or the systemd/cron command line.

The state and textfile directories must exist and be writable only by the probe
identity. One state file cannot be reused for another cell or operation class.

## Cumulative counter authority

Prometheus counters cannot be rewritten to `1` on every one-shot invocation. The
probe therefore keeps a versioned, bounded local JSON state containing only:

- reviewed cell and operation-class labels;
- cumulative success/failure integers;
- last result and duration;
- last-run and last-success timestamps.

Each execution takes an exclusive `O_EXCL` lock without polling, reads and
validates the state identity/counters, executes one probe, increments exactly one
counter, atomically replaces state, then atomically replaces the textfile. A
concurrent execution fails closed. After a crash, verify that no probe process is
running before removing a stale `.lock` file.

Writing state before textfile means a crash can temporarily leave the scrape file
one observation behind, but the next successful execution re-renders the complete
cumulative state instead of double-counting or resetting the counter.

## Emitted series

- `fiducia_external_probe_total{cell,operation_class,result}` — cumulative success
  and failure samples, both always present;
- `fiducia_external_probe_duration_seconds{cell,operation_class,result}` — most
  recent completed probe duration and bounded last result;
- `fiducia_external_probe_last_run_unixtime{cell,operation_class}`;
- `fiducia_external_probe_last_success_unixtime{cell,operation_class}` — remains
  zero until a real success and is preserved through later failures.

Only bounded `cell`, `operation_class`, and `result` labels are emitted. Endpoint,
path, organization, project, environment, resource key, credential, request ID,
trace ID, response headers/body, and transport error text are never exported.

## Failure semantics

A non-expected HTTP status, redirect, timeout, TLS/network error, or connection
failure increments `result="failure"` and exits nonzero. The response body is
consumed only to a fixed bound and never enters metrics or error output.
Configuration, corrupt-state, identity-mismatch, counter-overflow, and overlapping
run failures exit separately without mutating counters.

HTTP status alone is sufficient only for the health availability probe. Read,
write, secret, renewal, and watch SLOs need separately reviewed semantic request
and response validators before using those operation classes as contractual
signals.

## Evidence maturity

Merging the code and passing unit/redaction tests is only source-level automation.
The SLO source remains `specified` until a named deployment emits the series;
`instrumented` until Prometheus reliably scrapes it; `queryable` until recording
rules, no-data/source-freshness alerts, dashboards, and sample-count views are
installed; and `measured` only after exact-candidate evidence is exported and
independently reviewed.
