# scripts

Standalone maintenance/CI scripts for the suite.

- `lint.mjs` — the dependency-light "lint" run by `npm run lint` and in CI.
  It walks `src/`, `tests/`, and `scripts/`, and syntax-checks every `.mjs`
  with `node --check` (the same parser Node uses to run them). This deliberately
  avoids pulling ESLint so the repo stays dependency-light; it catches parse
  errors before the specs run. The test runner, not this syntax-only check,
  resolves and loads imports.
- `dev-stack.mjs` — boots the real sibling `fiducia-auth`, `fiducia-admin`, and
  `fiducia-backend` servers against disposable loopback-only Postgres and local
  Supabase, Fiducia KV, and brain stubs. It prints the local URLs and deterministic
  test-only accounts, then tears every process and temporary database down on
  `SIGINT`/`SIGTERM`. Set `FIDUCIA_REPOS_ROOT` when the sibling checkouts are not
  adjacent to this repository. PostgreSQL command-line tools must be on `PATH`.

Scripts here are tooling around the tests, not part of the client or the specs
themselves.
