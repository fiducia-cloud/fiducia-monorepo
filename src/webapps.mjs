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
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startServer } from "@fiducia/test-config/harness";
import {
  fiduciaAuthStubEnv,
  startStubFiduciaKv,
  startStubSupabase,
} from "@fiducia/test-config/stubs";

const E2E_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Sibling checkout of another fiducia repo (override root via FIDUCIA_REPOS_ROOT). */
export function repoPath(name) {
  return join(process.env.FIDUCIA_REPOS_ROOT ?? resolve(E2E_ROOT, ".."), name);
}

/** Why the suite cannot run here, or null if all preconditions hold. */
export function webAppsSkipReason() {
  if (process.env.FIDUCIA_E2E_WEBAPPS !== "1") {
    return "set FIDUCIA_E2E_WEBAPPS=1 to run the web-app login suite (boots 3 cargo servers + scratch Postgres)";
  }
  for (const repo of ["fiducia-auth.rs", "fiducia-backend.rs", "fiducia-admin.rs", "fiducia-interfaces"]) {
    if (!existsSync(repoPath(repo))) {
      return `sibling checkout ${repo} not found (set FIDUCIA_REPOS_ROOT)`;
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

/**
 * A throwaway Postgres in a temp dir (Homebrew initdb/pg_ctl; trust auth,
 * loopback only). `databases` maps database name -> schema .sql to apply.
 */
export async function startDisposablePostgres({ databases = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "fiducia-e2e-pg-"));
  const dataDir = join(dir, "data");
  await run("initdb", ["-D", dataDir, "-A", "trust", "-U", "postgres"]);
  const port = 21000 + Math.floor(Math.random() * 1000);
  await run("pg_ctl", [
    "-D", dataDir,
    // TCP-only: macOS caps unix-socket paths at 103 bytes, and deep tmpdirs
    // (CI, sandboxes) blow past it. All clients connect via -h 127.0.0.1.
    "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`,
    "-l", join(dir, "pg.log"),
    "-w", "start",
  ]);
  const psqlBase = ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres"];
  for (const [name, schemaSql] of Object.entries(databases)) {
    await run("createdb", [...psqlBase, name]);
    if (schemaSql) {
      await run("psql", [...psqlBase, "-d", name, "-v", "ON_ERROR_STOP=1", "-f", schemaSql]);
    }
  }
  return {
    port,
    url: (db) => `postgres://postgres@127.0.0.1:${port}/${db}`,
    sql: (db, statement) => run("psql", [...psqlBase, "-d", db, "-v", "ON_ERROR_STOP=1", "-c", statement]),
    stop: async () => {
      await run("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"]).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
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
export const ORGLESS = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "new-signup@example.com",
  password: "orgless-pw",
  app_metadata: {},
};

/**
 * Boot the whole tier. Returns stubs, service URLs, and stop() (reverse order).
 * A `grant(user)` helper password-grants a Supabase session from the stub the
 * same way each app's login does.
 */
export async function bootWebAppStack() {
  const stack = [];
  const stop = async () => {
    for (const stoppable of stack.reverse()) {
      await stoppable.stop();
    }
  };

  try {
    const supabase = await startStubSupabase({
      users: [OPERATOR, CUSTOMER, ORGLESS],
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
      command: "cargo",
      args: ["run", "--quiet"],
      cwd: repoPath("fiducia-auth.rs"),
      env: {
        ...fiduciaAuthStubEnv(supabase, kv),
        FIDUCIA_INTROSPECT_SECRET: "e2e-introspect-secret",
        // Required at boot since efeaebe: fiducia-auth signs its KV requests.
        FIDUCIA_INTERNAL_SECRET: "e2e-internal-secret",
      },
      readyPath: "/healthz",
      reuseUrlEnv: "FIDUCIA_AUTH_TEST_URL",
      startupTimeoutMs: 300000,
    });
    stack.push(auth);

    const admin = await startServer({
      command: "cargo",
      args: ["run", "--quiet"],
      cwd: repoPath("fiducia-admin.rs"),
      env: {
        DATABASE_URL: postgres.url("fiducia_admin"),
        FIDUCIA_AUTH_URL: auth.url,
        FIDUCIA_BRAIN_URL: brain.url,
        FIDUCIA_INTERNAL_SECRET: "e2e-internal-secret",
        SUPABASE_URL: supabase.url,
        SUPABASE_PUBLISHABLE_KEY: "stub-publishable-key",
        FIDUCIA_INSECURE_COOKIES: "1",
      },
      readyPath: "/healthz",
      reuseUrlEnv: "FIDUCIA_ADMIN_TEST_URL",
      startupTimeoutMs: 300000,
    });
    stack.push(admin);

    const customerDist = join(repoPath("fiducia-customer-ui.web"), "dist");
    const marketingDist = join(repoPath("fiducia-ui.web"), "dist");
    const backend = await startServer({
      command: "cargo",
      args: ["run", "--quiet"],
      cwd: repoPath("fiducia-backend.rs"),
      env: {
        DATABASE_URL: postgres.url("fiducia_customer"),
        FIDUCIA_AUTH_URL: auth.url,
        FIDUCIA_SITE_MODE: "customer",
        SUPABASE_URL: supabase.url,
        SUPABASE_ANON_KEY: "stub-anon-key",
        ...(existsSync(customerDist) ? { CUSTOMER_STATIC_DIR: customerDist } : {}),
        ...(existsSync(marketingDist) ? { STATIC_DIR: marketingDist } : {}),
      },
      readyPath: "/healthz",
      reuseUrlEnv: "FIDUCIA_CUSTOMER_TEST_URL",
      startupTimeoutMs: 300000,
    });
    stack.push(backend);

    const grant = async (user) => {
      const response = await fetch(`${supabase.url}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: "stub-anon-key" },
        body: JSON.stringify({ email: user.email, password: user.password }),
      });
      if (!response.ok) {
        throw new Error(`stub password grant failed: HTTP ${response.status}`);
      }
      return (await response.json()).access_token;
    };

    return { supabase, kv, brain, postgres, auth, admin, backend, grant, stop };
  } catch (error) {
    await stop();
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
