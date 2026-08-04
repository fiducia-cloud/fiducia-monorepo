import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  atomicWrite,
  parseExpectedStatuses,
  readProbeState,
  renderPrometheus,
  runAndPersist,
  runProbe,
  validateBoundedLabel,
  validateState,
  withExclusiveLock,
} from "../../scripts/managed-beta-sli-probe.mjs";

describe("DEN-1404 managed beta external SLI probe", () => {
  let server;
  let baseUrl;
  let temporary;
  const canary = "FDC_CANARY_DO_NOT_EXPORT_7b79b186";
  const bearer = "fdc_live_test.this-value-must-never-enter-metrics";

  before(async () => {
    temporary = await mkdtemp(join(tmpdir(), "fiducia-sli-probe-"));
    server = createServer((request, response) => {
      if (request.url.startsWith("/ok")) {
        assert.equal(request.headers.authorization, `Bearer ${bearer}`);
        response.writeHead(204, {
          "x-debug-canary": canary,
          "content-type": "text/plain",
        });
        response.end(canary);
        return;
      }
      if (request.url === "/oversized") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("x".repeat(128 * 1024));
        return;
      }
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: canary }));
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

  it("persists cumulative success counters and never exports response or credential content", async () => {
    const bearerFile = join(temporary, "bearer");
    const stateFile = join(temporary, "success-state.json");
    const textfile = join(temporary, "success.prom");
    await writeFile(bearerFile, `${bearer}\n`, { mode: 0o600 });

    const first = await runAndPersist({
      endpoint: `${baseUrl}/ok?key=customer-secret-path`,
      cell: "cell-a",
      operationClass: "health",
      method: "GET",
      expectedStatuses: new Set([204]),
      bearerFile,
      stateFile,
      textfile,
    });
    const second = await runAndPersist({
      endpoint: `${baseUrl}/ok?key=another-customer-secret-path`,
      cell: "cell-a",
      operationClass: "health",
      method: "GET",
      expectedStatuses: new Set([204]),
      bearerFile,
      stateFile,
      textfile,
    });

    assert.equal(first.state.successTotal, 1);
    assert.equal(second.state.successTotal, 2);
    assert.equal(second.state.failureTotal, 0);
    assert.equal(second.state.lastSuccessUnixtime, second.state.lastRunUnixtime);

    const metrics = await readFile(textfile, "utf8");
    assert.match(
      metrics,
      /fiducia_external_probe_total\{cell="cell-a",operation_class="health",result="success"\} 2/u,
    );
    assert.match(
      metrics,
      /fiducia_external_probe_total\{cell="cell-a",operation_class="health",result="failure"\} 0/u,
    );
    for (const forbidden of [
      bearer,
      canary,
      "customer-secret-path",
      "another-customer-secret-path",
      baseUrl,
      "authorization",
      "request_id",
      "trace_id",
    ]) {
      assert.ok(!metrics.includes(forbidden), `metrics leaked ${forbidden}`);
    }
  });

  it("accumulates HTTP and transport failures while preserving the last successful timestamp", async () => {
    const stateFile = join(temporary, "mixed-state.json");
    const successSample = {
      cell: "cell-b",
      operationClass: "linearizable_read",
      result: "success",
      status: 200,
      durationSeconds: 0.01,
      timestampSeconds: 100,
    };
    const seeded = {
      schemaVersion: 1,
      cell: "cell-b",
      operationClass: "linearizable_read",
      successTotal: 1,
      failureTotal: 0,
      lastResult: "success",
      lastDurationSeconds: successSample.durationSeconds,
      lastRunUnixtime: successSample.timestampSeconds,
      lastSuccessUnixtime: successSample.timestampSeconds,
    };
    await atomicWrite(stateFile, `${JSON.stringify(seeded)}\n`);

    const httpFailure = await runAndPersist({
      endpoint: `${baseUrl}/unavailable`,
      cell: "cell-b",
      operationClass: "linearizable_read",
      expectedStatuses: "200,204",
      stateFile,
    });
    assert.equal(httpFailure.sample.result, "failure");
    assert.equal(httpFailure.sample.status, 503);
    assert.equal(httpFailure.state.successTotal, 1);
    assert.equal(httpFailure.state.failureTotal, 1);
    assert.equal(httpFailure.state.lastSuccessUnixtime, 100);
    assert.ok(!httpFailure.metrics.includes(canary));

    const transportFailure = await runAndPersist({
      endpoint: "http://127.0.0.1:9/not-listening",
      cell: "cell-b",
      operationClass: "linearizable_read",
      timeoutMs: 250,
      stateFile,
    });
    assert.equal(transportFailure.sample.result, "failure");
    assert.equal(transportFailure.sample.status, null);
    assert.equal(transportFailure.state.successTotal, 1);
    assert.equal(transportFailure.state.failureTotal, 2);
    assert.equal(transportFailure.state.lastSuccessUnixtime, 100);
  });

  it("bounds response consumption without exporting body content", async () => {
    const stateFile = join(temporary, "oversized-state.json");
    const result = await runAndPersist({
      endpoint: `${baseUrl}/oversized`,
      cell: "cell-c",
      operationClass: "secret_read",
      expectedStatuses: "200",
      stateFile,
    });
    assert.equal(result.sample.result, "success");
    assert.equal(result.state.successTotal, 1);
    assert.ok(!result.metrics.includes("x".repeat(100)));
  });

  it("rejects unbounded configuration, corrupted/mismatched state, and multiline bearer files", async () => {
    assert.throws(() => validateBoundedLabel("cell", "Org ID: customer-123"));
    assert.throws(() => parseExpectedStatuses("200,not-a-status"));

    await assert.rejects(
      runProbe({
        endpoint: `${baseUrl}/ok`,
        cell: "cell-a",
        operationClass: "tenant_42",
      }),
    );
    await assert.rejects(
      runProbe({
        endpoint: `${baseUrl}/ok`,
        cell: "cell-a",
        operationClass: "health",
        method: "TRACE",
      }),
    );
    await assert.rejects(
      runProbe({
        endpoint: `${baseUrl}/ok`,
        cell: "cell-a",
        operationClass: "health",
        timeoutMs: 31_000,
      }),
    );
    await assert.rejects(
      runAndPersist({
        endpoint: `${baseUrl}/ok`,
        cell: "cell-a",
        operationClass: "health",
      }),
    );

    const badBearer = join(temporary, "bad-bearer");
    await writeFile(badBearer, "first\nsecond\n", { mode: 0o600 });
    await assert.rejects(
      runProbe({
        endpoint: `${baseUrl}/ok`,
        cell: "cell-a",
        operationClass: "health",
        bearerFile: badBearer,
      }),
    );

    const corrupted = join(temporary, "corrupted-state.json");
    await writeFile(corrupted, "not-json\n", { mode: 0o600 });
    await assert.rejects(readProbeState(corrupted, "cell-a", "health"));

    const mismatched = join(temporary, "mismatched-state.json");
    await writeFile(
      mismatched,
      `${JSON.stringify({
        schemaVersion: 1,
        cell: "cell-other",
        operationClass: "health",
        successTotal: 0,
        failureTotal: 0,
        lastResult: "failure",
        lastDurationSeconds: 0,
        lastRunUnixtime: 0,
        lastSuccessUnixtime: 0,
      })}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(readProbeState(mismatched, "cell-a", "health"));

    assert.throws(() =>
      validateState(
        {
          schemaVersion: 1,
          cell: "cell-a",
          operationClass: "health",
          successTotal: Number.MAX_SAFE_INTEGER,
          failureTotal: 0,
          lastResult: "failure",
          lastDurationSeconds: 0,
          lastRunUnixtime: 0,
          lastSuccessUnixtime: 0,
        },
        "cell-a",
        "health",
      ),
    );
  });

  it("writes state/textfile atomically with restrictive permissions and rejects overlapping runs without polling", async () => {
    const target = join(temporary, "fiducia-managed-beta.prom");
    await atomicWrite(target, "metric 1\n");
    assert.equal(await readFile(target, "utf8"), "metric 1\n");
    assert.equal((await stat(target)).mode & 0o777, 0o600);

    const lock = join(temporary, "probe-state.lock");
    let release;
    const first = withExclusiveLock(lock, async () => {
      await new Promise((resolve) => {
        release = resolve;
      });
    });
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      withExclusiveLock(lock, async () => {}),
      /already held/u,
    );
    release();
    await first;
    await assert.rejects(stat(lock), (error) => error?.code === "ENOENT");
    await unlink(lock).catch(() => {});
  });

  it("renders a valid cumulative state without inventing a successful observation", () => {
    const state = {
      schemaVersion: 1,
      cell: "cell-d",
      operationClass: "health",
      successTotal: 0,
      failureTotal: 3,
      lastResult: "failure",
      lastDurationSeconds: 1.25,
      lastRunUnixtime: 1234,
      lastSuccessUnixtime: 0,
    };
    const metrics = renderPrometheus(state);
    assert.match(metrics, /result="success"\} 0/u);
    assert.match(metrics, /result="failure"\} 3/u);
    assert.match(metrics, /last_success_unixtime\{[^}]+\} 0/u);
  });
});
