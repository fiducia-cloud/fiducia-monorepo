# webapps

The cross-app **login & separation** layer: proves the two web apps are
completely separate applications that share only the Supabase identity plane
and `fiducia-auth` as its verifier.

Unlike the conformance/chaos layers (which target a deployed endpoint), this
suite **boots the real tier locally** from sibling checkouts:

| Component | Real or stub |
|---|---|
| `fiducia-auth`, `fiducia-admin`, `fiducia-backend` | real (`cargo run` from `../<repo>`) |
| Supabase (GoTrue password/refresh grants, ES256 JWKS, PostgREST orgs) | stub — `@fiducia/test-config/stubs` |
| Fiducia KV (durable API-key store) | stub — same package |
| `fiducia-brain` | stub (empty nodes/placement, `ok` scale) |
| Postgres (admin + customer schemas from `fiducia-interfaces/sql/`) | disposable scratch instance (Homebrew `initdb`/`pg_ctl`) |

What it asserts:

- operator (Supabase `app_metadata.roles` ⊇ `admin`) password login → hardened
  `fiducia_admin_session` cookie (HttpOnly, SameSite=Strict) → dashboard;
- a customer's perfectly valid Supabase credentials/session are **rejected** by
  the admin app (login 403, Bearer 403, sync API 401/403 JSON);
- logout clears the admin cookie;
- customer API serves org-bearing Bearer sessions, and fails closed for: no
  bearer, admin-cookie-only, org-less signups, garbage tokens;
- the same identity plane supports both apps under different authorization
  models (org-scoped data plane vs role-scoped admin plane).

Run (heavyweight: three cargo builds on first run):

```sh
FIDUCIA_E2E_WEBAPPS=1 npm run test:webapps
# or: npm run test:webapps
```

Skips cleanly when `FIDUCIA_E2E_WEBAPPS` is unset, sibling checkouts are missing,
or the required PostgreSQL tools (`initdb`, `pg_ctl`, `createdb`, `psql`) are not
on `PATH`; `FIDUCIA_REPOS_ROOT` overrides the default `..`. The three real
servers are always spawned as one composition so they all point at the same
ephemeral Supabase/KV/Postgres fixtures; independently reusing an existing
server would invalidate that isolation guarantee. Teardown probes the scratch
cluster's `postmaster.pid` before deleting its files, including when startup
returned an ambiguous error.
