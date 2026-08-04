# Managed-beta external probe OCI image

This image packages `scripts/managed-beta-sli-probe.mjs` for deployment at failure-independent probe locations. It is intentionally separate from Prometheus rules/dashboard installation and exact-candidate evidence review.

## Runtime contract

The image:

- uses the official Node 22.22.1 Bookworm slim image pinned by multi-platform digest;
- copies only the dependency-free probe script;
- runs as fixed UID/GID `1000:1000` with a fixed Node entrypoint;
- requires no package installation or lifecycle scripts;
- supports a read-only root filesystem with explicitly mounted state/textfile storage;
- receives credentials only through a read-only file referenced by `FIDUCIA_PROBE_BEARER_FILE`;
- requires `FIDUCIA_PROBE_LOCATION` as an opaque bounded source identity;
- stores schema-v2 cumulative state keyed by `cell`, `operationClass`, and `probeLocation`.

Recommended controls:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 1000
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
seccompProfile:
  type: RuntimeDefault
```

The process needs outbound access only to the configured HTTPS Fiducia endpoint and write access only to its dedicated state/textfile volume. It does not need Kubernetes API access, a service-account token, Docker socket, host filesystem, privileged capability, or inbound port.

## Per-location invocation

```text
FIDUCIA_PROBE_ENDPOINT=https://api.example.invalid/healthz
FIDUCIA_PROBE_CELL=cell-a
FIDUCIA_PROBE_OPERATION_CLASS=health
FIDUCIA_PROBE_LOCATION=probe-a
FIDUCIA_PROBE_STATE_FILE=/state/cell-a-health-probe-a.json
FIDUCIA_PROBE_TEXTFILE=/state/cell-a-health-probe-a.prom
```

Each location has its own:

- opaque `probe_location` label;
- image digest and runtime revision;
- scheduler/runtime identity;
- state volume and file;
- credential file and revocation path;
- outbound network and operator owner.

Do not place hostnames, IPs, cloud accounts, home/site descriptions, endpoints, credential versions, or customer identifiers in `probe_location`. Document physical independence separately in restricted evidence.

## Local container contract

CI builds the image, verifies its fixed non-root metadata, runs it under a read-only root filesystem, and executes the same location-scoped source twice. The contract requires:

- success counter advances to two without reset;
- failure counter remains zero;
- metrics contain the exact `probe_location`;
- state is schema version 2 and contains the same location identity;
- state and textfile modes are `0600`;
- endpoint and credential-shaped values are absent.

Missing endpoint or missing location configuration fails with exit code 2 and a bounded policy message.

## Publication

After merge to `main`, the publish job pushes:

```text
ghcr.io/fiducia-cloud/fiducia-managed-beta-probe:<full-git-sha>
```

It publishes maximum-mode provenance and an SBOM. No mutable `latest` tag is created. Deployments pin `image@sha256:<digest>`; a commit-SHA tag is only a lookup aid.

## Failure independence

At least two instances must not share the same:

- physical laptop or Kubernetes cluster;
- ingress process or local reverse proxy;
- DNS resolver/failure path where practical;
- scheduler runtime or state volume;
- credential or runtime identity;
- outbound network/provider failure domain.

Distinct `probe_location` values prove distinct metric lineages, not physical independence by themselves. The exact-candidate exporter therefore requires both the observed location matrix and a separately reviewed independence attestation.

Two replicas sharing a state file are forbidden. Two producers claiming the same complete source identity are a deployment error and must trigger duplicate-source detection in the monitoring layer.

## State migration

Schema-v1 state lacks a location identity and is rejected before any external request. Stop the scheduler, checksum and retain the old file, assign the reviewed location, explicitly migrate validated cumulative fields to schema v2 or start a documented new lineage, and record any reset. Never silently infer a location or discard continuity.

## Evidence maturity

A green image and digest make the producer deployable, not `instrumented`, `queryable`, or `measured`. Those stages require named independent deployments, central scrape/remote-write wiring, location-aware rules and dashboards, a completed observation window, evidence export, and independent review.
