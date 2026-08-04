# Managed-beta external probe OCI image

This image packages `scripts/managed-beta-sli-probe.mjs` for deployment at
failure-independent probe locations. It is intentionally separate from the
Prometheus rules/dashboard and from exact-candidate evidence export.

## Runtime contract

The image:

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

The process needs outbound access only to the configured Fiducia endpoint and
write access only to its dedicated state/textfile volume. It does not need the
Kubernetes API, Docker socket, host filesystem, service-account token, or
inbound network port.

## Local container contract

Build:

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

After the source producer PR and this stacked PR merge to `main`, the publish job
builds and pushes:

```text
ghcr.io/fiducia-cloud/fiducia-managed-beta-probe:<full-git-sha>
```

The build publishes maximum-mode provenance and an SBOM. No mutable `latest` tag
is created. Deployment manifests must pin the resulting `image@sha256:<digest>`;
a commit-SHA tag is a lookup aid, not the production identity.

## Failure-independent deployment

At least two probe instances must not share the same:

- physical laptop or Kubernetes cluster;
- ingress process or local reverse proxy;
- DNS resolver/failure path where practical;
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
cumulative series. Exact-candidate measurement still requires the completed
window, evidence exporter, and independent review.
