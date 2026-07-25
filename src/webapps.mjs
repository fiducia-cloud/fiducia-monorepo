// Boot helpers for the web-app login/separation suite (tests/webapps/).
//
// Composes the REAL web/auth tier from sibling checkouts — fiducia-auth,
// fiducia-backend (customer portal BFF), fiducia-admin (operator dashboard) —
// against the stub Supabase + stub Fiducia-KV fixtures from
// @fiducia/test-config/stubs, plus a disposable scratch Postgres and a stub
// fiducia-brain. No live Supabase, no Docker, no cluster.
//
// Everything here is heavyweight (three cargo builds on first run), so the
// suite is opt-in: set FIDUCIA_E2E_WEBAPPS=1 (see tests/webapps/README).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const E2E_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Sibling checkout of another fiducia repo (override root via FIDUCIA_REPOS_ROOT). */
export function repoPath(name) {
  return join(process.env.FIDUCIA_REPOS_ROOT ?? resolve(E2E_ROOT, ".."), name);
}

/**
 * The `cargo` to build/run sibling Rust repos with. Prefer a rustup **proxy**
 * over whatever `cargo` sits first on PATH: the fiducia repos pin their
 * toolchain in `rust-toolchain.toml`, and only the proxy honors that pin — a
 * plain distro/Homebrew cargo ignores it and fails `rust-version` checks
 * (e.g. fiducia-customer requires 1.97 while Homebrew ships something else).
 * Override with FIDUCIA_E2E_CARGO.
 */
export function cargoCommand() {
  if (process.env.FIDUCIA_E2E_CARGO) return process.env.FIDUCIA_E2E_CARGO;
  const home = process.env.HOME ?? "";
  for (const candidate of [
    join(home, ".cargo", "bin", "cargo"), // rustup's default proxy location
    "/opt/homebrew/opt/rustup/bin/cargo", // Homebrew rustup (Apple Silicon)
    "/usr/local/opt/rustup/bin/cargo", // Homebrew rustup (Intel)
  ]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "cargo";
}

/**
 * Env overrides that make the WHOLE toolchain honor the repo pin, not just the
 * top-level cargo: cargo shells out to `rustc` via PATH, so the proxy's
 * directory must come first or a distro rustc (wrong version) answers.
 */
export function cargoEnv() {
  const cargo = cargoCommand();
  if (cargo === "cargo") return {};
  return { PATH: `${dirname(cargo)}${delimiter}${process.env.PATH ?? ""}` };
}

function commandOnPath(name) {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => existsSync(join(dir, name)));
}

/** Why the suite cannot run here, or null if all preconditions hold. */
export function webAppsSkipReason() {
  if (process.env.FIDUCIA_E2E_WEBAPPS !== "1") {
    return "set FIDUCIA_E2E_WEBAPPS=1 to run the web-app login suite (boots 3 cargo servers + scratch Postgres)";
  }
  if (!existsSync(join(E2E_ROOT, "node_modules", "@fiducia", "test-config", "package.json"))) {
    return "@fiducia/test-config is not installed (run npm ci from fiducia-e2e)";
  }
  for (const repo of ["fiducia-auth.rs", "fiducia-customer.rs", "fiducia-admin.rs", "fiducia-interfaces"]) {
    if (!existsSync(repoPath(repo))) {
      return `sibling checkout ${repo} not found (set FIDUCIA_REPOS_ROOT)`;
    }
  }
  for (const command of ["initdb", "pg_ctl", "createdb", "psql"]) {
    if (!commandOnPath(command)) {
      return `PostgreSQL tool ${command} not found on PATH`;
    }
  }
  return null;
}

function run(command, args, opts = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    child.stdout.on("data", (c) => output.push(String(c)));
    child.stderr.on("data", (c) => output.push(String(c)));
    child.on("error", rejectPromise);
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise(output.join(""))
        : rejectPromise(new Error(`${command} ${args.join(" ")} exited ${code}:\n${output.join("")}`)),
    );
  });
}

async function availableLoopbackPort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolvePromise, rejectPromise) =>
    server.close((error) => (error ? rejectPromise(error) : resolvePromise())),
  );
  if (!port) throw new Error("failed to allocate a loopback port for scratch Postgres");
  return port;
}

/**
 * Read PostgreSQL's authoritative postmaster PID and probe the process. A
 * malformed pid file is an error: cleanup must not guess that deletion is safe.
 */
