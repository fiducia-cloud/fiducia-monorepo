# scripts

Standalone maintenance/CI scripts for the suite.

- `lint.mjs` — the dependency-light "lint" run by `npm run lint` and in CI.
  It walks `src/`, `tests/`, and `scripts/`, and syntax-checks every `.mjs`
  with `node --check` (the same parser Node uses to run them). This deliberately
  avoids pulling ESLint so the repo stays dependency-light; it catches parse
  errors and unresolved static imports before the specs run.

Scripts here are tooling around the tests, not part of the client or the specs
themselves.
