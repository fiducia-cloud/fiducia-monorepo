# fiducia-e2e docs

Deeper references for the end-to-end suite. Start with the repo
[`README.md`](../README.md) for run modes, environment variables, the strict
proof runner, and the test-layer map; these documents go deeper on specific
subsystems.

| Doc | What it covers |
|-----|----------------|
| [browser-automation.md](browser-automation.md) | The Selenium/Playwright/Puppeteer browser tiers: the per-framework layout, the composed web/auth stack, the htmx-neutralisation + fetch-through-page patterns, the gotchas (hidden-input visibility, duplicate `action` selectors, DB-backed 503s), and what each suite certifies. |
| [remote-browser-servers.md](remote-browser-servers.md) | Driving the **deployed** browser servers in `~/codes/ores/k8s-cluster` on AWS (`dd-ec2-admin`, working) and Hetzner (SSH bastion): reaching the Grid, port-forwarding the pod-internal `:4444`, the localhost-target caveat, and why only Selenium — not Playwright/Puppeteer — works through a port-forwarded Grid. |
| [local-node-conformance.md](local-node-conformance.md) | Booting a single local `fiducia-node` and running the coordination conformance suite (incl. the end-user **secrets** API) against it end to end, with the auth/HTTPS/port gotchas. |

## Quick map

- **Coordination correctness** without a browser → `tests/conformance/` against
  a deployed endpoint or a [local node](local-node-conformance.md).
- **Product journeys through a real browser** → `tests/browser/` (boots the
  composed stack) — see [browser-automation.md](browser-automation.md).
- **Deployed browsers** (Selenium Grid on AWS/Hetzner) →
  [remote-browser-servers.md](remote-browser-servers.md).
- **Resilience / cross-cluster** → `tests/chaos/`, `tests/multicluster/`
  (fetch-level and browser-driven variants).