export async function postmasterIsAlive(dataDir) {
  let raw;
  try {
    raw = await readFile(join(dataDir, "postmaster.pid"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }

  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim();
  const pid = Number(firstLine);
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`invalid PostgreSQL postmaster.pid in ${dataDir}`);
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

/**
 * A throwaway Postgres in a temp dir (Homebrew initdb/pg_ctl; trust auth,
 * loopback only). `databases` maps database name -> schema .sql to apply.
 */
export async function startDisposablePostgres({ databases = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "fiducia-e2e-pg-"));
  const dataDir = join(dir, "data");
  // Without a valid locale macOS postmaster aborts with "became multithreaded
  // during startup"; pin C so the scratch instance boots in any environment.
  const pgEnv = { env: { ...process.env, LC_ALL: "C", LANG: "C" } };
  let started = false;
  let cleaned = false;
  let cleanupPromise;
  const cleanup = () => {
    if (cleaned) return Promise.resolve();
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const errors = [];
      let live;
      try {
        live = await postmasterIsAlive(dataDir);
      } catch (error) {
        errors.push(error);
      }

      let stopError;
      if (live || started) {
        try {
          await run("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], pgEnv);
        } catch (error) {
          stopError = error;
        }
      }

      try {
        live = await postmasterIsAlive(dataDir);
        started = live;
      } catch (error) {
        live = undefined;
        errors.push(error);
      }
      // Never delete a cluster directory if its postmaster failed to stop. A
      // later cleanup call retries the stop instead of stranding a live process
      // whose data directory has vanished.
      if (live === false) {
        try {
          await rm(dir, { recursive: true, force: true });
          cleaned = true;
        } catch (error) {
          errors.push(error);
        }
      } else if (stopError) {
        errors.push(stopError);
      } else if (live === true) {
        errors.push(new Error("scratch PostgreSQL postmaster is still alive after stop"));
      }
      if (errors.length) {
        throw new AggregateError(errors, "failed to clean up scratch Postgres");
      }
    })().finally(() => {
      cleanupPromise = undefined;
    });
    return cleanupPromise;
  };

  try {
    await run("initdb", ["-D", dataDir, "-A", "trust", "-U", "postgres"], pgEnv);
    const port = await availableLoopbackPort();
    await run("pg_ctl", [
      "-D", dataDir,
      // TCP-only: macOS caps unix-socket paths at 103 bytes, and deep tmpdirs
      // (CI, sandboxes) blow past it. All clients connect via -h 127.0.0.1.
      "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`,
      "-l", join(dir, "pg.log"),
      "-w", "start",
    ], pgEnv);
    // The PID probe remains the cleanup authority if pg_ctl reports an
    // ambiguous startup error; this flag records the normal successful path.
    started = true;
    const psqlBase = ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres"];
    for (const [name, schemaSql] of Object.entries(databases)) {
      await run("createdb", [...psqlBase, name], pgEnv);
      if (schemaSql) {
        await run("psql", [...psqlBase, "-d", name, "-v", "ON_ERROR_STOP=1", "-f", schemaSql], pgEnv);
      }
    }
    return {
      port,
      url: (db) => `postgres://postgres@127.0.0.1:${port}/${db}`,
      sql: (db, statement) => run("psql", [...psqlBase, "-d", db, "-v", "ON_ERROR_STOP=1", "-c", statement], pgEnv),
      stop: cleanup,
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "scratch Postgres startup and cleanup failed");
    }
    throw error;
  }
}

/** Stub fiducia-brain: just enough for the admin /infra surface. */
export async function startStubBrain() {
  const server = createServer((req, res) => {
    const respond = (body) => {
      const payload = JSON.stringify(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
    };
    if (req.url.startsWith("/v1/nodes")) return respond({ nodes: [] });
    if (req.url.startsWith("/v1/placement")) return respond({ shards: [] });
    if (req.url.startsWith("/v1/scale")) return respond({ ok: true });
    respond({ ok: true });
  });
  const url = await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () =>
      resolvePromise(`http://127.0.0.1:${server.address().port}`),
    );
  });
  return {
    url,
    stop: () =>
      new Promise((resolvePromise) => {
        server.closeAllConnections?.();
        server.close(() => resolvePromise());
      }),
  };
}

export const OPERATOR = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "ops@fiducia.cloud",
  password: "operator-pw",
  app_metadata: { orgs: ["org_infra"], roles: ["admin"] },
};
export const CUSTOMER = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "dev@acme.com",
  password: "customer-pw",
  app_metadata: { orgs: ["00000000-0000-4000-8000-000000000001"] },
};
/**
 * A customer whose account already carries a verified TOTP authenticator. Login
 * through the passwordless (OTP) path therefore forces aal1→aal2 step-up: the
 * primary factor succeeds, but the app parks the interim token in the MFA-pending
 * cookie and demands the authenticator code before issuing the session cookie.
 * Same org as CUSTOMER so fiducia-auth admits the finalized session.
 */
