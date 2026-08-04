import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  APPROVED_OPERATION_CLASSES,
  QUERIES,
  evidenceDigest,
  exportEvidence,
  parseConfig,
  run,
  sanitizePrometheusVector,
  validatePrometheusUrl,
} from "../../scripts/export-managed-beta-slo-evidence.mjs";

const END = new Date("2026-07-29T00:00:00.000Z");
const START = new Date("2026-07-01T00:00:00.000Z");
const BEARER = "prometheus-read-token-that-must-never-enter-evidence";
const RESPONSE_CANARY = "RESPONSE_SECRET_MUST_NOT_SURVIVE_4fd3356c";

function vector(samples) {
  return {
    status: "success",
    data: {
      resultType: "vector",
      result: samples.map(({ labels, value }) => ({
        metric: labels,
        value: [END.getTime() / 1000, String(value)],
      })),
    },
  };
}

function completeSamples(expression) {
  const cellValue = {
    "fiducia:sli:public_availability_ratio:28d": 0.999,
    "fiducia:sli:public_availability_samples:28d": 10_000,
    "fiducia:sli:public_availability_error_budget_remaining_ratio:28d": 0.8,
    "fiducia:sli:public_availability_burn_rate:1h": 0.2,
    "fiducia:sli:public_availability_burn_rate:6h": 0.1,
  };
  if (Object.hasOwn(cellValue, expression)) {
    return ["cell-a", "cell-b"].map((cell) => ({
      labels: { __name__: expression, cell },
      value: cellValue[expression],
    }));
  }
  if (expression === "fiducia:sli:external_probe_freshness_seconds") {
    return ["cell-a", "cell-b"].map((cell) => ({
      labels: { __name__: expression, cell, operation_class: "health" },
      value: 30,
    }));
  }
  if (expression === "fiducia:sli:external_probe_last_success_age_seconds") {
    return ["cell-a", "cell-b"].map((cell) => ({
      labels: { __name__: expression, cell, operation_class: "health" },
      value: 60,
    }));
  }
  if (expression === "fiducia_external_probe_total") {
    return ["cell-a", "cell-b"].flatMap((cell) =>
      ["failure", "success"].map((result) => ({
        labels: {
          __name__: expression,
          cell,
          operation_class: "health",
          result,
        },
        value: result === "success" ? 9999 : 1,
      })),
    );
  }
  throw new Error(`unhandled expression ${expression}`);
}

function config(baseUrl, temporary, overrides = {}) {
  return {
    prometheusUrl: new URL(baseUrl),
    bearerFile: join(temporary, "bearer"),
    output: join(temporary, "evidence.json"),
    lock: join(temporary, "evidence.lock"),
    timeoutMs: 2_000,
    decisionId: "beta-candidate-2026-07",
    prometheusTargetId: "managed-beta-central",
    sourceCommit: "a".repeat(40),
    configCommit: "b".repeat(40),
    rulesCommit: "c".repeat(40),
    imageDigests: [
      { name: "fiducia-load-balance", digest: `sha256:${"1".repeat(64)}` },
      { name: "fiducia-node", digest: `sha256:${"2".repeat(64)}` },
    ],
    cells: ["cell-a", "cell-b"],
    operations: ["health"],
    probeLocations: ["probe-a", "probe-b"],
    independenceAttested: true,
    independenceReviewer: "reviewer-a",
    dashboardUid: "fiducia-managed-beta-slo",
    dashboardVersion: 1,
    window: {
      start: START.toISOString(),
      end: END.toISOString(),
      endEpochSeconds: END.getTime() / 1000,
      durationSeconds: (END.getTime() - START.getTime()) / 1000,
    },
    ...overrides,
  };
}

