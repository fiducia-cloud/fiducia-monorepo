// Black-box clients for the hardened cron control planes.
//
// fiducia-node owns replicated schedules and bounded run history. The lambda
// service owns customer source and executes only an active tenant-owned function.
// Keeping these clients separate makes the architectural boundary testable:
// source must never appear in a node schedule or run record.

import { validateEndpoint } from "./origin.mjs";

const enc = encodeURIComponent;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;
const PUBLIC_ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const FORBIDDEN_REPLICATED_KEYS = new Set([
  "authorization",
  "cookie",
  "container_image",
  "containerImage",
  "entry_command",
  "entryCommand",
  "environment",
  "env",
  "function_body",
  "functionBody",
  "password",
  "payload",
  "request",
  "secret",
  "secrets",
  "source",
]);

export class CronServiceError extends Error {
  constructor(status, path, code = "cron_service_error") {
    super(`fiducia cron service: HTTP ${status} for ${path} (${code})`);
    this.name = "CronServiceError";
    this.status = status;
    this.path = path;
    this.code = code;
  }
}

function positiveInt(value, fallback, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`expected an integer in the range 1..${max}`);
  }
  return parsed;
}

function optionalString(value) {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function publicErrorCode(value) {
  const code = value && typeof value === "object" ? value.error ?? value.code : undefined;
  if (typeof code !== "string") return "cron_service_error";
  const normalized = code.trim();
  return PUBLIC_ERROR_CODE.test(normalized) ? normalized : "cron_service_error";
}

async function readBoundedJson(response, path, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new CronServiceError(502, path, "response_too_large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new CronServiceError(502, path, "response_too_large");
  }
  if (bytes.byteLength === 0) return null;
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function forbiddenReplicatedFields(value, prefix = "$") {
  const found = [];
  const visit = (current, path) => {
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, entry] of Object.entries(current)) {
      const child = `${path}.${key}`;
      if (FORBIDDEN_REPLICATED_KEYS.has(key)) found.push(child);
      visit(entry, child);
    }
  };
  visit(value, prefix);
  return found;
}

export function assertOpaqueSchedule(value) {
  const forbidden = forbiddenReplicatedFields(value);
  if (forbidden.length) {
    throw new Error(`replicated cron state contains sensitive fields: ${forbidden.join(", ")}`);
  }
  return value;
}

export class CronNodeService {
  /** @param {{request(method:string,path:string,body?:unknown):Promise<unknown>}} client */
  constructor(client) {
    if (!client || typeof client.request !== "function") {
      throw new Error("CronNodeService requires a FiduciaClient-compatible request method");
    }
    this.client = client;
  }

  list({ cursor, limit } = {}) {
    const query = new URLSearchParams();
    const cleanCursor = optionalString(cursor);
    if (cleanCursor) query.set("cursor", cleanCursor);
    if (limit !== undefined) query.set("limit", String(positiveInt(limit, 50, 200)));
    const suffix = query.size ? `?${query}` : "";
    return this.client.request("GET", `/v1/cron/schedules${suffix}`);
  }

  upsert(name, { cron, oneShotAtMs, target, delivery, maxRetries } = {}) {
    assertOpaqueSchedule(target);
    return this.client.request("PUT", `/v1/cron/schedules/${enc(name)}`, {
      cron,
      one_shot_at_ms: oneShotAtMs,
      target,
      delivery,
      max_retries: maxRetries,
    });
  }

  get(name) {
    return this.client.request("GET", `/v1/cron/schedules/${enc(name)}`);
  }

  delete(name) {
    return this.client.request("DELETE", `/v1/cron/schedules/${enc(name)}`);
  }

  pause(name) {
    return this.client.request("POST", `/v1/cron/schedules/${enc(name)}/pause`);
  }

  resume(name, { catchUp = false } = {}) {
    return this.client.request(
      "POST",
      `/v1/cron/schedules/${enc(name)}/resume?catch_up=${catchUp ? "true" : "false"}`,
    );
  }

  trigger(name, { fireIdMs } = {}) {
    const query = new URLSearchParams();
    if (fireIdMs !== undefined) {
      const fire = Number(fireIdMs);
      if (!Number.isSafeInteger(fire) || fire < 0) {
        throw new Error("fireIdMs must be a non-negative safe integer");
      }
      query.set("fire_id_ms", String(fire));
    }
    const suffix = query.size ? `?${query}` : "";
    return this.client.request("POST", `/v1/cron/schedules/${enc(name)}/trigger${suffix}`);
  }

