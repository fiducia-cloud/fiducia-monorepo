// Boot helpers for the coordination system suite (tests/system/).
//
// Composes the REAL coordination tier from sibling checkouts — a 3-node
// fiducia-node Raft cluster with on-disk state plus a fiducia-load-balance in
// front — entirely on localhost. No Docker, no kind, no cloud. This is the
// layer between the per-repo unit tests (in-process loopback clusters) and the
// deployed conformance suite (tests/conformance/ against a live endpoint): it
// proves the *composition* — LB → node routing agreement, leader redirects,
// the trusted-hop internal secret, crash + restart recovery — using the same
// binaries that ship.
//
// Heavyweight (two cargo builds on first run), so the suite is opt-in:
// set FIDUCIA_E2E_SYSTEM=1 (see tests/system/README.md) or `npm run test:system`.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { makeRetryableReverseStop, repoPath, startStubBrain } from "./webapps.mjs";

const NODE_REPO = "fiducia-node.rs";
const LB_REPO = "fiducia-load-balance.rs";

/** Shared trusted-hop secret: the LB injects it, the nodes enforce it. */
export const INTERNAL_SECRET = "e2e-coordination-internal-secret";
export const INTERNAL_AUTH_HEADER = "x-fiducia-internal-auth";

/** Why the suite cannot run here, or `false` if all preconditions hold —
 *  the shape node:test's `{ skip }` expects (`skip: null` would SKIP the
 *  suite while still running its `before` hook). */
export function coordinationSkipReason() {
  if (process.env.FIDUCIA_E2E_SYSTEM !== "1") {
    return "set FIDUCIA_E2E_SYSTEM=1 to run the coordination system suite (builds + boots 3 fiducia-node + 1 fiducia-load-balance)";
  }
  for (const repo of [NODE_REPO, LB_REPO]) {
    if (!existsSync(repoPath(repo))) {
      return `sibling checkout ${repo} not found (set FIDUCIA_REPOS_ROOT)`;
    }
  }
  return false;
}

/** Run a command to completion, failing loudly with its combined output. */
function run(command, args, opts = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(String(chunk)));
    child.stderr.on("data", (chunk) => output.push(String(chunk)));
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else {
        rejectPromise(
          new Error(`${command} ${args.join(" ")} exited ${code}:\n${output.join("").slice(-8192)}`),
        );
      }
    });
  });
}

/** Reserve `count` free localhost ports (bind :0, record, release). */
async function pickPorts(count) {
  const ports = [];
  const servers = [];
  // Hold every listener open until all ports are picked so the OS cannot hand
  // the same port out twice within one call.
  for (let i = 0; i < count; i++) {
    const server = createServer();
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    ports.push(server.address().port);
    servers.push(server);
  }
  await Promise.all(
    servers.map((server) => new Promise((resolvePromise) => server.close(resolvePromise))),
  );
  return ports;
}

/**
 * Spawn a prebuilt server binary and wait for `readyPath` to answer 200.
 * Mirrors @fiducia/test-config `startServer`, minus its port allocation — a
 * Raft cluster needs every member's client AND peer port agreed *before* any
 * member boots, so the caller picks all ports and passes complete env.
 */
