// DEN-1391 AUTH-003 / AUTH-006: real-process proof of the human-session
// authority and the internal API-key introspection boundary.
//
// This suite boots the production fiducia-auth binary against a bounded local
// Supabase system-of-record/JWKS stub. It never needs a real customer, Supabase
// project, API key, or secret. It is opt-in because CI must first build the Rust
// binary:
//
//   FIDUCIA_E2E_AUTH_SYSTEM=1 FIDUCIA_AUTH_BIN=/path/to/fiducia-auth \
//     node --test tests/system/auth-authority.test.mjs

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";
import { existsSync } from "node:fs";
import { request as httpRequest, createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const AUTH_BIN = process.env.FIDUCIA_AUTH_BIN;
const SKIP =
  process.env.FIDUCIA_E2E_AUTH_SYSTEM !== "1"
    ? "set FIDUCIA_E2E_AUTH_SYSTEM=1 to run the fiducia-auth authority suite"
    : !AUTH_BIN || !existsSync(AUTH_BIN)
      ? "set FIDUCIA_AUTH_BIN to a built fiducia-auth binary"
      : false;

const INTROSPECT_SECRET =
  "e2e-introspection-secret-00000000000000000000000000000000";
const INTERNAL_SECRET =
  "e2e-auth-kv-internal-secret-000000000000000000000000000000";
const IDEMPOTENCY_SECRET =
  "e2e-idempotency-root-00000000000000000000000000000000000";
const API_KEY_PEPPER =
  "e2e-api-key-pepper-000000000000000000000000000000000000";
const SUPABASE_KID = "e2e-supabase-es256";

function base64url(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return bytes.toString("base64url");
}

function signSupabaseJwt(privateKey, issuer, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "ES256",
    typ: "JWT",
    kid: SUPABASE_KID,
  };
  const claims = {
    iss: issuer,
    aud: "authenticated",
    sub: "user_e2e",
    email: "e2e@example.invalid",
    role: "authenticated",
    aal: "aal2",
    iat: now - 5,
    exp: now + 300,
    app_metadata: {
      orgs: ["org_trusted"],
      fiducia_roles: ["operator"],
    },
    user_metadata: {
      orgs: ["org_attacker_controlled"],
      fiducia_roles: ["admin"],
    },
    ...overrides,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(claims),
  )}`;
  // JWT ES256 uses the fixed-width IEEE-P1363 r||s form, not ASN.1 DER.
  const signature = cryptoSign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64url(signature)}`;
}

async function pickPort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
    ...options,
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { response, body, text };
}

function rawJsonRequest(url, { method = "POST", headers = [], body = null } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest(
      target,
      {
        method,
        timeout: 5_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            // A rejection body is intentionally not required for the boundary.
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, text });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    for (const [name, value] of headers) req.appendHeader(name, value);
    if (body !== null) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitForHealthy(baseUrl, child, logs, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`fiducia-auth exited ${child.exitCode}:\n${logs.value}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // startup in progress
    }
    await delay(150);
  }
  throw new Error(`fiducia-auth did not become healthy:\n${logs.value}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(3_000).then(() => false),
  ]);
  if (!stopped) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

