# scripts

Standalone maintenance/CI scripts for the suite.

- `lint.mjs` — the dependency-light "lint" run by `npm run lint` and in CI.
  It walks `src/`, `tests/`, and `scripts/`, and syntax-checks every `.mjs`
  with `node --check` (the same parser Node uses to run them). This deliberately
  avoids pulling ESLint so the repo stays dependency-light; it catches parse
  errors before the specs run. The test runner, not this syntax-only check,
  resolves and loads imports.

Scripts here are tooling around the tests, not part of the client or the specs
themselves.
