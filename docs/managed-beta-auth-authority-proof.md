# Managed-beta auth authority proof

This document describes the real-process `AUTH-003` / `AUTH-006` test in
`tests/system/auth-authority.test.mjs`.

## Boundary under test

The production `fiducia-auth` binary has two intentionally different data-plane
surfaces:

1. `POST /v1/introspect` is an internal oracle. It may validate an arbitrary API
   key, so it requires exactly one valid `x-server-auth` credential.
2. `POST /v1/token` is a public possession-based exchange. An internal server
   credential grants no authority; only a valid presented API key can mint a JWT,
   and the JWT inherits that key's organization and scopes.

The dashboard surface accepts Supabase sessions only from the configured project
issuer and audience. Organization and operator roles come from trusted
`app_metadata`; user-editable `user_metadata` is ignored.

## Test environment

The workflow builds the exact candidate `fiducia-auth` commit, starts a bounded
local Supabase/JWKS/system-of-record stub, and then starts the real binary. The
stub uses an ephemeral ES256 key and returns one organization row for the initial
fail-closed startup sync. It does not contact a real Supabase project or store a
customer credential.

## Assertions

- correct issuer, audience, top-level role, AAL, and `app_metadata` are accepted;
- wrong issuer/project, audience, or top-level role are rejected;
- user-editable metadata cannot create organization or operator authority;
- duplicate and comma-coalesced `Authorization` values fail closed;
- missing, wrong, duplicate, reordered, or comma-coalesced `x-server-auth`
  values fail closed;
- one exact server credential can call introspection, but cannot authorize an
  invalid customer key;
- the public token endpoint remains API-key-possession-based and does not accept
  the internal secret as customer authority.

## Evidence classification

A green workflow moves the covered portions of `AUTH-003` and `AUTH-006` to
`automated`. It does **not** mark either row `passed`. Exact release images,
external ingress/header normalization, production certificates/network policy,
revocation propagation, and independent review remain required.