async function startProcess({ name, command, args = [], env = {}, url, readyPath = "/healthz", startupTimeoutMs = 60_000 }) {
  let logs = "";
  let spawnError;
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    // A dedicated process group lets stop()/kill() terminate the whole tree.
    detached: process.platform !== "win32",
  });
  const appendLog = (chunk) => {
    logs = (logs + String(chunk)).slice(-64 * 1024);
  };
  child.stdout.on("data", appendLog);
  child.stderr.on("data", appendLog);
  child.on("error", (error) => {
    spawnError = error;
  });

  const killTree = (signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // already gone
    }
  };

  const handle = {
    name,
    url,
    child,
    env,
    logs: () => logs,
    /** SIGKILL the whole tree immediately (crash simulation). */
    kill: () => killTree("SIGKILL"),
    stop: async () => {
      // Already exited (e.g. crashed on purpose): nothing to wait for — and
      // `child.once("exit")` would never fire again.
      if (child.exitCode !== null || child.signalCode !== null) return;
      killTree("SIGTERM");
      const gone = await Promise.race([
        new Promise((resolvePromise) => child.once("exit", () => resolvePromise(true))),
        delay(3_000).then(() => false),
      ]);
      if (!gone) {
        killTree("SIGKILL");
        await new Promise((resolvePromise) => child.once("exit", resolvePromise));
      }
    },
  };

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`${name} failed to spawn: ${spawnError.message}`);
    if (child.exitCode !== null) {
      throw new Error(`${name} exited ${child.exitCode} before becoming ready:\n${logs}`);
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${url}${readyPath}`, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return handle;
    } catch {
      // not up yet
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(150);
  }
  await handle.stop();
  throw new Error(`${name} did not become ready at ${url}${readyPath} within ${startupTimeoutMs}ms:\n${logs}`);
}

/**
 * Build and boot the coordination stack: 3 durable fiducia-node members, one
 * fiducia-load-balance seeded with all three, and a stub brain so the LB's
 * refresh loop stays quiet. Returns handles plus crash/restart controls.
 *
 * @param {{ shardCount?: number, compactThreshold?: number }} [options]
 *   `shardCount` defaults to 4 (few enough that a modest write volume crosses
 *   the per-shard compaction threshold); `compactThreshold` to 16 so the suite
 *   exercises snapshot + truncation and InstallSnapshot catch-up for real.
 */
export async function bootCoordinationStack({ shardCount = 4, compactThreshold = 16 } = {}) {
  const nodeRepo = repoPath(NODE_REPO);
  const lbRepo = repoPath(LB_REPO);

  // Sequential builds: two cargos racing over the shared registry/index lock
  // just serialize anyway, with noisier failure modes.
  await run("cargo", ["build", "--quiet"], { cwd: nodeRepo });
  await run("cargo", ["build", "--quiet"], { cwd: lbRepo });
  const nodeBin = join(nodeRepo, "target", "debug", "fiducia-node");
  const lbBin = join(lbRepo, "target", "debug", "fiducia-load-balance");

  const stack = [];
  const stop = makeRetryableReverseStop(stack);
  const scratch = await mkdtemp(join(tmpdir(), "fiducia-system-"));
  stack.push({ stop: () => rm(scratch, { recursive: true, force: true }) });

  try {
    const brain = await startStubBrain();
    stack.push(brain);

    // [client a, client b, client c, peer a, peer b, peer c, lb]
    const ports = await pickPorts(7);
    const clientPorts = ports.slice(0, 3);
    const peerPorts = ports.slice(3, 6);
    const lbPort = ports[6];

    const names = ["a", "b", "c"];
    const nodes = [];
    const nodeEnv = (i) => ({
      PORT: String(clientPorts[i]),
      FIDUCIA_PEER_PORT: String(peerPorts[i]),
      // The node id doubles as the address redirects advertise, so it must be
      // the CLIENT-plane address the LB can actually proxy to.
      FIDUCIA_NODE_ID: `127.0.0.1:${clientPorts[i]}`,
      // Peers are reached on their PEER plane (/raft lives there).
      FIDUCIA_PEERS: names
        .map((_, j) => j)
        .filter((j) => j !== i)
        .map((j) => `127.0.0.1:${peerPorts[j]}`)
        .join(","),
      FIDUCIA_SHARD_COUNT: String(shardCount),
      FIDUCIA_DATA_DIR: join(scratch, `node-${names[i]}`),
      FIDUCIA_RAFT_COMPACT_THRESHOLD: String(compactThreshold),
      FIDUCIA_INTERNAL_SECRET: INTERNAL_SECRET,
    });
    const spawnNode = (i) =>
      startProcess({
        name: `fiducia-node-${names[i]}`,
        command: nodeBin,
        env: nodeEnv(i),
        url: `http://127.0.0.1:${clientPorts[i]}`,
        startupTimeoutMs: 60_000,
      });

    for (let i = 0; i < names.length; i++) {
      // eslint-disable-next-line no-await-in-loop
      const node = await spawnNode(i);
      nodes.push(node);
      stack.push({
        // Stop whichever process currently backs this slot (it may have been
        // crash-restarted since boot).
        stop: () => nodes[i].stop(),
      });
    }

    const lb = await startProcess({
      name: "fiducia-load-balance",
      command: lbBin,
      env: {
        PORT: String(lbPort),
        FIDUCIA_NODES: clientPorts.map((p) => `127.0.0.1:${p}`).join(","),
        FIDUCIA_SHARD_COUNT: String(shardCount),
        FIDUCIA_BRAIN_URL: brain.url,
        FIDUCIA_INTERNAL_SECRET: INTERNAL_SECRET,
      },
      url: `http://127.0.0.1:${lbPort}`,
      startupTimeoutMs: 60_000,
    });
    stack.push(lb);

    return {
      shardCount,
      compactThreshold,
      lbUrl: lb.url,
      nodeUrls: nodes.map((n) => n.url),
      /** Captured stdout+stderr of a member: "lb" or a node index. */
      logsOf: (which) => (which === "lb" ? lb.logs() : nodes[which]?.logs()),
      /** SIGKILL node `i`'s whole process tree (simulated crash). */
      crashNode: (i) => nodes[i].kill(),
      /** Reboot node `i` on its surviving data dir; replaces the handle. */
      restartNode: async (i) => {
        await nodes[i].stop();
        nodes[i] = await spawnNode(i);
        return nodes[i];
      },
      stop,
    };
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "coordination stack startup and cleanup failed");
    }
    throw error;
  }
}
