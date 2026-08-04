#!/usr/bin/env node

// DEN-1404 / DEN-1619: bounded exact-candidate evidence export for the managed
// public-beta availability SLO. The exporter sends a fixed reviewed PromQL set
// in POST bodies, validates every returned label against a low-cardinality
// allowlist, proves the declared probe-location matrix is actually observed,
// records exact release identities, and writes atomic content-addressed JSON.
//
// It deliberately does not certify a release. A complete candidate measurement
// means only that all declared sources were observed for the completed window
// and the required independence attestation was supplied. Independent go/no-go
// review remains outside this process.

import { createHash } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(THIS_FILE);
const SCHEMA_VERSION = 2;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_SERIES_PER_QUERY = 2048;
const MAX_LIST_ITEMS = 64;
const MAX_TIMEOUT_MS = 30_000;
const MIN_WINDOW_SECONDS = 28 * 24 * 60 * 60;
const MAX_WINDOW_SECONDS = 35 * 24 * 60 * 60;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const BOUNDED_LABEL = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const BOUNDED_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const IMAGE_NAME = /^[a-z0-9][a-z0-9._/-]{0,127}$/;

export const APPROVED_OPERATION_CLASSES = new Set([
  "health",
  "linearizable_read",
  "committed_write",
  "renewal",
  "secret_read",
  "watch_reconcile",
]);

export const QUERIES = Object.freeze([
  {
    id: "availability_ratio_28d",
    slo: "SLO-AVAIL-01",
    expression: "fiducia:sli:public_availability_ratio:28d",
    dimensions: ["cell"],
    expected: "cell",
  },
  {
    id: "availability_samples_28d",
    slo: "SLO-AVAIL-01",
    expression: "fiducia:sli:public_availability_samples:28d",
    dimensions: ["cell"],
    expected: "cell",
  },
  {
    id: "error_budget_remaining_ratio_28d",
    slo: "SLO-AVAIL-01",
    expression: "fiducia:sli:public_availability_error_budget_remaining_ratio:28d",
    dimensions: ["cell"],
    expected: "cell",
  },
  {
    id: "availability_burn_rate_1h",
    slo: "SLO-AVAIL-01",
    expression: "fiducia:sli:public_availability_burn_rate:1h",
    dimensions: ["cell"],
    expected: "cell",
  },
  {
    id: "availability_burn_rate_6h",
    slo: "SLO-AVAIL-01",
    expression: "fiducia:sli:public_availability_burn_rate:6h",
    dimensions: ["cell"],
    expected: "cell",
  },
  {
    id: "external_probe_freshness_seconds",
    slo: "SLO-AVAIL-01",
    expression: "fiducia:sli:external_probe_freshness_seconds",
    dimensions: ["cell", "operation_class", "probe_location"],
    expected: "cell_operation_location",
  },
  {
    id: "external_probe_last_success_age_seconds",
    slo: "SLO-AVAIL-01",
    expression: "fiducia:sli:external_probe_last_success_age_seconds",
    dimensions: ["cell", "operation_class", "probe_location"],
    expected: "cell_operation_location",
  },
  {
    id: "external_probe_cumulative_totals",
    slo: "SLO-AVAIL-01",
    expression: "fiducia_external_probe_total",
    dimensions: ["cell", "operation_class", "probe_location", "result"],
    expected: "cell_operation_location_result",
  },
]);

function required(name, value) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function boundedId(name, value) {
  const normalized = required(name, value);
  if (!BOUNDED_ID.test(normalized) || /[\r\n\0]/u.test(normalized)) {
    throw new Error(`${name} must be a bounded content-free identifier`);
  }
  return normalized;
}

function boundedLabel(name, value, allowed = null) {
  const normalized = required(name, value).toLowerCase();
  if (!BOUNDED_LABEL.test(normalized) || (allowed && !allowed.has(normalized))) {
    throw new Error(`${name} is outside the approved bounded label set`);
  }
  return normalized;
}