  history(name, { limit } = {}) {
    const query = new URLSearchParams();
    if (limit !== undefined) query.set("limit", String(positiveInt(limit, 50, 100)));
    const suffix = query.size ? `?${query}` : "";
    return this.client.request("GET", `/v1/cron/schedules/${enc(name)}/history${suffix}`);
  }
}

export class CronFunctionService {
  /**
   * @param {string} baseUrl
   * @param {{serverAuth:string, orgId:string, fetch?:typeof fetch, timeoutMs?:number,
   *   maxResponseBytes?:number, allowInsecureLocalhost?:boolean}} options
   */
  constructor(baseUrl, options = {}) {
    const allowInsecureLocalhost = options.allowInsecureLocalhost
      ?? process.env.FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST === "1";
    this.base = validateEndpoint(String(baseUrl), allowInsecureLocalhost);
    this.serverAuth = optionalString(options.serverAuth);
    this.orgId = optionalString(options.orgId);
    if (!this.serverAuth) throw new Error("serverAuth is required");
    if (!this.orgId) throw new Error("orgId is required");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") throw new Error("fetch is required");
    this.timeoutMs = positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 120_000);
    this.maxResponseBytes = positiveInt(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      16 * 1024 * 1024,
    );
  }

  async request(method, path, { body, traceparent, tracestate, idempotencyKey } = {}) {
    if (!path.startsWith("/")) throw new Error("cron function path must be absolute");
    const url = new URL(path, `${this.base}/`);
    if (url.origin !== this.base) throw new Error("refusing to leave the lambda-service origin");

    const headers = new Headers({
      accept: "application/json",
      "x-fiducia-org-id": this.orgId,
      "x-server-auth": this.serverAuth,
    });
    if (body !== undefined) headers.set("content-type", "application/json");
    if (traceparent !== undefined) {
      const value = String(traceparent).trim().toLowerCase();
      if (!TRACEPARENT.test(value)) throw new Error("traceparent is invalid");
      headers.set("traceparent", value);
    }
    const cleanTracestate = optionalString(tracestate);
    if (cleanTracestate) headers.set("tracestate", cleanTracestate.slice(0, 512));
    const cleanIdempotency = optionalString(idempotencyKey);
    if (cleanIdempotency) headers.set("idempotency-key", cleanIdempotency.slice(0, 256));

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new CronServiceError(502, path, "redirect_rejected");
    }
    const data = await readBoundedJson(response, path, this.maxResponseBytes);
    if (!response.ok) {
      throw new CronServiceError(response.status, path, publicErrorCode(data));
    }
    return data;
  }

  list({ limit } = {}) {
    const query = new URLSearchParams();
    if (limit !== undefined) query.set("limit", String(positiveInt(limit, 10, 10)));
    const suffix = query.size ? `?${query}` : "";
    return this.request("GET", `/v1/functions${suffix}`);
  }

  create(definition, context) {
    return this.request("POST", "/v1/functions", { ...context, body: definition });
  }

  get(functionId, context) {
    return this.request("GET", `/v1/functions/${enc(functionId)}`, context);
  }

  update(functionId, definition, context) {
    return this.request("PUT", `/v1/functions/${enc(functionId)}`, {
      ...context,
      body: definition,
    });
  }

  delete(functionId, context) {
    return this.request("DELETE", `/v1/functions/${enc(functionId)}`, context);
  }

  check(functionId, context) {
    return this.request("POST", `/v1/functions/${enc(functionId)}/check`, context);
  }

  pause(functionId, context) {
    return this.request("POST", `/v1/functions/${enc(functionId)}/pause`, context);
  }

  invoke(functionId, request, context = {}) {
    return this.request("POST", `/invoke/${enc(functionId)}`, {
      ...context,
      body: request,
    });
  }
}

export function cronFunctionServiceFromEnv({ env = process.env, orgId, fetchImpl } = {}) {
  const baseUrl = optionalString(env.FIDUCIA_E2E_LAMBDA_SERVICE_URL);
  const serverAuth = optionalString(env.FIDUCIA_E2E_LAMBDA_SERVER_AUTH_SECRET);
  const tenant = optionalString(orgId ?? env.FIDUCIA_E2E_ORG_ID);
  if (!baseUrl || !serverAuth || !tenant) return null;
  return new CronFunctionService(baseUrl, {
    serverAuth,
    orgId: tenant,
    fetch: fetchImpl,
    allowInsecureLocalhost: env.FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST === "1",
    timeoutMs: Number(env.FIDUCIA_E2E_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  });
}