describe("DEN-1404 managed beta SLO evidence exporter", () => {
  let temporary;
  let server;
  let baseUrl;
  let behavior;
  const seenQueries = [];

  before(async () => {
    temporary = await mkdtemp(join(tmpdir(), "fiducia-slo-evidence-"));
    await writeFile(join(temporary, "bearer"), `${BEARER}\n`, { mode: 0o600 });
    behavior = (expression) => vector(completeSamples(expression));
    server = createServer((request, response) => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/api/v1/query");
      assert.equal(request.headers.authorization, `Bearer ${BEARER}`);
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const expression = form.get("query");
        seenQueries.push({ expression, time: form.get("time") });
        const result = behavior(expression);
        response.writeHead(result.statusCode ?? 200, {
          "content-type": "application/json",
        });
        response.end(
          typeof result.body === "string"
            ? result.body
            : JSON.stringify(result.body ?? result),
        );
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });

  it("exports a complete content-addressed bundle with exact fixed queries and no endpoint or credential leakage", async () => {
    behavior = (expression) => vector(completeSamples(expression));
    seenQueries.length = 0;
    const evidence = await exportEvidence(config(baseUrl, temporary), END);

    assert.equal(evidence.candidate_measurement_complete, true);
    assert.equal(evidence.exact_queries.length, QUERIES.length);
    assert.deepEqual(
      seenQueries.map((query) => query.expression),
      QUERIES.map((query) => query.expression),
    );
    assert.ok(
      seenQueries.every((query) => query.time === String(END.getTime() / 1000)),
      "every query must use the exact declared window end",
    );
    assert.ok(evidence.exact_queries.every((query) => query.complete));
    assert.ok(evidence.exact_queries.every((query) => query.status === "success"));

    const unsigned = structuredClone(evidence);
    delete unsigned.integrity;
    assert.equal(
      evidence.integrity.canonical_json_sha256,
      evidenceDigest(unsigned),
    );

    const serialized = JSON.stringify(evidence);
    for (const forbidden of [
      BEARER,
      baseUrl,
      "authorization",
      "api_key",
      "tenant_id",
      "request_id",
      "trace_id",
      RESPONSE_CANARY,
    ]) {
      assert.ok(!serialized.includes(forbidden), `evidence leaked ${forbidden}`);
    }
  });

  it("writes the final bundle atomically with restrictive permissions", async () => {
    behavior = (expression) => vector(completeSamples(expression));
    const evidence = await run(config(baseUrl, temporary));
    assert.equal(evidence.candidate_measurement_complete, true);
    const stored = JSON.parse(await readFile(join(temporary, "evidence.json"), "utf8"));
    assert.equal(
      stored.integrity.canonical_json_sha256,
      evidence.integrity.canonical_json_sha256,
    );
    assert.equal((await stat(join(temporary, "evidence.json"))).mode & 0o777, 0o600);
    await assert.rejects(
      stat(join(temporary, "evidence.lock")),
      (error) => error?.code === "ENOENT",
    );
  });

  it("preserves honest no-data and missing-cell completeness instead of manufacturing success", async () => {
    behavior = (expression) => {
      const samples = completeSamples(expression).filter(
        (sample) => sample.labels.cell !== "cell-b",
      );
      return vector(samples);
    };
    const evidence = await exportEvidence(config(baseUrl, temporary), END);
    assert.equal(evidence.candidate_measurement_complete, false);
    for (const query of evidence.exact_queries) {
      assert.equal(query.complete, false);
      assert.ok(query.missing.some((key) => key.includes("cell=cell-b")));
      assert.ok(!query.unexpected.some((key) => key.includes("cell=cell-b")));
    }

    behavior = () => vector([]);
    const noData = await exportEvidence(config(baseUrl, temporary), END);
    assert.equal(noData.candidate_measurement_complete, false);
    assert.ok(noData.exact_queries.every((query) => query.status === "no_data"));
    assert.ok(noData.exact_queries.every((query) => query.samples.length === 0));
  });

  it("rejects unexpected customer labels and redacts upstream HTTP bodies", async () => {
    const firstExpression = QUERIES[0].expression;
    behavior = (expression) => {
      if (expression === firstExpression) {
        return vector([
          {
            labels: {
              __name__: expression,
              cell: "cell-a",
              tenant_id: "customer-secret-tenant",
            },
            value: 0.999,
          },
        ]);
      }
      if (expression === QUERIES[1].expression) {
        return {
          statusCode: 500,
          body: JSON.stringify({ error: RESPONSE_CANARY }),
        };
      }
      return vector(completeSamples(expression));
    };
    const evidence = await exportEvidence(config(baseUrl, temporary), END);
    const unexpected = evidence.exact_queries.find(
      (query) => query.id === "availability_ratio_28d",
    );
    const upstream = evidence.exact_queries.find(
      (query) => query.id === "availability_samples_28d",
    );
    assert.equal(unexpected.status, "prometheus_unexpected_label");
    assert.equal(upstream.status, "http_error");
    assert.equal(evidence.candidate_measurement_complete, false);
    const serialized = JSON.stringify(evidence);
    assert.ok(!serialized.includes("customer-secret-tenant"));
    assert.ok(!serialized.includes(RESPONSE_CANARY));
  });

  it("validates exact identities, HTTPS policy, 28-day window, independent probes, digests, and approved operation classes", () => {
    const baseEnv = {
      FIDUCIA_PROMETHEUS_URL: "https://prometheus.example.invalid/base",
      FIDUCIA_SLO_EVIDENCE_OUTPUT: "/tmp/evidence.json",
      FIDUCIA_EVIDENCE_DECISION_ID: "candidate-a",
      FIDUCIA_PROMETHEUS_TARGET_ID: "prometheus-a",
      FIDUCIA_RELEASE_SOURCE_COMMIT: "a".repeat(40),
      FIDUCIA_RELEASE_CONFIG_COMMIT: "b".repeat(40),
      FIDUCIA_RULES_COMMIT: "c".repeat(40),
      FIDUCIA_RELEASE_IMAGE_DIGESTS: `node=sha256:${"1".repeat(64)},lb=sha256:${"2".repeat(64)}`,
      FIDUCIA_RELEASE_CELLS: "cell-a,cell-b",
      FIDUCIA_RELEASE_OPERATION_CLASSES: "health",
      FIDUCIA_PROBE_LOCATIONS: "probe-a,probe-b",
      FIDUCIA_PROBE_INDEPENDENCE_ATTESTED: "true",
      FIDUCIA_PROBE_INDEPENDENCE_REVIEWER: "reviewer-a",
      FIDUCIA_DASHBOARD_UID: "fiducia-managed-beta-slo",
      FIDUCIA_DASHBOARD_VERSION: "1",
      FIDUCIA_EVIDENCE_WINDOW_START: START.toISOString(),
      FIDUCIA_EVIDENCE_WINDOW_END: END.toISOString(),
    };
    const parsed = parseConfig(baseEnv);
    assert.deepEqual(parsed.cells, ["cell-a", "cell-b"]);
    assert.deepEqual(parsed.operations, ["health"]);
    assert.equal(parsed.independenceAttested, true);

    assert.throws(() =>
      parseConfig({ ...baseEnv, FIDUCIA_RELEASE_SOURCE_COMMIT: "short" }),
    );
    assert.throws(() =>
      parseConfig({ ...baseEnv, FIDUCIA_RELEASE_IMAGE_DIGESTS: "node=latest" }),
    );
    assert.throws(() =>
      parseConfig({ ...baseEnv, FIDUCIA_PROBE_LOCATIONS: "probe-a" }),
    );
    assert.throws(() =>
      parseConfig({
        ...baseEnv,
        FIDUCIA_RELEASE_OPERATION_CLASSES: "tenant-specific-operation",
      }),
    );
    assert.throws(() =>
      parseConfig({
        ...baseEnv,
        FIDUCIA_EVIDENCE_WINDOW_START: "2026-07-02T00:00:00Z",
      }),
    );
    assert.throws(() => validatePrometheusUrl("http://prometheus.example.invalid"));
    assert.doesNotThrow(() =>
      validatePrometheusUrl("http://127.0.0.1:9090", true),
    );
    assert.ok(APPROVED_OPERATION_CLASSES.has("health"));
  });

  it("rejects multiline bearer material before making a monitoring request", async () => {
    const multiline = join(temporary, "multiline-bearer");
    await writeFile(multiline, "first-line\nsecond-line\n", { mode: 0o600 });
    behavior = (expression) => vector(completeSamples(expression));
    const beforeCount = seenQueries.length;
    await assert.rejects(
      exportEvidence(
        config(baseUrl, temporary, { bearerFile: multiline }),
        END,
      ),
      /one bounded non-empty line/u,
    );
    assert.equal(seenQueries.length, beforeCount);
  });

  it("sanitizes vectors independently of HTTP and detects duplicate or non-finite series", () => {
    const query = QUERIES[0];
    assert.throws(() =>
      sanitizePrometheusVector(
        query,
        vector([
          { labels: { cell: "cell-a" }, value: 1 },
          { labels: { cell: "cell-a" }, value: 1 },
        ]),
        ["cell-a"],
        ["health"],
      ),
    );
    assert.throws(() =>
      sanitizePrometheusVector(
        query,
        {
          status: "success",
          data: {
            resultType: "vector",
            result: [
              {
                metric: { cell: "cell-a" },
                value: [END.getTime() / 1000, "NaN"],
              },
            ],
          },
        },
        ["cell-a"],
        ["health"],
      ),
    );
  });
});
