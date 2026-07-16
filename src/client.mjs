// Minimal fetch-based fiducia.cloud client for the e2e / conformance suite.
//
// SOURCE OF TRUTH: ../../fiducia-clients/PROTOCOL.md (the endpoint/method
// contract) and fiducia-node.rs/README.md (route semantics). Every route and
// body field below is copied from PROTOCOL.md — if PROTOCOL.md changes, these
// method names and wire shapes MUST track it. This is deliberately a small,
// dependency-light mirror of clients/ts/fiducia.ts (global `fetch` only) so the
// tests exercise the real HTTP surface without pulling the whole SDK.
//
// Contract notes copied from PROTOCOL.md:
//   - Keys ride in `?key=` on reads and in JSON bodies on writes; resource names
//     that are path segments ({name}, {service}, {instanceId}) are URL-encoded.
//   - TTLs are milliseconds (`ttl_ms`).
//   - Mutating ops return `{ committed, result }`; `result.output` carries the
//     primitive payload (acquired, fencing_token, status, ...).
//   - undefined body fields are dropped by JSON.stringify (matches the TS SDK).

const enc = encodeURIComponent;

/** Thrown for any non-2xx HTTP response. `status` lets tests treat 404
 *  (primitive not deployed) as skip while still failing on wrong behavior. */