export function parseBoundedList(name, value, { allowed = null, minimum = 1 } = {}) {
  const values = required(name, value)
    .split(",")
    .map((item) => boundedLabel(name, item, allowed));
  const unique = [...new Set(values)].sort();
  if (unique.length !== values.length) throw new Error(`${name} contains duplicates`);
  if (unique.length < minimum || unique.length > MAX_LIST_ITEMS) {
    throw new Error(`${name} must contain ${minimum}..${MAX_LIST_ITEMS} unique items`);
  }
  return unique;
}

export function parseImageDigests(value) {
  const entries = required("image digests", value).split(",");
  if (entries.length > MAX_LIST_ITEMS) throw new Error("too many image digests");
  const seen = new Set();
  const parsed = entries.map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error("image digests must use name=sha256:<hex>");
    const name = entry.slice(0, separator).trim().toLowerCase();
    const digest = entry.slice(separator + 1).trim().toLowerCase();
    if (!IMAGE_NAME.test(name) || !SHA256_DIGEST.test(digest)) {
      throw new Error("image digest entry is malformed");
    }
    if (seen.has(name)) throw new Error(`duplicate image name ${name}`);
    seen.add(name);
    return { name, digest };
  });
  return parsed.sort((left, right) => left.name.localeCompare(right.name));
}

export function parseWindow(startValue, endValue) {
  const start = new Date(required("window start", startValue));
  const end = new Date(required("window end", endValue));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new Error("measurement window must use valid RFC3339 timestamps");
  }
  const durationSeconds = (end.getTime() - start.getTime()) / 1000;
  if (durationSeconds < MIN_WINDOW_SECONDS || durationSeconds > MAX_WINDOW_SECONDS) {
    throw new Error("measurement window must be between 28 and 35 days");
  }
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    endEpochSeconds: end.getTime() / 1000,
    durationSeconds,
  };
}

function parseBoolean(name, value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  switch (String(value).trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new Error(`${name} must be a boolean`);
  }
}

function requireCommit(name, value) {
  const commit = required(name, value).toLowerCase();
  if (!COMMIT.test(commit)) throw new Error(`${name} must be a full 40-character commit`);
  return commit;
}

function parseDashboardVersion(value) {
  const version = Number.parseInt(required("dashboard version", value), 10);
  if (!Number.isSafeInteger(version) || version < 1 || version > 1_000_000) {
    throw new Error("dashboard version must be a positive bounded integer");
  }
  return version;
}

export function validatePrometheusUrl(value, allowInsecureLocalhost = false) {
  const url = new URL(required("Prometheus URL", value));
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Prometheus URL must not contain credentials, query, or fragment");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowInsecureLocalhost && local && url.protocol === "http:")) {
    throw new Error("Prometheus URL must use HTTPS outside an explicitly allowed localhost test");
  }
  return url;
}

