import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const dockerfilePath = "docker/managed-beta-probe.Dockerfile";
const workflowPath = ".github/workflows/managed-beta-sli-probe-oci.yml";

async function text(path) {
  return readFile(path, "utf8");
}

describe("DEN-1404/DEN-1619 managed beta probe OCI contract", () => {
  it("pins the exact Node base image by full digest", async () => {
    const dockerfile = await text(dockerfilePath);
    assert.match(
      dockerfile,
      /^FROM node:22\.22\.1-bookworm-slim@sha256:[0-9a-f]{64}$/mu,
    );
    assert.ok(!dockerfile.includes(":latest"));
  });

  it("runs one dependency-free script as a fixed non-root identity", async () => {
    const dockerfile = await text(dockerfilePath);
    assert.match(dockerfile, /^USER 1000:1000$/mu);
    assert.match(
      dockerfile,
      /^ENTRYPOINT \["node", "\/opt\/fiducia-probe\/managed-beta-sli-probe\.mjs"\]$/mu,
    );
    assert.match(
      dockerfile,
      /^COPY --chown=1000:1000 scripts\/managed-beta-sli-probe\.mjs \.\/managed-beta-sli-probe\.mjs$/mu,
    );
    assert.ok(!/^USER root$/mu.test(dockerfile));
    assert.ok(!/\b(?:apt-get|apk|curl|wget|npm|npx|yarn|pnpm)\b/u.test(dockerfile));
  });

  it("contains no embedded credential or customer identity input", async () => {
    const dockerfile = (await text(dockerfilePath)).toLowerCase();
    for (const forbidden of [
      "authorization:",
      "bearer ",
      "api_key=",
      "token=",
      "password=",
      "tenant_id",
      "org_id",
      "project_id",
      "environment_id",
    ]) {
      assert.ok(!dockerfile.includes(forbidden), `Dockerfile contains ${forbidden}`);
    }
  });

  it("proves the runtime carries an opaque location and schema-v2 state identity", async () => {
    const workflow = await text(workflowPath);
    assert.match(workflow, /FIDUCIA_PROBE_LOCATION=probe-a/u);
    assert.match(
      workflow,
      /probe_location=\"probe-a\"|probe_location="probe-a"/u,
    );
    assert.match(workflow, /\.schemaVersion == 2/u);
    assert.match(workflow, /\.probeLocation == "probe-a"/u);
    assert.ok(!workflow.includes("FIDUCIA_PROBE_LOCATION=https://"));
  });

  it("keeps registry publication separate from pull-request validation", async () => {
    const workflow = await text(workflowPath);
    assert.match(
      workflow,
      /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/u,
    );
    assert.match(workflow, /packages: write/u);
    assert.match(workflow, /provenance: mode=max/u);
    assert.match(workflow, /sbom: true/u);
    assert.match(
      workflow,
      /ghcr\.io\/fiducia-cloud\/fiducia-managed-beta-probe:\$\{\{ github\.sha \}\}/u,
    );
    assert.ok(!workflow.includes(":latest"));
  });
});