describe("DEN-1391 fiducia-auth authority boundaries", { skip: SKIP, concurrency: 1 }, () => {
  let supabaseServer;
  let authChild;
  let authBaseUrl;
  let issuer;
  let supabasePrivateKey;
  const logs = { value: "" };

  before(async () => {
    const supabaseKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    supabasePrivateKey = supabaseKeys.privateKey;
    const publicJwk = supabaseKeys.publicKey.export({ format: "jwk" });
    const jwks = {
      keys: [
        {
          ...publicJwk,
          alg: "ES256",
          use: "sig",
          kid: SUPABASE_KID,
        },
      ],
    };

    supabaseServer = createHttpServer((req, res) => {
      const url = new URL(req.url, "http://supabase.test");
      if (url.pathname === "/auth/v1/.well-known/jwks.json") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(jwks));
        return;
      }
      if (url.pathname === "/rest/v1/organizations") {
        // The startup contract requires one successful authoritative pull.
        assert.equal(req.headers.apikey, "e2e-service-role");
        assert.equal(req.headers.authorization, "Bearer e2e-service-role");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ id: "org_trusted", plan: "beta" }]));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
    const supabaseBaseUrl = await listen(supabaseServer);
    issuer = `${supabaseBaseUrl}/auth/v1`;

    const authSigningKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const authPort = await pickPort();
    authBaseUrl = `http://127.0.0.1:${authPort}`;
    authChild = spawn(AUTH_BIN, [], {
      env: {
        ...process.env,
        PORT: String(authPort),
        RUST_LOG: "fiducia_auth=debug,fiducia_auth::supabase=debug",
        FIDUCIA_DEPLOYMENT_MODE: "test",
        FIDUCIA_JWT_SIGNING_KEY: authSigningKeys.privateKey.export({
          format: "pem",
          type: "pkcs8",
        }),
        FIDUCIA_KV_URL: "http://127.0.0.1:9",
        FIDUCIA_KV_ORG_ID: "fiducia-auth-e2e",
        FIDUCIA_INTERNAL_SECRET: INTERNAL_SECRET,
        FIDUCIA_KEY_IDEMPOTENCY_SECRET: IDEMPOTENCY_SECRET,
        CUSTOMER_API_KEY_PEPPER: API_KEY_PEPPER,
        CUSTOMER_API_KEY_HASH_ALGORITHM: "hmac-sha256",
        CUSTOMER_API_KEY_ACCEPT_LEGACY_SHA256: "false",
        FIDUCIA_INTROSPECT_SECRET: INTROSPECT_SECRET,
        FIDUCIA_ROTATION_OVERLAP_SECONDS: "60",
        FIDUCIA_CUSTOMER_ORIGIN: "https://app.fiducia.test",
        SUPABASE_URL: supabaseBaseUrl,
        SUPABASE_SERVICE_ROLE_KEY: "e2e-service-role",
        SUPABASE_SYNC_INTERVAL_SECS: "3600",
        SUPABASE_AUTH_AUDIENCE: "authenticated",
        SUPABASE_AUTH_ALLOW_REMOTE_USERINFO: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (chunk) => {
      logs.value = (logs.value + String(chunk)).slice(-64 * 1024);
    };
    authChild.stdout.on("data", append);
    authChild.stderr.on("data", append);
    await waitForHealthy(authBaseUrl, authChild, logs);
  }, { timeout: 120_000 });

  after(async () => {
    await stopChild(authChild);
    await new Promise((resolve) => supabaseServer?.close(resolve));
  });

  it("AUTH-003: accepts only the configured issuer/audience and app_metadata authority", async () => {
    const valid = signSupabaseJwt(supabasePrivateKey, issuer);
    const accepted = await requestJson(`${authBaseUrl}/v1/me`, {
      headers: { authorization: `Bearer ${valid}` },
    });
    assert.equal(accepted.response.status, 200, accepted.text);
    assert.deepEqual(accepted.body.user.orgs, ["org_trusted"]);
    assert.deepEqual(accepted.body.user.roles, ["operator"]);
    assert.equal(accepted.body.user.aal, "aal2");
    assert.ok(!JSON.stringify(accepted.body).includes("org_attacker_controlled"));
    assert.ok(!JSON.stringify(accepted.body).includes('"admin"'));

    const wrongIssuer = signSupabaseJwt(
      supabasePrivateKey,
      `${issuer}/attacker-project`,
    );
    assert.equal(
      (await requestJson(`${authBaseUrl}/v1/me`, {
        headers: { authorization: `Bearer ${wrongIssuer}` },
      })).response.status,
      401,
    );

    const wrongAudience = signSupabaseJwt(supabasePrivateKey, issuer, {
      aud: "service_role",
    });
    assert.equal(
      (await requestJson(`${authBaseUrl}/v1/me`, {
        headers: { authorization: `Bearer ${wrongAudience}` },
      })).response.status,
      401,
    );

    const wrongRole = signSupabaseJwt(supabasePrivateKey, issuer, {
      role: "service_role",
    });
    assert.equal(
      (await requestJson(`${authBaseUrl}/v1/me`, {
        headers: { authorization: `Bearer ${wrongRole}` },
      })).response.status,
      401,
    );

    const userMetadataOnly = signSupabaseJwt(supabasePrivateKey, issuer, {
      app_metadata: {},
      user_metadata: {
        orgs: ["org_victim"],
        fiducia_roles: ["admin"],
      },
    });
    const unprivileged = await requestJson(`${authBaseUrl}/v1/me`, {
      headers: { authorization: `Bearer ${userMetadataOnly}` },
    });
    assert.equal(unprivileged.response.status, 200, unprivileged.text);
    assert.deepEqual(unprivileged.body.user.orgs, []);
    assert.deepEqual(unprivileged.body.user.roles, []);
  });

  it("AUTH-003: duplicate or comma-coalesced Authorization is rejected fail-closed", async () => {
    const valid = signSupabaseJwt(supabasePrivateKey, issuer);
    for (const values of [
      [`Bearer ${valid}`, "Bearer attacker.invalid.token"],
      ["Bearer attacker.invalid.token", `Bearer ${valid}`],
      [`Bearer ${valid}`, `Bearer ${valid}`],
      [`Bearer ${valid}, Bearer attacker.invalid.token`],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const result = await rawJsonRequest(`${authBaseUrl}/v1/me`, {
        method: "GET",
        headers: values.map((value) => ["authorization", value]),
      });
      assert.equal(
        result.status,
        401,
        `ambiguous Authorization was accepted: ${values.length} value(s)`,
      );
    }
  });

  it("AUTH-006: introspection requires one exact server credential", async () => {
    const endpoint = `${authBaseUrl}/v1/introspect`;
    const body = { api_key: "not-a-fiducia-key" };

    for (const headers of [
      [["content-type", "application/json"]],
      [
        ["content-type", "application/json"],
        ["x-server-auth", "wrong-secret"],
      ],
      [
        ["content-type", "application/json"],
        ["x-server-auth", INTROSPECT_SECRET],
        ["x-server-auth", "attacker-appended-value"],
      ],
      [
        ["content-type", "application/json"],
        ["x-server-auth", "attacker-prepended-value"],
        ["x-server-auth", INTROSPECT_SECRET],
      ],
      [
        ["content-type", "application/json"],
        ["x-server-auth", `${INTROSPECT_SECRET}, attacker-appended-value`],
      ],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const rejected = await rawJsonRequest(endpoint, { headers, body });
      assert.equal(rejected.status, 401, "ambiguous/missing introspection authority accepted");
      assert.equal(rejected.headers.location, undefined);
    }

    const exact = await rawJsonRequest(endpoint, {
      headers: [
        ["content-type", "application/json"],
        ["x-server-auth", INTROSPECT_SECRET],
      ],
      body,
    });
    assert.equal(exact.status, 200, exact.text);
    assert.equal(exact.body.valid, false);
  });

  it("AUTH-006: the public token exchange is possession-based, not server-secret-based", async () => {
    const endpoint = `${authBaseUrl}/v1/token`;
    const invalidBody = JSON.stringify({ api_key: "not-a-fiducia-key" });

    const withoutInternalSecret = await requestJson(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: invalidBody,
    });
    assert.equal(withoutInternalSecret.response.status, 401);

    const withInternalSecretOnly = await requestJson(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-server-auth": INTROSPECT_SECRET,
      },
      body: invalidBody,
    });
    assert.equal(withInternalSecretOnly.response.status, 401);
    assert.equal(withInternalSecretOnly.response.headers.get("cache-control"), null);
  });
});