function queryUrl(base) {
  const url = new URL(base.toString());
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/api/v1/query`;
  url.search = "";
  url.hash = "";
  return url;
}

async function readBearer(path) {
  if (!path) return null;
  const bearer = (await readFile(path, "utf8")).trim();
  if (!bearer || bearer.length > 8192 || /[\r\n\0]/u.test(bearer)) {
    throw new Error("Prometheus bearer file must contain one bounded non-empty line");
  }
  return bearer;
}

async function boundedResponseText(response) {
  const length = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new Error("prometheus_response_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel("bounded response limit exceeded");
        throw new Error("prometheus_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function expectedKeys(kind, cells, operations, locations) {
  switch (kind) {
    case "cell":
      return cells.map((cell) => `cell=${cell}`);
    case "cell_operation_location":
      return cells.flatMap((cell) =>
        operations.flatMap((operation) =>
          locations.map(
            (location) =>
              `cell=${cell}|operation_class=${operation}|probe_location=${location}`,
          ),
        ),
      );
    case "cell_operation_location_result":
      return cells.flatMap((cell) =>
        operations.flatMap((operation) =>
          locations.flatMap((location) =>
            ["failure", "success"].map(
              (result) =>
                `cell=${cell}|operation_class=${operation}|probe_location=${location}|result=${result}`,
            ),
          ),
        ),
      );
    default:
      throw new Error(`unsupported completeness kind ${kind}`);
  }
}

function sampleKey(dimensions, labels) {
  return dimensions.map((dimension) => `${dimension}=${labels[dimension]}`).join("|");
}

export function sanitizePrometheusVector(
  query,
  payload,
  cells,
  operations,
  locations,
) {
  if (payload?.status !== "success" || payload?.data?.resultType !== "vector") {
    throw new Error("prometheus_invalid_vector_response");
  }
  const result = payload.data.result;
  if (!Array.isArray(result) || result.length > MAX_SERIES_PER_QUERY) {
    throw new Error("prometheus_invalid_series_count");
  }

  const allowedLabels = new Set(["__name__", ...query.dimensions]);
  const samples = [];
  const observed = new Set();
  for (const row of result) {
    if (
      !row ||
      typeof row.metric !== "object" ||
      !Array.isArray(row.value) ||
      row.value.length !== 2
    ) {
      throw new Error("prometheus_invalid_sample");
    }
    for (const label of Object.keys(row.metric)) {
      if (!allowedLabels.has(label)) throw new Error("prometheus_unexpected_label");
    }
    const labels = {};
    for (const dimension of query.dimensions) {
      const raw = row.metric[dimension];
      if (dimension === "result") {
        labels[dimension] = boundedLabel(
          dimension,
          raw,
          new Set(["success", "failure"]),
        );
      } else if (dimension === "operation_class") {
        labels[dimension] = boundedLabel(
          dimension,
          raw,
          APPROVED_OPERATION_CLASSES,
        );
      } else if (dimension === "cell") {
        labels[dimension] = boundedLabel(dimension, raw, new Set(cells));
      } else if (dimension === "probe_location") {
        labels[dimension] = boundedLabel(dimension, raw, new Set(locations));
      } else {
        labels[dimension] = boundedLabel(dimension, raw);
      }
    }
    const key = sampleKey(query.dimensions, labels);
    if (observed.has(key)) throw new Error("prometheus_duplicate_series");
    observed.add(key);

    const timestamp = Number(row.value[0]);
    const value = Number(row.value[1]);
    if (!Number.isFinite(timestamp) || !Number.isFinite(value)) {
      throw new Error("prometheus_non_finite_sample");
    }
    samples.push({ labels, timestamp, value });
  }
  samples.sort((left, right) =>
    sampleKey(query.dimensions, left.labels).localeCompare(
      sampleKey(query.dimensions, right.labels),
    ),
  );

  const expected = expectedKeys(
    query.expected,
    cells,
    operations,
    locations,
  ).sort();
  const actual = [...observed].sort();
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((key) => !actualSet.has(key));
  const unexpected = actual.filter((key) => !expectedSet.has(key));
  return {
    status: samples.length === 0 ? "no_data" : "success",
    complete: missing.length === 0 && unexpected.length === 0,
    missing,
    unexpected,
    samples,
  };
}

function classifyError(error) {
  const known = new Set([
    "prometheus_response_too_large",
    "prometheus_invalid_vector_response",
    "prometheus_invalid_series_count",
    "prometheus_invalid_sample",
    "prometheus_unexpected_label",
    "prometheus_duplicate_series",
    "prometheus_non_finite_sample",
  ]);
  return known.has(error?.message) ? error.message : "prometheus_query_failed";
}

async function queryPrometheus({
  baseUrl,
  bearer,
  query,
  time,
  timeoutMs,
  cells,
  operations,
  locations,
}) {
  const body = new URLSearchParams({ query: query.expression, time: String(time) });
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
    "user-agent": "fiducia-managed-beta-slo-evidence/2",
  });
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);

  try {
    const response = await fetch(queryUrl(baseUrl), {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await boundedResponseText(response).catch(() => "");
      return {
        id: query.id,
        slo: query.slo,
        expression: query.expression,
        status: "http_error",
        complete: false,
        missing: expectedKeys(
          query.expected,
          cells,
          operations,
          locations,
        ).sort(),
        unexpected: [],
        samples: [],
      };
    }
    const text = await boundedResponseText(response);
    const payload = JSON.parse(text);
    return {
      id: query.id,
      slo: query.slo,
      expression: query.expression,
      ...sanitizePrometheusVector(
        query,
        payload,
        cells,
        operations,
        locations,
      ),
    };
  } catch (error) {
    return {
      id: query.id,
      slo: query.slo,
      expression: query.expression,
      status: classifyError(error),
      complete: false,
      missing: expectedKeys(
        query.expected,
        cells,
        operations,
        locations,
      ).sort(),
      unexpected: [],
      samples: [],
    };
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function evidenceDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export async function atomicWrite(path, content) {
  const target = resolve(path);
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, target);
  return target;
}

export async function withExclusiveLock(path, fn) {
  const lockPath = resolve(path);
  let handle;
  try {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error("evidence export lock is already held");
      }
      throw error;
    }
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    return await fn();
  } finally {
    if (handle) {
      await handle.close();
      await unlink(lockPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }
}

export function parseConfig(env = process.env) {
  const allowInsecure = parseBoolean(
    "FIDUCIA_SLO_EXPORT_ALLOW_INSECURE_LOCALHOST",
    env.FIDUCIA_SLO_EXPORT_ALLOW_INSECURE_LOCALHOST,
  );
  const window = parseWindow(
    env.FIDUCIA_EVIDENCE_WINDOW_START,
    env.FIDUCIA_EVIDENCE_WINDOW_END,
  );
  const cells = parseBoundedList("cells", env.FIDUCIA_RELEASE_CELLS);
  const operations = parseBoundedList(
    "operation classes",
    env.FIDUCIA_RELEASE_OPERATION_CLASSES,
    { allowed: APPROVED_OPERATION_CLASSES },
  );
  const probeLocations = parseBoundedList(
    "probe locations",
    env.FIDUCIA_PROBE_LOCATIONS,
    { minimum: 2 },
  );
  const independenceAttested = parseBoolean(
    "FIDUCIA_PROBE_INDEPENDENCE_ATTESTED",
    env.FIDUCIA_PROBE_INDEPENDENCE_ATTESTED,
  );
  const independenceReviewer = independenceAttested
    ? boundedId(
        "probe independence reviewer",
        env.FIDUCIA_PROBE_INDEPENDENCE_REVIEWER,
      )
    : null;
  const timeoutMs = Number.parseInt(
    env.FIDUCIA_SLO_EXPORT_TIMEOUT_MS ?? "10000",
    10,
  );
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`export timeout must be within 100..${MAX_TIMEOUT_MS}`);
  }

  return {
    prometheusUrl: validatePrometheusUrl(
      env.FIDUCIA_PROMETHEUS_URL,
      allowInsecure,
    ),
    bearerFile: env.FIDUCIA_PROMETHEUS_BEARER_FILE?.trim() || null,
    output: resolve(required("evidence output", env.FIDUCIA_SLO_EVIDENCE_OUTPUT)),
    lock: resolve(
      env.FIDUCIA_SLO_EVIDENCE_LOCK?.trim() ||
        `${env.FIDUCIA_SLO_EVIDENCE_OUTPUT}.lock`,
    ),
    timeoutMs,
    decisionId: boundedId("decision id", env.FIDUCIA_EVIDENCE_DECISION_ID),
    prometheusTargetId: boundedId(
      "Prometheus target id",
      env.FIDUCIA_PROMETHEUS_TARGET_ID,
    ),
    sourceCommit: requireCommit(
      "source commit",
      env.FIDUCIA_RELEASE_SOURCE_COMMIT,
    ),
    configCommit: requireCommit(
      "config commit",
      env.FIDUCIA_RELEASE_CONFIG_COMMIT,
    ),
    rulesCommit: requireCommit("rules commit", env.FIDUCIA_RULES_COMMIT),
    imageDigests: parseImageDigests(env.FIDUCIA_RELEASE_IMAGE_DIGESTS),
    cells,
    operations,
    probeLocations,
    independenceAttested,
    independenceReviewer,
    dashboardUid: boundedId("dashboard uid", env.FIDUCIA_DASHBOARD_UID),
    dashboardVersion: parseDashboardVersion(env.FIDUCIA_DASHBOARD_VERSION),
    window,
  };
}

export async function exportEvidence(config, generatedAt = new Date()) {
  const bearer = await readBearer(config.bearerFile);
  const queries = [];
  for (const query of QUERIES) {
    // Sequential execution makes the evidence order deterministic and avoids a
    // burst against the monitoring control plane.
    // eslint-disable-next-line no-await-in-loop
    queries.push(
      await queryPrometheus({
        baseUrl: config.prometheusUrl,
        bearer,
        query,
        time: config.window.endEpochSeconds,
        timeoutMs: config.timeoutMs,
        cells: config.cells,
        operations: config.operations,
        locations: config.probeLocations,
      }),
    );
  }

  const queriesComplete = queries.every(
    (query) => query.status === "success" && query.complete,
  );
  const observedProbeLocations = [
    ...new Set(
      queries
        .flatMap((query) => query.samples)
        .map((sample) => sample.labels.probe_location)
        .filter(Boolean),
    ),
  ].sort();
  const unsigned = {
    schema_version: SCHEMA_VERSION,
    evidence_type: "fiducia_managed_beta_slo_measurement",
    certification_authority: "none_independent_review_required",
    decision_id: config.decisionId,
    generated_at: generatedAt.toISOString(),
    measurement_window: {
      start: config.window.start,
      end: config.window.end,
      duration_seconds: config.window.durationSeconds,
    },
    release_candidate: {
      source_commit: config.sourceCommit,
      config_commit: config.configCommit,
      rules_commit: config.rulesCommit,
      image_digests: config.imageDigests,
      cells: config.cells,
      operation_classes: config.operations,
      dashboard: {
        uid: config.dashboardUid,
        version: config.dashboardVersion,
      },
    },
    measurement_source: {
      prometheus_target_id: config.prometheusTargetId,
      declared_probe_locations: config.probeLocations,
      observed_probe_locations: observedProbeLocations,
      location_matrix_complete:
        JSON.stringify(observedProbeLocations) ===
        JSON.stringify(config.probeLocations),
      independence_attested: config.independenceAttested,
      independence_reviewer: config.independenceReviewer,
    },
    exact_queries: queries,
    candidate_measurement_complete:
      queriesComplete &&
      config.independenceAttested &&
      config.probeLocations.length >= 2 &&
      JSON.stringify(observedProbeLocations) ===
        JSON.stringify(config.probeLocations),
    limitations: [
      "This bundle is not a contractual SLA and does not approve a go/no-go decision.",
      "Observed probe_location labels prove distinct metric lineages, not physical failure independence; the attestation and independent review remain required.",
      "The exporter records aggregate bounded SLO results and intentionally excludes tenant, credential, endpoint, request, trace, and response content.",
    ],
  };
  return {
    ...unsigned,
    integrity: {
      algorithm: "sha256",
      canonical_json_sha256: evidenceDigest(unsigned),
    },
  };
}

export async function run(config = parseConfig()) {
  return withExclusiveLock(config.lock, async () => {
    const evidence = await exportEvidence(config);
    await atomicWrite(config.output, `${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  });
}

async function main() {
  const evidence = await run();
  process.stdout.write(
    `managed-beta SLO evidence written; candidate_measurement_complete=${evidence.candidate_measurement_complete}\n`,
  );
  process.exitCode = evidence.candidate_measurement_complete ? 0 : 1;
}

if (IS_CLI) {
  main().catch((error) => {
    // Configuration errors are bounded policy messages. Prometheus URL,
    // credentials, raw API response, and output path are never echoed here.
    process.stderr.write(
      `managed-beta SLO evidence export failed: ${error.message}\n`,
    );
    process.exitCode = 2;
  });
}
