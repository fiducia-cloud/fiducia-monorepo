# Managed-beta SLO evidence export

`export-managed-beta-slo-evidence.mjs` turns one exact Prometheus evaluation point into a bounded, content-addressed JSON evidence bundle for DEN-1404 and DEN-1619. It is an evidence collector, not a release signer or go/no-go authority.

## Location-aware evidence contract

The exporter requires at least two declared opaque probe-location IDs and now verifies that every declared location is actually observed in the location-scoped source series.

It distinguishes:

- `declared_probe_locations` — reviewed configuration input;
- `observed_probe_locations` — bounded `probe_location` labels returned by Prometheus;
- `location_matrix_complete` — every declared location is present for every required cell/operation source query;
- `independence_attested` — a separate reviewer assertion that the observed locations do not share the prohibited physical/runtime/network failure domains.

A declared two-location list no longer passes when Prometheus contains only one location. Conversely, observing two labels does not by itself prove physical independence.

## Fixed reviewed queries

At the exact measurement-window end, the exporter uses POST-body PromQL for:

- 28-day public availability ratio;
- 28-day sample count;
- remaining availability error budget;
- one-hour and six-hour burn rates;
- per-cell/operation/location source freshness;
- per-cell/operation/location age of last success;
- raw cumulative success/failure counters per cell/operation/location.

Aggregate SLO records remain cell-scoped. Source inventory/freshness/counters retain `probe_location` so one missing or duplicated source cannot hide inside an aggregate.

## Recorded identities

The bundle includes:

- full source, GitOps/configuration, and rules commits;
- immutable image digests keyed by bounded component name;
- declared cells, operation classes, and probe locations;
- opaque independence reviewer and central Prometheus target ID;
- dashboard UID/version;
- exact RFC3339 start/end timestamps;
- exact PromQL, sanitized bounded samples, missing/unexpected identities, and query completeness;
- canonical SHA-256 integrity over the unsigned JSON.

`candidate_measurement_complete=true` means:

1. all fixed queries succeeded;
2. each query returned the exact expected bounded matrix;
3. every declared location was observed;
4. at least two locations were declared;
5. the independence attestation and reviewer were supplied.

It does not mean the SLO objective passed, the service is safe to launch, or an independent reviewer accepted the broader release bundle.

## Security and cardinality boundary

The Prometheus URL is not exported. Authentication is accepted only through `FIDUCIA_PROMETHEUS_BEARER_FILE`, which must contain one bounded line. Queries are POST bodies rather than URL query strings.

Returned series may contain only:

- `__name__`;
- `cell`;
- `operation_class`;
- `probe_location` for source queries;
- `result` for cumulative counters.

`cell`, `operation_class`, and `probe_location` must match the declared bounded sets. Unknown labels or undeclared values fail the query without copying upstream content.

Forbidden data includes tenant/project/environment IDs, resource keys/paths, credentials, endpoints, request/trace IDs, response content, scheduler paths, site descriptions, and raw error text.

## Configuration

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

Run:

```bash
node scripts/export-managed-beta-slo-evidence.mjs
```

Output and lock files use restrictive permissions and atomic replacement. Concurrent exports fail closed without polling.

## Evidence workflow

1. Pin exact source/config/rules commits and runtime digests.
2. Confirm every source emits schema-v2 location-scoped counters.
3. Confirm at least two locations are genuinely failure-independent.
4. Install location-aware recording rules and source alerts.
5. Select a completed 28–35-day window and stable decision ID.
6. Run with a least-privilege read-only Prometheus bearer file.
7. Verify query completeness, declared/observed location equality, sample count, freshness, last-success age, and integrity.
8. Attach the immutable bundle to the release evidence.
9. Obtain independent reliability/security review together with failover, restore, tenant-isolation, incident, capacity, and support evidence.

## Test coverage

The dependency-free suite proves:

- fixed query order and exact evaluation time;
- complete cell/operation/location/result matrices;
- one missing location makes evidence incomplete;
- honest missing-cell and no-data behavior;
- unknown/undeclared labels and upstream error bodies are rejected/redacted;
- exact commits, digests, window, locations, operations, and HTTPS policy;
- one-line bearer handling before requests;
- duplicate/non-finite series rejection;
- deterministic canonical digest;
- atomic mode-0600 output and lock cleanup.
