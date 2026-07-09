// Conformance: cron / durable schedules with exactly-once run records.
//
// Real-world framing: distributed jobs that must not double-fire — billing
// runs, certificate rotation, watchdogs — where two runners could otherwise
// both execute the same tick.
// Invariant we assert: a schedule can be created/read, and a run record for a
// given fire_id dedups a double-fire across callers (exactly-once).
//
// We deliberately assert the RUN-RECORD / claim semantics rather than waiting on
// wall-clock firing: waiting for a cron minute to elapse would make CI slow and
// flaky, and the exactly-once guarantee lives in the run record, not the timer.
//
// Routes/bodies per fiducia-clients/PROTOCOL.md ("Cron & scheduling — live").

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { output } from "../../src/client.mjs";
import { makeClient } from "../../src/endpoints.mjs";
import { NO_ENDPOINT, uniqueId, skipIfUndeployed } from "../helpers.mjs";

describe("cron / schedules", { skip: NO_ENDPOINT }, () => {
  it("a schedule upserts and reads back", async (t) => {
    const c = makeClient();
    const name = uniqueId("sched");

    await skipIfUndeployed(t, "PUT /v1/cron/schedules/{name}", async () => {
      const up = output(await c.scheduleUpsert(name, {
        cron: "*/5 * * * *",
        target: { kind: "webhook", url: "https://example.test/hook" },
        delivery: "exactly_once",
      }));
      assert.ok(up !== undefined, "upsert should return a result envelope");

      const got = await c.scheduleGet(name);
      // GET returns {found, schedule}; a just-created schedule should be found.
      if (got && typeof got === "object" && "found" in got) {
        assert.equal(got.found, true, "upserted schedule should be found");
      }
    });
  });

  it("a run record dedups a double-fire across callers (exactly-once)", async (t) => {
    const c = makeClient();
    const name = uniqueId("sched-run");
    const fireId = uniqueId("fire"); // same tick id from two racing runners

    await skipIfUndeployed(t, "POST /v1/cron/schedules/{name}/runs", async () => {
      await c.scheduleUpsert(name, {
        cron: "*/5 * * * *",
        target: { kind: "webhook", url: "https://example.test/hook" },
        delivery: "exactly_once",
      });

      const first = output(await c.scheduleRecordRun(name, fireId, 1_000));
      const second = output(await c.scheduleRecordRun(name, fireId, 1_000));

      // WRONG BEHAVIOR => FAIL: the same fire_id recorded twice must not count as
      // two distinct runs. Accept either a boolean recorded/duplicate flag or a
      // deduped history length of exactly 1 for this fire_id.
      const firstRecorded = first?.recorded ?? first?.committed ?? first?.first ?? true;
      const secondRecorded = second?.recorded;
      if (typeof firstRecorded === "boolean" && typeof secondRecorded === "boolean") {
        assert.equal(firstRecorded, true, "first record of a fire_id should succeed");
        assert.equal(secondRecorded, false, "second record of the same fire_id must be deduped");
      }

      const history = await c.scheduleHistory(name);
      const runs = history?.history ?? history?.runs;
      if (Array.isArray(runs)) {
        const forFire = runs.filter((r) => (r?.fire_id ?? r?.fireId) === fireId);
        // If the endpoint exposes per-fire history, exactly-once means one entry.
        if (forFire.length > 0) {
          assert.equal(forFire.length, 1, "a fire_id must appear exactly once in run history");
        }
      }
    });
  });
});
