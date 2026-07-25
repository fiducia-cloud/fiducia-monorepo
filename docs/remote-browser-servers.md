# Driving the deployed browser-automation servers (AWS / Hetzner)

The three browser tiers can drive **remote, deployed browser servers** instead
of downloading a browser on the runner. Today the only such server deployed in
`~/codes/ores/k8s-cluster` is a **Selenium Grid** (`dd-selenium-server`,
`selenium/standalone-chromium`). This document is the verified how-to.

## What is actually deployed, and where

`dd-selenium-server` (namespace `default`,
`remote/argocd/dd-next-runtime/dd-selenium-server.{deployment,service}.yaml`)
runs **two containers**:

- `selenium` — `selenium/standalone-chromium`, the Grid on container port
  **`4444`** (named `grid`).
- `selenium-api` — a Java API on **`8105`** that drives the Grid over
  RemoteWebDriver at `localhost:4444`.

**The Service only publishes `:8105`** (the authenticated Java API). The raw
Grid `:4444` is deliberately **pod-internal** — never an open, unauthenticated
remote-control endpoint. So you cannot `kubectl port-forward svc/dd-selenium-server 4444`;
you forward the **deployment's** container port instead (below).

Cluster health (verified 2026-07-25):

| Cluster | kube access | `dd-selenium-server` |
|---------|-------------|----------------------|
| **AWS EC2** | context `dd-ec2-admin` (direct admin kubeconfig, no SSO) | **2/2 Running** — use this |
| **Hetzner** (`dd-k8s-fsn1/nbg1/hel1`) | SSH bastion `hetzner-k8s-bastion` → in-cluster kubectl | **CrashLoopBackOff** — currently broken |

## Reaching the Grid

### AWS EC2 (the working one)

The `dd-ec2-admin` context authenticates directly (no live AWS SSO needed).
Forward the raw Grid from the deployment:

```sh
KUBECTL_NO_CONFIRM=1 kubectl --context dd-ec2-admin \
  port-forward deploy/dd-selenium-server 4444:4444 -n default
# verify:
curl -s http://localhost:4444/status | jq '.value.ready'   # -> true
```

`kubectl` here is a TTY-confirm wrapper — set `KUBECTL_NO_CONFIRM=1` (or use
`command kubectl`) in scripts.

### Hetzner (via the SSH bastion)

The Hetzner regions are reachable through the bastion (key `~/.ssh/id_hetzner`,
`Host hetzner-k8s-bastion` / `dd-k8s-fsn1` in `~/.ssh/config`). Once the
deployment there is healthy again, tunnel the Grid:

```sh
ssh -L 4444:<selenium-pod-ip>:4444 hetzner-k8s-bastion
# or, if kubectl runs on the cluster, port-forward on the bastion and chain -L.
```

### AWS via SSO (EKS)

`~/.aws` has profiles `dd-cluster` / `dd-codex` with SSO. If the SSO token has
expired (`aws sts get-caller-identity --profile dd-cluster` → InvalidClientTokenId),
refresh it (`aws sso login --profile dd-cluster`) and
`aws eks update-kubeconfig --profile dd-cluster --name <cluster>` before
`kubectl port-forward`.

## Pointing the tests at it

Once the Grid is on `localhost:4444`:

```sh
export FIDUCIA_E2E_SELENIUM_URL=http://localhost:4444    # or SELENIUM_REMOTE_URL
export FIDUCIA_E2E_BROWSER=1
npm run test:browser:selenium          # composed-stack journeys (but see the caveat)
npm run test:chaos:browser             # Selenium files drive deployed endpoints
```

Verified end to end: `launchSelenium()` connects to the deployed AWS Grid and
drives a real Chromium session (`seleniumSkipReason()` returns `false` and a
page loads). An unreachable Grid **skips cleanly** with the reason.

### The localhost-target caveat

The Grid's browser runs **inside the AWS pod**, so it cannot reach a
`localhost` composed stack on your machine. A remote Grid is therefore for:

- **Deployed targets** — `tests/chaos/selenium/`, `tests/multicluster/selenium/`
  (they point at `endpoints()` / the proof topology, reachable from the Grid).
- **A composed stack exposed to the Grid** — set `FIDUCIA_E2E_PUBLIC_BASE_URL`
  to a URL the pod can reach (an ngrok/tunnel or an in-cluster deployment). The
  Selenium journeys call `publicUrlFor()` to rewrite their target origin.

For driving a **local** composed stack, use a **local** browser
(Playwright/Puppeteer download their own) or a local
`docker run -p 4444:4444 selenium/standalone-chromium`.

## Why only Selenium works over the deployed Grid

- **Selenium (RemoteWebDriver)** proxies *every* command through the hub, so a
  port-forward to `:4444` is sufficient. ✅ verified against the AWS Grid.
- **Playwright over a Selenium Grid** does **not** work through a port-forward:
  Playwright obtains a session, then the Grid returns the node's **pod-internal
  CDP address** (e.g. `10.244.0.183:4444`) and Playwright connects to it
  directly — unreachable from the runner (`ETIMEDOUT`). Selenium's WebDriver
  proxying avoids this; CDP-based tools cannot.
- **Puppeteer** speaks CDP, not WebDriver — a Selenium Grid is not a Puppeteer
  endpoint at all.

## Remote hooks for a dedicated Playwright / Puppeteer server

If a dedicated browser server is deployed later, the launch helpers already
honor it (falling back to a local browser when unset):

| Var | Effect |
|-----|--------|
| `FIDUCIA_E2E_SELENIUM_URL` | `launchSelenium()` → RemoteWebDriver against the Grid (`SELENIUM_REMOTE_URL` is a fallback name) |
| `FIDUCIA_E2E_PLAYWRIGHT_WS` | `launchPlaywright()` → `chromium.connect(ws)` to a `playwright run-server` |
| `FIDUCIA_E2E_PUPPETEER_WS` | `launchPuppeteer()` → `puppeteer.connect({ browserWSEndpoint })` to a browserless / Chrome CDP server |

To make Playwright/Puppeteer usable against a deployed server, deploy a
**Playwright browser server** (`npx playwright run-server`, exposes a
`ws://…` endpoint) and/or a **browserless/Chrome** deployment with a
reachable CDP websocket, expose each via a Service the runner can reach (or a
port-forward), and set the matching var above. A Selenium Grid cannot serve
those roles.