export const CUSTOMER_MFA = {
  id: "44444444-4444-4444-8444-444444444444",
  email: "mfa@acme.com",
  password: "customer-mfa-pw",
  app_metadata: { orgs: ["00000000-0000-4000-8000-000000000001"] },
  factors: [{ factor_type: "totp", status: "verified", friendly_name: "Authy" }],
};
/** The fixed one-time / authenticator code the stub Supabase accepts (see stubs.mjs). */
export const STUB_TOTP_CODE = "123456";
/** The fixed email/SMS OTP code the stub Supabase accepts (see stubs.mjs). */
export const STUB_OTP_CODE = "123456";
export const ORGLESS = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "new-signup@example.com",
  password: "orgless-pw",
  app_metadata: {},
};

/** Stop all successfully cleaned entries in reverse order, retaining failures. */
export async function stopStackInReverse(stack) {
  const errors = [];
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    try {
      await stack[index].stop();
      stack.splice(index, 1);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "one or more web-app stack services failed to stop");
  }
}

/** Coalesce concurrent stops, but allow a failed cleanup to be retried. */
export function makeRetryableReverseStop(stack) {
  let stopPromise;
  return () => {
    if (stopPromise) return stopPromise;
    stopPromise = stopStackInReverse(stack).finally(() => {
      stopPromise = undefined;
    });
    return stopPromise;
  };
}

/**
 * Boot the whole tier. Returns stubs, service URLs, and stop() (reverse order).
 * A `grant(user)` helper password-grants a Supabase session from the stub the
 * same way each app's login does.
 */
