import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  normalizeExpectedStatuses,
  parseExpectedStatuses,
  runAndPersist,
  runProbe,
} from "../../scripts/managed-beta-sli-probe.mjs";

describe("DEN-1404 managed beta external SLI probe hardening", () => {
  let server;
  let baseUrl;
  let temporary;
  let requestCount = 0;

  before(async () => {
    temporary = await mkdtemp(join(tmpdir(), "fiducia-sli-probe-hardening-"));
    server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(204);
      response.end();
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

  it("rejects partially parsed status and timeout values", async () => {
    assert.throws(() => parseExpectedStatuses("200oops"), /HTTP status integers/u);
    assert.throws(() => parseExpectedStatuses("200, 204ms"), /HTTP status integers/u);
    assert.throws(
      () => normalizeExpectedStatuses(new Set([200, "204"])),
      /only HTTP status integers/u,
    );
    assert.throws(
      () => normalizeExpectedStatuses(new Set([200, 700])),
      /only HTTP status integers/u,
    );

    await assert.rejects(
      runProbe({
        endpoint: `${baseUrl}/healthz`,
        cell: "cell-a",
        operationClass: "health",
        timeoutMs: "5000ms",
      }),
      /timeoutMs must be an integer/u,
    );
    assert.equal(requestCount, 0);
  });

  it("validates corrupt state before issuing an external operation", async () => {
    const stateFile = join(temporary, "corrupt-state.json");
    await writeFile(stateFile, "not-json\n", { mode: 0o600 });
    const beforeRequests = requestCount;

    await assert.rejects(
      runAndPersist({
        endpoint: `${baseUrl}/committed-write`,
        cell: "cell-a",
        operationClass: "committed_write",
        method: "POST",
        expectedStatuses: "204",
        stateFile,
      }),
      /state is not valid JSON/u,
    );
    assert.equal(requestCount, beforeRequests, "corrupt state must prevent the request");
  });

  it("validates mismatched state identity before issuing an external operation", async () => {
    const stateFile = join(temporary, "mismatched-state.json");
    await writeFile(
      stateFile,
      `${JSON.stringify({
        schemaVersion: 1,
        cell: "cell-b",
        operationClass: "committed_write",
        successTotal: 0,
        failureTotal: 0,
        lastResult: "failure",
        lastDurationSeconds: 0,
        lastRunUnixtime: 0,
        lastSuccessUnixtime: 0,
      })}\n`,
      { mode: 0o600 },
    );
    const beforeRequests = requestCount;

    await assert.rejects(
      runAndPersist({
        endpoint: `${baseUrl}/committed-write`,
        cell: "cell-a",
        operationClass: "committed_write",
        method: "POST",
        expectedStatuses: "204",
        stateFile,
      }),
      /identity does not match/u,
    );
    assert.equal(requestCount, beforeRequests, "mismatched state must prevent the request");
  });
});
