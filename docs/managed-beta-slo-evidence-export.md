# Managed-beta SLO evidence export

`export-managed-beta-slo-evidence.mjs` turns one exact Prometheus evaluation
point into a bounded, content-addressed JSON evidence bundle for DEN-1404. It is
an evidence collector, **not** a release signer or go/no-go authority.

## What it records

The exporter sends a fixed reviewed set of PromQL expressions to the Prometheus
instant-query API using POST bodies at the declared measurement-window end:

- 28-day public availability ratio;
- 28-day sample count;
- remaining availability error budget;
- one-hour and six-hour burn rates;
- source freshness;
- age of last success;
- raw cumulative success/failure totals.

It also records:

- full source, GitOps/configuration, and SLO-rules commits;
- immutable image digests keyed by bounded component name;
- declared cells and operation classes;
- opaque failure-independent probe-location IDs and the independence reviewer;
- dashboard UID/version;
- exact RFC3339 start/end timestamps;
- exact PromQL expression, sanitized bounded samples, missing/unexpected source
  identities, and per-query completeness;
- a SHA-256 digest over canonical JSON excluding the integrity field itself.

`candidate_measurement_complete=true` means only that every fixed query returned
exactly the expected low-cardinality source matrix for a 28–35-day window and a
probe-independence attestation was supplied. It does not mean the SLO passed,
that the service is safe to launch, or that an independent reviewer accepted the
broader DEN-1390/DEN-1391 evidence bundle.

## Security and privacy boundary

The Prometheus URL never appears in the exported evidence. Authentication is
accepted only through `FIDUCIA_PROMETHEUS_BEARER_FILE`, which must contain one
bounded line. The query is sent in a POST body instead of a URL.

Returned series may contain only:

- `__name__`;
- `cell`;
- `operation_class`;
- `result` for raw cumulative counters.

An unknown label, duplicate series identity, non-finite value, oversized
response, malformed vector, missing expected source, or unexpected source makes
the measurement incomplete. Raw response bodies and transport errors are reduced
to bounded classifications and never copied into the evidence.

Tenant/project/environment IDs, keys/paths, credentials, endpoints, request IDs,
trace IDs, response content, and unbounded customer-controlled values are
forbidden.

## Configuration

Required environment:

```text
FIDUCIA_PROMETHEUS_URL=https://...
FIDUCIA_PROMETHEUS_BEARER_FILE=/run/secrets/prometheus-reader   # optional
FIDUCIA_PROMETHEUS_TARGET_ID=managed-beta-central
FIDUCIA_SLO_EVIDENCE_OUTPUT=/evidence/availability.json
FIDUCIA_EVIDENCE_DECISION_ID=beta-candidate-2026-07
FIDUCIA_EVIDENCE_WINDOW_START=2026-07-01T00:00:00Z
FIDUCIA_EVIDENCE_WINDOW_END=2026-07-29T00:00:00Z
FIDUCIA_RELEASE_SOURCE_COMMIT=<40-hex>
FIDUCIA_RELEASE_CONFIG_COMMIT=<40-hex>
FIDUCIA_RULES_COMMIT=<40-hex>
FIDUCIA_RELEASE_IMAGE_DIGESTS=fiducia-node=sha256:<64-hex>,fiducia-load-balance=sha256:<64-hex>
FIDUCIA_RELEASE_CELLS=cell-a,cell-b
FIDUCIA_RELEASE_OPERATION_CLASSES=health
FIDUCIA_PROBE_LOCATIONS=probe-a,probe-b
FIDUCIA_PROBE_INDEPENDENCE_ATTESTED=true
FIDUCIA_PROBE_INDEPENDENCE_REVIEWER=reviewer-a
FIDUCIA_DASHBOARD_UID=fiducia-managed-beta-slo
FIDUCIA_DASHBOARD_VERSION=1
```

The measurement window must be between 28 and 35 days. Production Prometheus
must use HTTPS. `FIDUCIA_SLO_EXPORT_ALLOW_INSECURE_LOCALHOST=true` exists only for
bounded local tests.

Run:

```bash
node scripts/export-managed-beta-slo-evidence.mjs
```

The output and lock files are created with restrictive permissions and the final
JSON is atomically replaced. Concurrent exports fail closed without polling.

## Evidence workflow

1. Pin the exact source/config/rules commits and runtime image digests.
2. Confirm at least two failure-independent external probe locations are emitting
   cumulative source series.
3. Choose a completed 28–35-day window and a stable decision ID.
4. Run the exporter using a least-privilege, read-only Prometheus bearer file.
5. Verify `candidate_measurement_complete`, every query's `complete` field, the
   expected source matrix, sample count, source freshness, and integrity digest.
6. Attach the immutable evidence artifact to the release bundle.
7. Have an independent reliability/security reviewer evaluate it with failover,
   restore, tenant-isolation, incident, capacity, and support evidence before any
   go/no-go decision.

## Test coverage

The dependency-free unit suite proves:

- fixed query order and exact evaluation time;
- complete cell/operation/result matrices;
- honest missing-cell and no-data behavior;
- rejection/redaction of customer labels and upstream error bodies;
- exact commit, digest, window, probe-location, and operation-class validation;
- HTTPS-by-default and bounded localhost-only test mode;
- one-line bearer handling before any request;
- duplicate/non-finite series rejection;
- canonical digest verification;
- atomic 0600 output and lock cleanup.