export class HttpError extends Error {
  constructor(status, body, path) {
    super(`fiducia: HTTP ${status} for ${path}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

/** Pull the primitive payload out of a `{committed,result:{output}}` envelope,
 *  tolerating flatter shapes so a field rename in the node doesn't crash tests. */
export function output(res) {
  if (res == null || typeof res !== "object") return res;
  if (res.result && typeof res.result === "object") {
    return res.result.output ?? res.result;
  }
  return res.output ?? res;
}

export class FiduciaClient {
  /**
   * @param {string} baseUrl  e.g. https://gcp.lb.fiducia.cloud
   * @param {{ apiKey?: string, fetch?: typeof fetch }} [opts]
   */
  constructor(baseUrl, opts = {}) {
    const parsed = new URL(String(baseUrl));
    const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    const allowLocalHttp = local && process.env.FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST === "1";
    if (opts.apiKey && parsed.protocol !== "https:" && !allowLocalHttp) {
      throw new Error("refusing to send FIDUCIA_E2E_API_KEY over a non-HTTPS endpoint");
    }
    this.base = parsed.origin;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  async request(method, path, body) {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    const res = await this.fetchImpl(this.base + path, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(Number(process.env.FIDUCIA_E2E_TIMEOUT_MS || 15_000)),
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) throw new HttpError(res.status, data, path);
    return data;
  }

  // --- misc ---
  health() {
    return this.request("GET", "/healthz");
  }
  status() {
    return this.request("GET", "/v1/status");
  }

  // --- locks (multi-key union) ---
  lockGet(key) {
    return this.request("GET", `/v1/locks?key=${enc(key)}`);
  }
  // wait:false = try-lock (PROTOCOL.md "Locks").
  tryLock(key, { holder, ttlMs, wait = false } = {}) {
    return this.request("POST", "/v1/locks/acquire", { key, holder, ttl_ms: ttlMs, wait });
  }
  // Multi-key union lock: all-or-nothing over the deduped key set.
  lockMany({ keys, holder, ttlMs, wait = false }) {
    return this.request("POST", "/v1/locks/acquire", { keys, holder, ttl_ms: ttlMs, wait });
  }
  lockRelease(_key, { holder, fencingToken }) {
    // Union locks release by {holder, fencing_token}; the key is not sent.
    return this.request("POST", "/v1/locks/release", { holder, fencing_token: fencingToken });
  }

  // --- semaphores (counting leases up to `limit`) ---
  semaphoreGet(key) {
    return this.request("GET", `/v1/semaphores?key=${enc(key)}`);
  }
  semaphoreAcquire(key, { holder, ttlMs, limit, wait = false } = {}) {
    return this.request("POST", "/v1/semaphores/acquire", {
      key,
      holder,
      ttl_ms: ttlMs,
      limit,
      wait,
    });
  }
  semaphoreRelease(key, { holder, fencingToken }) {
    return this.request("POST", "/v1/semaphores/release", {
      key,
      holder,
      fencing_token: fencingToken,
    });
  }

  // --- reader-writer locks ---
  // PROTOCOL.md flags rw-locks as a client extension the node runtime "does not
  // expose yet", so these routes may 404 in the live node — tests treat that as
  // skip. Routes/bodies follow the PROTOCOL.md rw table verbatim.
  rwAcquireRead(key, { ttlMs, wait = true } = {}) {
    return this.request("POST", `/v1/rw/${enc(key)}/read`, { ttl_ms: ttlMs, wait });
  }
  rwEndRead(key, lockId) {
    return this.request("POST", `/v1/rw/${enc(key)}/read/end`, { lock_id: lockId });
  }
  rwAcquireWrite(key, { ttlMs, wait = true } = {}) {
    return this.request("POST", `/v1/rw/${enc(key)}/write`, { ttl_ms: ttlMs, wait });
  }
  rwEndWrite(key, lockId) {
    return this.request("POST", `/v1/rw/${enc(key)}/write/end`, { lock_id: lockId });
  }

  // --- idempotency keys ---
  idempotencyGet(key) {
    return this.request("GET", `/v1/idempotency?key=${enc(key)}`);
  }
  idempotencyClaim(key, { owner, ttlMs, ttl, metadata } = {}) {
    return this.request("POST", "/v1/idempotency/claim", {
      key,
      owner,
      ttl_ms: ttlMs,
      ttl,
      metadata,
    });
  }
  idempotencyComplete(key, { owner, fencingToken, result } = {}) {
    return this.request("POST", "/v1/idempotency/complete", {
      key,
      owner,
      fencing_token: fencingToken,
      result,
    });
  }

  // --- rate limiting ---
  rateLimitCheck(tenant, key, { algorithm, limit, windowMs, refillPerSecond, cost } = {}) {
    return this.request("POST", `/v1/rate-limit/${enc(tenant)}/${enc(key)}/check`, {
      algorithm,
      limit,
      window_ms: windowMs,
      refill_per_second: refillPerSecond,
      cost,
    });
  }
  rateLimitGet(tenant, key) {
    return this.request("GET", `/v1/rate-limit/${enc(tenant)}/${enc(key)}`);
  }

  // --- config KV + watch ---
  kvGet(key) {
    return this.request("GET", `/v1/kv?key=${enc(key)}`);
  }
  kvPut(key, value, { ttlMs, prevRevision } = {}) {
    return this.request("PUT", `/v1/kv?key=${enc(key)}`, {
      value,
      ttl_ms: ttlMs,
      prev_revision: prevRevision,
    });
  }
  kvDelete(key) {
    return this.request("DELETE", `/v1/kv?key=${enc(key)}`);
  }
  kvList(prefix) {
    return this.request("GET", `/v1/kv?prefix=${enc(prefix)}`);
  }
  // SSE stream — async generator of parsed { event, id, data } blocks.
  kvWatch(key, { signal } = {}) {
    return this.watch(`/v1/kv?key=${enc(key)}&watch=true`, signal);
  }

  // --- leader election ---
  electionCampaign(name, candidate, ttlMs, metadata) {
    return this.request("POST", `/v1/elections/${enc(name)}/campaign`, {
      candidate,
      ttl_ms: ttlMs,
      metadata: metadata ?? {},
    });
  }
  electionRenew(name, candidate, fencingToken) {
    return this.request("POST", `/v1/elections/${enc(name)}/renew`, {
      candidate,
      fencing_token: fencingToken,
    });
  }
  electionResign(name, candidate, fencingToken) {
    return this.request("POST", `/v1/elections/${enc(name)}/resign`, {
      candidate,
      fencing_token: fencingToken,
    });
  }
  electionGet(name) {
    return this.request("GET", `/v1/elections/${enc(name)}`);
  }

  // --- counters (replicated i64 with CAS via mod_revision) ---
  counterGet(key) {
    return this.request("GET", `/v1/counters?key=${enc(key)}`);
  }
  counterAdd(key, { delta, prevRevision } = {}) {
    return this.request("POST", "/v1/counters/add", {
      key,
      delta,
      prev_revision: prevRevision,
    });
  }
  counterSet(key, { value, prevRevision } = {}) {
    return this.request("POST", "/v1/counters/set", {
      key,
      value,
      prev_revision: prevRevision,
    });
  }

  // --- barriers (fan-in with resolution policies) ---
  barrierGet(name) {
    return this.request("GET", `/v1/barriers?name=${enc(name)}`);
  }
  barrierCreate({ name, policy, expected, deadlineMs }) {
    return this.request("POST", "/v1/barriers/create", {
      name,
      policy,
      expected,
      deadline_ms: deadlineMs,
    });
  }
  barrierArrive({ name, participant, weight, veto }) {
    return this.request("POST", "/v1/barriers/arrive", { name, participant, weight, veto });
  }

  // --- tasks (claimable work; exclusive owner holds a fencing token) ---
  taskGet(name) {
    return this.request("GET", `/v1/tasks?name=${enc(name)}`);
  }
  taskCreate({ name, taskType, payload, deadlineMs }) {
    return this.request("POST", "/v1/tasks/create", {
      name,
      task_type: taskType,
      payload,
      deadline_ms: deadlineMs,
    });
  }
  taskClaim({ name, worker, ttlMs }) {
    return this.request("POST", "/v1/tasks/claim", { name, worker, ttl_ms: ttlMs });
  }
  taskComplete({ name, worker, fencingToken, result }) {
    return this.request("POST", "/v1/tasks/complete", {
      name,
      worker,
      fencing_token: fencingToken,
      result,
    });
  }
  taskFail({ name, worker, fencingToken, retryable }) {
    return this.request("POST", "/v1/tasks/fail", {
      name,
      worker,
      fencing_token: fencingToken,
      retryable,
    });
  }

  // --- effects (approval-escrow: prepare -> approve -> commit, exactly once) ---
  effectGet(name) {
    return this.request("GET", `/v1/effects?name=${enc(name)}`);
  }
  effectPrepare({ name, effectType, payload, risk, idempotencyKey, requiredApprovals }) {
    return this.request("POST", "/v1/effects/prepare", {
      name,
      effect_type: effectType,
      payload,
      risk,
      idempotency_key: idempotencyKey,
      required_approvals: requiredApprovals,
    });
  }
  effectApprove({ name, principal }) {
    return this.request("POST", "/v1/effects/approve", { name, principal });
  }
  effectCommit({ name, result }) {
    return this.request("POST", "/v1/effects/commit", { name, result });
  }
  effectAbort({ name }) {
    return this.request("POST", "/v1/effects/abort", { name });
  }

  // --- handoffs (atomic ownership transfer with fencing tokens) ---
  handoffGet(name) {
    return this.request("GET", `/v1/handoffs?name=${enc(name)}`);
  }
  handoffOffer({ name, resource, from, to, fromToken, context, ttlMs }) {
    return this.request("POST", "/v1/handoffs/offer", {
      name,
      resource,
      from,
      to,
      from_token: fromToken,
      context,
      ttl_ms: ttlMs,
    });
  }
  handoffAccept({ name, to }) {
    return this.request("POST", "/v1/handoffs/accept", { name, to });
  }
  handoffReject({ name, to }) {
    return this.request("POST", "/v1/handoffs/reject", { name, to });
  }

  // --- budgets (hierarchical reserve/commit/release spend control) ---
  budgetGet(name) {
    return this.request("GET", `/v1/budgets?name=${enc(name)}`);
  }
  budgetSet({ name, limit }) {
    return this.request("POST", "/v1/budgets/set", { name, limit });
  }
  budgetReserve({ name, reservationId, holder, amount }) {
    return this.request("POST", "/v1/budgets/reserve", {
      name,
      reservation_id: reservationId,
      holder,
      amount,
    });
  }
  budgetCommit({ name, reservationId, actual }) {
    return this.request("POST", "/v1/budgets/commit", {
      name,
      reservation_id: reservationId,
      actual,
    });
  }
  budgetRelease({ name, reservationId }) {
    return this.request("POST", "/v1/budgets/release", {
      name,
      reservation_id: reservationId,
    });
  }

  // --- cron / scheduling ---
  scheduleUpsert(name, { cron, oneShotAtMs, target, delivery, maxRetries } = {}) {
    return this.request("PUT", `/v1/cron/schedules/${enc(name)}`, {
      cron,
      one_shot_at_ms: oneShotAtMs,
      target,
      delivery,
      max_retries: maxRetries,
    });
  }
  scheduleGet(name) {
    return this.request("GET", `/v1/cron/schedules/${enc(name)}`);
  }
  scheduleRecordRun(name, fireId, firedAtMs) {
    return this.request("POST", `/v1/cron/schedules/${enc(name)}/runs`, {
      fire_id: fireId,
      fired_at_ms: firedAtMs,
    });
  }
  scheduleHistory(name) {
    return this.request("GET", `/v1/cron/schedules/${enc(name)}/history`);
  }

  // --- service discovery ---
  serviceRegister(service, instanceId, address, ttlMs, metadata = {}) {
    return this.request("PUT", `/v1/services/${enc(service)}/instances/${enc(instanceId)}`, {
      address,
      ttl_ms: ttlMs,
      metadata,
    });
  }
  serviceHeartbeat(service, instanceId, ttlMs) {
    return this.request("POST", `/v1/services/${enc(service)}/instances/${enc(instanceId)}/heartbeat`, {
      ttl_ms: ttlMs,
    });
  }
  serviceDeregister(service, instanceId) {
    return this.request("DELETE", `/v1/services/${enc(service)}/instances/${enc(instanceId)}`);
  }
  serviceResolve(service, metadata = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(metadata)) {
      if (String(k).trim() && v !== undefined) params.set(`metadata.${k}`, String(v));
    }
    const query = params.toString();
    return this.request("GET", `/v1/services/${enc(service)}${query ? `?${query}` : ""}`);
  }
  serviceList() {
    return this.request("GET", "/v1/services");
  }

  // --- SSE reader (shared by kvWatch) ---
  async *watch(path, signal) {
    const headers = { accept: "text/event-stream" };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    const res = await this.fetchImpl(this.base + path, { method: "GET", headers, signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      throw new HttpError(res.status, body, path);
    }
    if (!res.body?.getReader) throw new Error("fiducia: response body is not streamable");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = /\r?\n\r?\n/.exec(buffer);
        while (boundary) {
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const evt = parseSseBlock(block);
          if (evt) yield evt;
          boundary = /\r?\n\r?\n/.exec(buffer);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function parseSseBlock(block) {
  let event = "message";
  let id;
  const data = [];
  for (const rawLine of block.replace(/\r\n/g, "\n").split("\n")) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    const field = colon >= 0 ? rawLine.slice(0, colon) : rawLine;
    let value = colon >= 0 ? rawLine.slice(colon + 1) : "";
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    if (field === "id") id = value;
    if (field === "data") data.push(value);
  }
  if (!data.length) return undefined;
  const raw = data.join("\n");
  let decoded = raw;
  try {
    decoded = JSON.parse(raw);
  } catch {
    /* leave as string */
  }
  return { event, id, data: decoded };
}
