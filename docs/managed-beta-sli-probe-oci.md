# Managed-beta external probe OCI image

This image packages `scripts/managed-beta-sli-probe.mjs` for deployment at failure-independent probe locations. It is intentionally separate from Prometheus rules/dashboard installation and exact-candidate evidence review.
This image packages `scripts/managed-beta-sli-probe.mjs` for deployment at
failure-independent probe locations. It is intentionally separate from the
Prometheus rules/dashboard and from exact-candidate evidence export.

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
- uses the official Node 22.22.1 Bookworm slim image pinned by multi-platform
  index digest;
- copies only the dependency-free probe script;
- runs as fixed UID/GID `1000:1000`;
- has a fixed Node entrypoint;
- requires no package installation or lifecycle scripts;
- works with a read-only root filesystem when its state and textfile directories
  are explicitly mounted writable;
- receives credentials only through a read-only mounted file referenced by
  `FIDUCIA_PROBE_BEARER_FILE`.

Recommended runtime controls:

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

## Monitoring-topology identity

The probe does not emit or accept `probe_location`. It owns only the bounded
service-side `cell` and `operation_class` values plus its cumulative result
state. The trusted Prometheus scrape/remote-write boundary injects one reviewed
`probe_location` value for the runtime with `honor_labels: false`.

This separation is a security property: an untrusted or compromised probe cannot
claim that one process represents two independent failure domains merely by
changing an environment variable or metric label. The deployment inventory and
independent reviewer must map each trusted scrape-injected location ID to a real
host, scheduler/state authority, credential, and network failure domain.
The process needs outbound access only to the configured Fiducia endpoint and
write access only to its dedicated state/textfile volume. It does not need the
Kubernetes API, Docker socket, host filesystem, service-account token, or
inbound network port.

## Local container contract

Build:
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

After this change merges to `main`, the publish job builds and pushes:
After the source producer PR and this stacked PR merge to `main`, the publish job
builds and pushes:
After merge to `main`, the publish job pushes:

```bash
docker build \
  --pull \
  --file docker/managed-beta-probe.Dockerfile \
  --tag fiducia-managed-beta-probe:test \
  .
```

The CI contract runs the image with a read-only root filesystem, host networking
only for a bounded local fixture, and a writable state volume owned by UID 1000.
It executes the probe twice and requires cumulative success to advance from one
to two without resetting state.

An invocation with missing configuration must fail with exit code 2 and a bounded
policy message. It must not print credential material, customer identifiers, or
response content.

## Publication

After this PR merges to `main`, the publish job builds and pushes:

```text
ghcr.io/fiducia-cloud/fiducia-managed-beta-probe:<full-git-sha>
```

It publishes maximum-mode provenance and an SBOM. No mutable `latest` tag is created. Deployments pin `image@sha256:<digest>`; a commit-SHA tag is only a lookup aid.

## Failure independence

At least two instances must not share the same:
The build publishes maximum-mode provenance and an SBOM. No mutable `latest` tag
is created. Deployment manifests must pin the resulting `image@sha256:<digest>`;
a commit-SHA tag is a lookup aid, not the production identity.

## Failure-independent deployment

At least two probe instances must not share the same:

- physical laptop or Kubernetes cluster;
- ingress process or local reverse proxy;
- DNS resolver/failure path where practical;
- scheduler runtime or state volume;
- credential or runtime identity;
- outbound network/provider failure domain.

Each instance uses one bounded service `cell` and its own persistent state file.
The trusted monitoring configuration gives each instance a unique bounded
`probe_location`. Two replicas sharing one state file are forbidden; two scrape
targets claiming the same trusted location/cell/operation identity trigger the
duplicate-series alert in the managed-beta SLO rules.
- scheduler runtime and state volume;
- credential file or operator identity;
- outbound network/provider failure domain.

Each instance uses a unique bounded `cell`/probe-location identity and its own
persistent state file. Two replicas sharing one state file are forbidden; two
replicas claiming the same Prometheus source identity trigger the duplicate
series alert in the managed-beta SLO rules.

## Evidence maturity

A green image contract and published OCI digest make the producer deployable, not
`instrumented` or `measured`. Instrumentation begins only after named external
locations run the digest-pinned image and central Prometheus receives fresh
cumulative series with trusted scrape-injected location identity. Exact-candidate
measurement still requires the completed window, evidence exporter, and
independent review.
cumulative series. Exact-candidate measurement still requires the completed
window, evidence exporter, and independent review.
Distinct `probe_location` values prove distinct metric lineages, not physical independence by themselves. The exact-candidate exporter therefore requires both the observed location matrix and a separately reviewed independence attestation.

Two replicas sharing a state file are forbidden. Two producers claiming the same complete source identity are a deployment error and must trigger duplicate-source detection in the monitoring layer.

## State migration

Schema-v1 state lacks a location identity and is rejected before any external request. Stop the scheduler, checksum and retain the old file, assign the reviewed location, explicitly migrate validated cumulative fields to schema v2 or start a documented new lineage, and record any reset. Never silently infer a location or discard continuity.

## Evidence maturity

A green image and digest make the producer deployable, not `instrumented`, `queryable`, or `measured`. Those stages require named independent deployments, central scrape/remote-write wiring, location-aware rules and dashboards, a completed observation window, evidence export, and independent review.
cumulative series. Exact-candidate measurement still requires the completed
window, evidence exporter, and independent review.
