# Cron jobs as a service — black-box proof

The cron service conformance layer covers the boundary between replicated
schedules and sandboxed customer code.

Always-on unit tests require no deployment. They verify:

- schedule CRUD/lifecycle route construction and path encoding;
- source, secret, payload, environment, entry-command, and container fields are
  rejected from replicated schedule targets;
- the function client rebuilds `x-server-auth` and `x-fiducia-org-id` without
  forwarding browser `Cookie` or `Authorization` headers;
- W3C trace context and stable invocation idempotency keys are propagated;
- redirects and oversized dependency responses fail closed;
- upstream error bodies do not leak credentials into test output.

Live node conformance uses the normal endpoint variables plus
`FIDUCIA_E2E_INTERNAL_SECRET`. It creates two high-entropy organizations and
proves that a schedule created by one is missing from the other's read and list
surfaces. It also proves pause/resume, idempotent manual trigger identity, bounded
run history, diagnostic fields, and source exclusion from Raft-visible JSON.

Live function conformance additionally uses:

```text
FIDUCIA_E2E_LAMBDA_SERVICE_URL=https://lambda.internal.example
FIDUCIA_E2E_LAMBDA_SERVER_AUTH_SECRET=...
```

The suite creates a managed Node.js draft, proves cross-tenant UUID isolation,
checks and activates the exact revision, invokes it with an idempotency key,
links only its opaque UUID into a node schedule, pauses it, verifies invocation
is disabled, and finally soft-deletes the definition.

Plain HTTP is accepted only for loopback targets when
`FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST=1`. An ordinary run skips live cases when
the relevant service is not configured. The topology/attestation proof runner's
private `FIDUCIA_E2E_STRICT_PROOF=1` switch still makes every missing primitive a
failure.

For staging promotion, `FIDUCIA_E2E_CRON_STRICT=1` applies the same fail-closed
behavior only to the cron and managed-function suite. It does not impersonate a
three-cluster topology proof or relax that proof's attestation requirements.
Missing internal credentials, lambda configuration, cron routes, schedule-run
history, or managed-function capabilities fail instead of becoming skips.

## Staging promotion workflow

`.github/workflows/cron-staging.yml` is both manually dispatchable and reusable
through `workflow_call`. It runs in the protected `staging` GitHub Environment
and requires these environment/caller secrets:

```text
FIDUCIA_E2E_BASE_URL
FIDUCIA_E2E_INTERNAL_SECRET
FIDUCIA_E2E_LAMBDA_SERVICE_URL
FIDUCIA_E2E_LAMBDA_SERVER_AUTH_SECRET
```

Both service URLs must use HTTPS, contain no URL credentials, and contain no
query or fragment. The workflow runs lint, the always-on client contract, then
the strict live schedule/function suite. It uploads a TAP transcript for 14 days
using a high-entropy run namespace. The tests and workflow never echo service
credentials, function source, invocation payloads, or raw upstream response
bodies.

A deployment or promotion workflow should call this reusable workflow after the
staging rollout is ready and before promotion. A successful ordinary PR run is
not staging evidence; the protected-environment strict workflow must pass with
all four inputs configured.

No test logs service credentials, function source, invocation payloads, or raw
upstream response bodies. Ephemeral schedule and function identifiers are
randomized and cleanup runs in `finally` blocks.
