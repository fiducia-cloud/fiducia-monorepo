import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { makeRetryableReverseStop, postmasterIsAlive } from "../../src/webapps.mjs";

test("postmaster liveness probe fails closed and detects live processes", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "fiducia-postmaster-probe-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  assert.equal(await postmasterIsAlive(dataDir), false);
  await writeFile(join(dataDir, "postmaster.pid"), `${process.pid}\n`);
  assert.equal(await postmasterIsAlive(dataDir), true);

  await writeFile(join(dataDir, "postmaster.pid"), "not-a-pid\n");
  await assert.rejects(postmasterIsAlive(dataDir), /invalid PostgreSQL postmaster\.pid/);
});

test("web-app cleanup coalesces concurrent calls and retries only failed entries", async () => {
  const calls = [];
  let middleAttempts = 0;
  let releaseFirstAttempt;
  const firstAttemptGate = new Promise((resolve) => {
    releaseFirstAttempt = resolve;
  });
  const stack = [
    { stop: async () => calls.push("first") },
    {
      stop: async () => {
        middleAttempts += 1;
        calls.push(`middle-${middleAttempts}`);
        if (middleAttempts === 1) {
          await firstAttemptGate;
          throw new Error("transient cleanup failure");
        }
      },
    },
    { stop: async () => calls.push("last") },
  ];
  const stop = makeRetryableReverseStop(stack);

  const firstCall = stop();
  const concurrentCall = stop();
  assert.equal(concurrentCall, firstCall);
  releaseFirstAttempt();
  await assert.rejects(firstCall, AggregateError);

  assert.deepEqual(calls, ["last", "middle-1", "first"]);
  assert.equal(stack.length, 1, "only the failed cleanup entry should remain");

  await stop();
  assert.deepEqual(calls, ["last", "middle-1", "first", "middle-2"]);
  assert.equal(stack.length, 0);
  await stop();
  assert.equal(calls.length, 4, "a fully cleaned stack stays idempotent");
});
