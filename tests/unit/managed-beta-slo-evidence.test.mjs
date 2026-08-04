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
const CELLS = ["cell-a", "cell-b"];
const LOCATIONS = ["probe-a", "probe-b"];
const BEARER = "prometheus-read-token-that-must-never-enter-evidence";
const RESPONSE_CANARY = "RESPONSE_SECRET_MUST_NOT_SURVIVE_4fd3356c";

function query(id) {
  const found = QUERIES.find((candidate) => candidate.id === id);
  assert.ok(found, `missing fixed query ${id}`);
  return found;
}

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
    return CELLS.map((cell) => ({
      labels: { __name__: expression, cell },
      value: cellValue[expression],
    }));
  }
  if (
    expression === "fiducia:sli:external_probe_freshness_seconds" ||
    expression === "fiducia:sli:external_probe_last_success_age_seconds"
  ) {
    return CELLS.flatMap((cell) =>
      LOCATIONS.map((probeLocation) => ({
        labels: {
          __name__: expression,
          cell,
          operation_class: "health",
          probe_location: probeLocation,
        },
        value:
          expression === "fiducia:sli:external_probe_freshness_seconds"
            ? 30
            : 60,
      })),
    );
  }

  const totalsExpression = query("external_probe_cumulative_totals").expression;
  const authorityExpression = query("external_probe_authority_count").expression;
  if (expression === totalsExpression || expression === authorityExpression) {
    return CELLS.flatMap((cell) =>
      LOCATIONS.flatMap((probeLocation) =>
        ["failure", "success"].map((result) => ({
          labels: {
            cell,
            operation_class: "health",
            probe_location: probeLocation,
            result,
          },
          value:
            expression === authorityExpression
              ? 1
              : result === "success"
                ? 9999
                : 1,
        })),
      ),
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
    cells: CELLS,
    operations: ["health"],
    probeLocations: LOCATIONS,
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

describe("DEN-1404/DEN-1619 managed beta SLO evidence exporter", () => {
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

  it("exports a complete location-observed content-addressed bundle without leaking endpoint or credential data", async () => {
    behavior = (expression) => vector(completeSamples(expression));
    seenQueries.length = 0;
    const evidence = await exportEvidence(config(baseUrl, temporary), END);

    assert.equal(evidence.schema_version, 2);
    assert.equal(evidence.candidate_measurement_complete, true);
    assert.equal(evidence.measurement_source.location_matrix_complete, true);
    assert.deepEqual(
      evidence.measurement_source.declared_probe_locations,
      LOCATIONS,
    );
    assert.deepEqual(
      evidence.measurement_source.observed_probe_locations,
      LOCATIONS,
    );
    assert.equal(evidence.exact_queries.length, QUERIES.length);
    assert.deepEqual(
      seenQueries.map((entry) => entry.expression),
      QUERIES.map((entry) => entry.expression),
    );
    assert.ok(
      seenQueries.every((entry) => entry.time === String(END.getTime() / 1000)),
      "every query must use the exact declared window end",
    );
    assert.ok(evidence.exact_queries.every((entry) => entry.complete));
    assert.ok(evidence.exact_queries.every((entry) => entry.status === "success"));

    const totalsQuery = query("external_probe_cumulative_totals");
    const authorityQuery = query("external_probe_authority_count");
    assert.equal(
      totalsQuery.expression,
      "max by (cell, operation_class, probe_location, result) (fiducia_external_probe_total)",
    );
    assert.equal(
      authorityQuery.expression,
      "count by (cell, operation_class, probe_location, result) (fiducia_external_probe_total)",
    );
    assert.equal(authorityQuery.exactValue, 1);
    assert.ok(
      !QUERIES.some((entry) => entry.expression === "fiducia_external_probe_total"),
      "raw scrape series must not cross the evidence boundary",
    );

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

  it("writes atomically with restrictive permissions", async () => {
    behavior = (expression) => vector(completeSamples(expression));
    const evidence = await run(config(baseUrl, temporary));
    assert.equal(evidence.candidate_measurement_complete, true);
    const stored = JSON.parse(
      await readFile(join(temporary, "evidence.json"), "utf8"),
    );
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

  it("marks one missing location incomplete even when the declared list contains two", async () => {
    behavior = (expression) =>
      vector(
        completeSamples(expression).filter(
          (sample) => sample.labels.probe_location !== "probe-b",
        ),
      );
    const evidence = await exportEvidence(config(baseUrl, temporary), END);

    assert.equal(evidence.candidate_measurement_complete, false);
    assert.equal(evidence.measurement_source.location_matrix_complete, false);
    assert.deepEqual(
      evidence.measurement_source.observed_probe_locations,
      ["probe-a"],
    );
    const locationQueries = evidence.exact_queries.filter((entry) =>
      entry.expression.includes("external_probe"),
    );
    assert.ok(locationQueries.every((entry) => entry.complete === false));
    assert.ok(
      locationQueries.every((entry) =>
        entry.missing.some((key) => key.includes("probe_location=probe-b")),
      ),
    );
  });

  it("fails closed when duplicate scrape series claim one probe authority", async () => {
    const authorityExpression = query("external_probe_authority_count").expression;
    behavior = (expression) => {
      const samples = completeSamples(expression);
      if (expression === authorityExpression) {
        samples[0] = { ...samples[0], value: 2 };
      }
      return vector(samples);
    };

    const evidence = await exportEvidence(config(baseUrl, temporary), END);
    const authority = evidence.exact_queries.find(
      (entry) => entry.id === "external_probe_authority_count",
    );
    assert.equal(authority.status, "prometheus_duplicate_probe_authority");
    assert.equal(authority.complete, false);
    assert.equal(authority.samples.length, 0);
    assert.equal(evidence.candidate_measurement_complete, false);
  });

  it("preserves honest no-data and missing-cell behavior", async () => {
    behavior = (expression) =>
      vector(
        completeSamples(expression).filter(
          (sample) => sample.labels.cell !== "cell-b",
        ),
      );
    const evidence = await exportEvidence(config(baseUrl, temporary), END);
    assert.equal(evidence.candidate_measurement_complete, false);
    for (const entry of evidence.exact_queries) {
      assert.equal(entry.complete, false);
      assert.ok(entry.missing.some((key) => key.includes("cell=cell-b")));
    }

    behavior = () => vector([]);
    const noData = await exportEvidence(config(baseUrl, temporary), END);
    assert.equal(noData.candidate_measurement_complete, false);
    assert.deepEqual(noData.measurement_source.observed_probe_locations, []);
    assert.ok(noData.exact_queries.every((entry) => entry.status === "no_data"));
  });

  it("rejects unexpected customer/location labels and redacts upstream HTTP bodies", async () => {
    behavior = (expression) => {
      if (expression === QUERIES[0].expression) {
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
    assert.equal(
      evidence.exact_queries.find((entry) => entry.id === "availability_ratio_28d")
        .status,
      "prometheus_unexpected_label",
    );
    assert.equal(
      evidence.exact_queries.find((entry) => entry.id === "availability_samples_28d")
        .status,
      "http_error",
    );
    assert.equal(evidence.candidate_measurement_complete, false);
    const serialized = JSON.stringify(evidence);
    assert.ok(!serialized.includes("customer-secret-tenant"));
    assert.ok(!serialized.includes(RESPONSE_CANARY));
  });

  it("validates exact identities, HTTPS, window, locations, digests, and approved operations", () => {
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
    assert.deepEqual(parsed.cells, CELLS);
    assert.deepEqual(parsed.operations, ["health"]);
    assert.deepEqual(parsed.probeLocations, LOCATIONS);
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
        FIDUCIA_PROBE_LOCATIONS: "probe-a,https://location.example",
      }),
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
    assert.throws(() =>
      validatePrometheusUrl("http://prometheus.example.invalid"),
    );
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

  it("detects duplicate/non-finite series and rejects undeclared locations", () => {
    const aggregateQuery = QUERIES[0];
    assert.throws(() =>
      sanitizePrometheusVector(
        aggregateQuery,
        vector([
          { labels: { cell: "cell-a" }, value: 1 },
          { labels: { cell: "cell-a" }, value: 1 },
        ]),
        ["cell-a"],
        ["health"],
        LOCATIONS,
      ),
    );
    assert.throws(() =>
      sanitizePrometheusVector(
        aggregateQuery,
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
        LOCATIONS,
      ),
    );

    const locationQuery = query("external_probe_freshness_seconds");
    assert.throws(
      () =>
        sanitizePrometheusVector(
          locationQuery,
          vector([
            {
              labels: {
                cell: "cell-a",
                operation_class: "health",
                probe_location: "undeclared-location",
              },
              value: 1,
            },
          ]),
          ["cell-a"],
          ["health"],
          LOCATIONS,
        ),
      /probe_location is outside the approved bounded label set/u,
    );

    const authorityQuery = query("external_probe_authority_count");
    assert.throws(
      () =>
        sanitizePrometheusVector(
          authorityQuery,
          vector([
            {
              labels: {
                cell: "cell-a",
                operation_class: "health",
                probe_location: "probe-a",
                result: "success",
              },
              value: 2,
            },
          ]),
          ["cell-a"],
          ["health"],
          LOCATIONS,
        ),
      /prometheus_duplicate_probe_authority/u,
    );
  });
});
