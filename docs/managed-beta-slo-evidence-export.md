# Managed-beta SLO evidence export

`export-managed-beta-slo-evidence.mjs` turns one exact Prometheus evaluation point into a bounded, content-addressed JSON evidence bundle for DEN-1404 and DEN-1619. It is an evidence collector, not a release signer or go/no-go authority.

## Trusted location-aware evidence contract

The exporter requires at least two declared opaque probe-location IDs and verifies that every declared location is actually observed in the location-scoped source series.

`probe_location` must be injected by reviewed Prometheus scrape or remote-write configuration with `honor_labels: false`. The probe process does not self-assert physical location, and an untrusted target cannot override monitoring-topology identity.

The exporter distinguishes:

- `declared_probe_locations` — reviewed configuration input;
- `observed_probe_locations` — bounded scrape-injected `probe_location` labels returned by Prometheus;
- `location_matrix_complete` — every declared location is present for every required cell/operation source query;
- `independence_attested` — a separate reviewer assertion that the observed locations do not share prohibited physical/runtime/network failure domains.

A declared two-location list does not pass when Prometheus observes only one. Conversely, observing two trusted labels proves two monitoring lineages, not physical independence by itself.

## Fixed reviewed queries

At the exact measurement-window end, the exporter uses POST-body PromQL for:
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
- per-location/cell/operation source freshness;
- per-location/cell/operation age of last success;
- cumulative success/failure counters aggregated by location/cell/operation/result;
- raw-series authority counts aggregated by the same bounded identity.

Aggregate SLO records remain cell-scoped. Source inventory, freshness, last success, and counters retain `probe_location` so one missing source cannot hide inside an aggregate.

The cumulative-counter query uses `max by (cell, operation_class, probe_location, result)` rather than exporting raw scrape series. This removes ordinary Prometheus transport labels such as `job` and `instance` at the reviewed query boundary without widening the evidence schema. A separate `count by (...)` query must return exactly `1` for every bounded identity, so the aggregation cannot hide duplicate scrape or producer authority.

## Recorded identities

The bundle includes:

- full source, GitOps/configuration, and rules commits;
- immutable image digests keyed by bounded component name;
- declared cells, operation classes, and trusted probe locations;
- opaque independence reviewer and central Prometheus target ID;
- dashboard UID/version;
- exact RFC3339 start/end timestamps;
- exact PromQL, sanitized bounded samples, missing/unexpected identities, and query completeness;
- canonical SHA-256 integrity over the unsigned JSON.

`candidate_measurement_complete=true` means:

1. all fixed queries succeeded;
2. each query returned the exact expected bounded matrix;
3. every declared location was observed;
4. every raw-series authority count was exactly one;
5. at least two locations were declared;
6. the independence attestation and reviewer were supplied.

It does not mean the SLO objective passed, the service is safe to launch, or an independent reviewer accepted the broader release bundle.

## Security and cardinality boundary

The Prometheus URL is not exported. Authentication is accepted only through `FIDUCIA_PROMETHEUS_BEARER_FILE`, which must contain one bounded line. Queries are POST bodies rather than URL query strings.

Returned series, after fixed reviewed aggregation, may contain only:

- `__name__`;
- `probe_location` for source queries;
- `cell`;
- `operation_class`;
- `result` for cumulative counters and authority counts.

`probe_location`, `cell`, and `operation_class` must match the declared bounded sets. Unknown labels or undeclared values fail the query without copying upstream content. Scrape-transport labels are removed by fixed PromQL rather than admitted to the evidence allowlist.

Forbidden data includes tenant/project/environment IDs, resource keys/paths, credentials, endpoints, request/trace IDs, response content, scheduler paths, hostnames, IP addresses, site descriptions, and raw error text.

## Configuration

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
FIDUCIA_DASHBOARD_VERSION=2
```

The window must span 28–35 days. Production Prometheus uses HTTPS. Insecure HTTP is accepted only for an explicitly enabled localhost test.
FIDUCIA_DASHBOARD_VERSION=1
```

The measurement window must be between 28 and 35 days. Production Prometheus
must use HTTPS. `FIDUCIA_SLO_EXPORT_ALLOW_INSECURE_LOCALHOST=true` exists only for
bounded local tests.

Run:

```bash
node scripts/export-managed-beta-slo-evidence.mjs
```

Output and lock files use restrictive permissions and atomic replacement. Concurrent exports fail closed without polling.

## Evidence workflow

1. Pin exact source/config/rules commits and runtime digests.
2. Confirm every producer emits the bounded cumulative `cell` / `operation_class` / `result` series with durable counter continuity.
3. Confirm reviewed Prometheus configuration injects one unique bounded `probe_location` per source with `honor_labels: false`.
4. Confirm every bounded location/cell/operation/result identity has exactly one raw scrape authority.
5. Confirm at least two locations are genuinely failure-independent.
6. Install location-aware recording rules, source alerts, and dashboard.
7. Select a completed 28–35-day window and stable decision ID.
8. Run with a least-privilege read-only Prometheus bearer file.
9. Verify query completeness, declared/observed location equality, authority count, sample count, freshness, last-success age, and integrity.
10. Attach the immutable bundle to release evidence and obtain independent reliability/security review.

## Test coverage

The dependency-free suite proves:

- fixed query order and exact evaluation time;
- fixed aggregation removes raw scrape metadata from the evidence boundary;
- duplicate raw authority fails closed even though cumulative totals are aggregated;
- complete location/cell/operation/result matrices;
- one missing location makes evidence incomplete;
- honest missing-cell and no-data behavior;
- unknown/undeclared labels and upstream error bodies are rejected/redacted;
- exact commits, digests, window, locations, operations, and HTTPS policy;
- one-line bearer handling before requests;
- duplicate/non-finite series rejection;
- deterministic canonical digest;
- atomic mode-0600 output and lock cleanup.
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
