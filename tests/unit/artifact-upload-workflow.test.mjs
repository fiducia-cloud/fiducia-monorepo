import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PIN = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const cron = await readFile(
  new URL("../../.github/workflows/cron-staging.yml", import.meta.url),
  "utf8",
);
const contract = await readFile(
  new URL("../../.github/workflows/artifact-upload-contract.yml", import.meta.url),
  "utf8",
);

test("all upload-artifact calls use the immutable v7.0.0 commit", () => {
  for (const [name, workflow] of [
    ["cron-staging", cron],
    ["artifact-upload-contract", contract],
  ]) {
    assert.ok(workflow.includes(PIN), `${name} is missing the immutable v7 pin`);
    assert.doesNotMatch(
      workflow,
      /actions\/upload-artifact@(?:v\d+|main|master|[0-9a-f]{7,39})(?:\s|$)/u,
    );
  }
});

test("the staging transcript upload remains bounded and failure-visible", () => {
  assert.match(cron, /name: Upload sanitized proof transcript/u);
  assert.match(
    cron,
    /name: fiducia-cron-staging-proof-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u,
  );
  assert.match(cron, /path: \/tmp\/fiducia-cron-staging-proof\.tap/u);
  assert.match(cron, /if-no-files-found: error/u);
  assert.match(cron, /retention-days: 14/u);
  assert.doesNotMatch(cron, /archive: false/u);
});

test("the pull-request contract exercises a synthetic one-file upload without secrets", () => {
  assert.match(contract, /runs-on: ubuntu-24\.04/u);
  assert.match(contract, /permissions:[\s\S]*contents: read/u);
  assert.match(contract, /persist-credentials: false/u);
  assert.match(contract, /synthetic upload-artifact v7 contract/u);
  assert.match(contract, /path: \$\{\{ runner\.temp \}\}\/fiducia-artifact-contract\.tap/u);
  assert.match(contract, /if-no-files-found: error/u);
  assert.match(contract, /retention-days: 1/u);
  assert.match(contract, /compression-level: 0/u);
  assert.match(contract, /include-hidden-files: false/u);
  const githubTokenName = ["GITHUB", "TOKEN"].join("_");
  assert.ok(!contract.includes(githubTokenName));
  assert.doesNotMatch(contract, /secrets\.|packages: write|contents: write/u);
});
