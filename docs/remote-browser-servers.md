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

Cluster health (verified 2026-07-25 — each Grid drove a real Chromium session
to a live page, `chrome 131.0.6778.204`):

| Cluster | kube access | `dd-selenium-server` |
|---------|-------------|----------------------|
| **AWS EC2** | context `dd-ec2-admin` (direct admin kubeconfig, no SSO) | **2/2 Running** — verified driving a browser |
| **Hetzner** (`dd-k8s-fsn1/nbg1/hel1`) | SSH bastion `hetzner-k8s-bastion` → in-cluster kubectl | **2/2 Running** across `nbg1` + `hel1` — verified driving a browser |

Both Grids now run **both** containers healthy. The `selenium-api` sidecar
mounts a repo over a `hostPath`; that path used to exist only on the AWS EC2
node (so the sidecar CrashLooped on Hetzner), but the Hetzner deployment is now
healthy too. The Grid (`selenium` container) is what the tests drive; its
readiness is independent of the API sidecar.

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
`Host hetzner-k8s-bastion` in `~/.ssh/config`; `User root`). k3s' kubeconfig is
root-only, so run `sudo -n kubectl` on the bastion. The bastion is a cluster
node, so it routes to the `10.244.x` pod network — tunnel straight to a pod IP
(verified working):

```sh
# 1) find a Grid pod's IP (pick one with 0 restarts):
ssh hetzner-k8s-bastion \
  'sudo -n kubectl -n default get pods -l app=dd-selenium-server -o wide'
# 2) tunnel a local port to that pod's Grid :4444 (use a port other than 4444 if
#    an AWS forward already holds it):
ssh -f -N -L 4446:<selenium-pod-ip>:4444 hetzner-k8s-bastion
curl -s http://localhost:4446/status | jq '.value.ready'   # -> true
export FIDUCIA_E2E_SELENIUM_URL=http://localhost:4446
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

Verified end to end (2026-07-25): `launchSelenium()` connects to **both** the
deployed AWS Grid and a Hetzner Grid (over the pod-IP tunnel above) and drives a
real Chromium session — each loaded `https://example.com` and returned its title
through `chrome 131`. An unreachable Grid **skips cleanly** with the reason.

### The localhost-target caveat

The Grid's browser runs **inside the pod** (AWS/Hetzner), so it cannot reach a
`localhost` composed stack on your machine. A remote Grid is therefore for:

- **Deployed targets** — `tests/chaos/selenium/`, `tests/multicluster/selenium/`
  (they point at `endpoints()` / the proof topology, reachable from the Grid).
- **A composed stack exposed to the Grid** — set `FIDUCIA_E2E_PUBLIC_BASE_URL`
  to a URL the pod can reach (an ngrok/tunnel or an in-cluster deployment). The
  Selenium journeys call `publicUrlFor()` to rewrite their target origin.

**The composed-UI journeys were verified against a _local_ Grid** — a
`docker run -d -p 4445:4444 selenium/standalone-chromium` reached over
`host.docker.internal` — with all **9/9** admin + customer sign-in journeys
green:

```sh
docker run -d --name local-selenium -p 4445:4444 selenium/standalone-chromium
export FIDUCIA_E2E_SELENIUM_URL=http://localhost:4445
export FIDUCIA_E2E_PUBLIC_BASE_URL=http://host.docker.internal   # hostname swap
export FIDUCIA_E2E_BROWSER=1 FIDUCIA_E2E_WEBAPPS=1
node --test 'tests/browser/selenium/**/*.test.mjs'
```

Two things make a **non-loopback** browser work against the stack, both handled
automatically when `FIDUCIA_E2E_PUBLIC_BASE_URL` is set:

- **Origin guard.** The admin/customer servers enforce `require_host` +
  `require_same_origin` on state-changing POSTs (their debug-default origin is
  `http://127.0.0.1:PORT`). A `host.docker.internal` sign-in would otherwise be
  rejected with `{"error":"…_request_rejected","reason":"mismatched_host"}`.
  `bootWebAppStack()` pins each server's port and advertises the matching public
  origin (`FIDUCIA_ADMIN_ORIGIN` / `CUSTOMER_APP_ORIGIN`) so `Host`/`Origin`
  line up — see `src/webapps.mjs` (`originForwarding`).
- **htmx.** The customer `/login` is htmx-enhanced; over WebDriver (no request
  interception) the submit would AJAX-swap the body without changing the URL.
  The Selenium journey calls `neutralizeHtmxForms()` (the WebDriver analogue of
  the Playwright/Puppeteer `htmx.min.js` stub) so the native form POST navigates.

For driving a **local** composed stack you can also just use a **local** browser
(Playwright/Puppeteer download their own).

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