export async function bootWebAppStack() {
  // Keep the core conformance image dependency-free. The local harness is
  // loaded only after the opt-in suite has verified all of its prerequisites.
  const [{ startServer }, { fiduciaAuthStubEnv, startStubFiduciaKv, startStubSupabase }] =
    await Promise.all([
      import("@fiducia/test-config/harness"),
      import("@fiducia/test-config/stubs"),
    ]);
  const stack = [];
  const stop = makeRetryableReverseStop(stack);

  // When the browser reaches the stack through a NON-loopback host — a remote or
  // containerised Selenium grid addressed via FIDUCIA_E2E_PUBLIC_BASE_URL — the
  // admin/customer request-origin guard (require_host + require_same_origin)
  // correctly rejects the state-changing POSTs: their debug-default origin is
  // http://127.0.0.1:PORT, but the browser's Host/Origin is that public host, so
  // sign-in fails with {"error":"…_request_rejected","reason":"mismatched_host"}.
  // Pin each such server's port up front so we can advertise the MATCHING public
  // origin (same port, swapped hostname) before it boots. Identity when unset —
  // Playwright/Puppeteer drive http://127.0.0.1 directly and need no rewrite.
  const publicHost = process.env.FIDUCIA_E2E_PUBLIC_BASE_URL?.trim()
    ? new URL(process.env.FIDUCIA_E2E_PUBLIC_BASE_URL).hostname
    : null;
  const pinnedPort = () => 19000 + Math.floor(Math.random() * 1000);
  /** For a server whose origin guard reads `originEnv`, force a fixed port and
   *  advertise `http://<publicHost>:<port>` so a non-loopback browser passes.
   *  Returns `{ env, opts }` to spread into the startServer call ({} when the
   *  stack is loopback-only). publicUrlFor() keeps that same port, swapping only
   *  the hostname, so the two agree. */
  const originForwarding = (originEnv) => {
    if (!publicHost) return { env: {}, opts: {} };
    const port = pinnedPort();
    return {
      env: { [originEnv]: `http://${publicHost}:${port}` },
      opts: { portRange: [port, port] },
    };
  };

  try {
    const supabase = await startStubSupabase({
      users: [OPERATOR, CUSTOMER, ORGLESS, CUSTOMER_MFA],
      orgs: [
        { id: "org_infra", plan: "internal" },
        { id: "00000000-0000-4000-8000-000000000001", plan: "pro" },
      ],
    });
    stack.push(supabase);
    const kv = await startStubFiduciaKv();
    stack.push(kv);
    const brain = await startStubBrain();
    stack.push(brain);

    const interfacesSql = join(repoPath("fiducia-interfaces"), "sql");
    const postgres = await startDisposablePostgres({
      databases: {
        fiducia_admin: join(interfacesSql, "admin.sql"),
        fiducia_customer: join(interfacesSql, "customer.sql"),
      },
    });
    stack.push(postgres);

    // Admin entry is defense-in-depth: the Supabase app_metadata role AND an
    // enabled row in the admin plane's operators registry.
    await postgres.sql(
      "fiducia_admin",
      `insert into operators (supabase_user_id, email, role) values ('${OPERATOR.id}', '${OPERATOR.email}', 'admin')`,
    );

    const auth = await startServer({
      command: cargoCommand(),
      args: ["run", "--quiet"],
      cwd: repoPath("fiducia-auth.rs"),
      env: {
        ...cargoEnv(),
        ...fiduciaAuthStubEnv(supabase, kv),
        FIDUCIA_INTROSPECT_SECRET: "e2e-introspect-secret",
        // fiducia-auth signs its KV requests
        // and HMACs key-mutation idempotency records.
        FIDUCIA_INTERNAL_SECRET: "e2e-internal-secret",
        // ≥32 bytes or fiducia-auth refuses to boot (WeakIdempotencySecret).
        FIDUCIA_KEY_IDEMPOTENCY_SECRET: "e2e-key-idempotency-secret-0123456789abcdef",
        CUSTOMER_API_KEY_PEPPER: "e2e-api-key-pepper-0123456789abcdef",
        CUSTOMER_API_KEY_HASH_ALGORITHM: "hmac-sha256",
      },
      readyPath: "/healthz",
      startupTimeoutMs: 300000,
    });
    stack.push(auth);

    const adminOrigin = originForwarding("FIDUCIA_ADMIN_ORIGIN");
    const admin = await startServer({
      command: cargoCommand(),
      args: ["run", "--quiet"],
      cwd: repoPath("fiducia-admin.rs"),
      ...adminOrigin.opts,
      env: {
        ...cargoEnv(),
        DATABASE_URL: postgres.url("fiducia_admin"),
        FIDUCIA_AUTH_URL: auth.url,
        FIDUCIA_BRAIN_URL: brain.url,
        FIDUCIA_INTERNAL_SECRET: "e2e-internal-secret",
        SUPABASE_URL: supabase.url,
        SUPABASE_PUBLISHABLE_KEY: "stub-publishable-key",
        FIDUCIA_INSECURE_COOKIES: "1",
        ...adminOrigin.env,
      },
      readyPath: "/healthz",
      startupTimeoutMs: 300000,
    });
    stack.push(admin);

    const customerDist = join(repoPath("fiducia-customer-ui.web"), "dist");
    const marketingDist = join(repoPath("fiducia-marketing.web"), "dist");
    const customerOrigin = originForwarding("CUSTOMER_APP_ORIGIN");
    const backend = await startServer({
      command: cargoCommand(),
      args: ["run", "--quiet"],
      cwd: repoPath("fiducia-customer.rs"),
      ...customerOrigin.opts,
      env: {
        ...cargoEnv(),
        DATABASE_URL: postgres.url("fiducia_customer"),
        FIDUCIA_AUTH_URL: auth.url,
        FIDUCIA_SITE_MODE: "customer",
        SUPABASE_URL: supabase.url,
        SUPABASE_PUBLISHABLE_KEY: "stub-publishable-key",
        ...customerOrigin.env,
        // Debug-only: emit non-Secure session/CSRF/MFA cookies so the browser
        // jar is inspectable over http://127.0.0.1 (Playwright's cookies(url)
        // filters Secure cookies out of http origins). Mirrors the admin server.
        FIDUCIA_INSECURE_COOKIES: "1",
        ...(existsSync(customerDist) ? { CUSTOMER_STATIC_DIR: customerDist } : {}),
        ...(existsSync(marketingDist) ? { STATIC_DIR: marketingDist } : {}),
      },
      readyPath: "/healthz",
      startupTimeoutMs: 300000,
    });
    stack.push(backend);

    const grant = async (user) => {
      const response = await fetch(`${supabase.url}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: "stub-publishable-key" },
        body: JSON.stringify({ email: user.email, password: user.password }),
      });
      if (!response.ok) {
        throw new Error(`stub password grant failed: HTTP ${response.status}`);
      }
      return (await response.json()).access_token;
    };

    return { supabase, kv, brain, postgres, auth, admin, backend, grant, stop };
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "web-app stack startup and cleanup failed");
    }
    throw error;
  }
}

/** Parse Set-Cookie headers into { name: { value, attributes: Set<lowercase> } }. */
export function parseSetCookies(response) {
  const cookies = {};
  for (const header of response.headers.getSetCookie?.() ?? []) {
    const [pair, ...attributeParts] = header.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    cookies[name] = {
      value: pair.slice(eq + 1).trim(),
      attributes: new Set(attributeParts.map((a) => a.trim().toLowerCase())),
      raw: header,
    };
  }
  return cookies;
}
