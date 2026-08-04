import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");
const workflow = await readFile(
  new URL("../../.github/workflows/conformance-image.yml", import.meta.url),
  "utf8",
);

test("conformance image pins Node 26.5.1 by immutable multi-platform digest", () => {
  assert.match(
    dockerfile,
    /^FROM node:26\.5\.1-bookworm-slim@sha256:9e6f9357d371591e32ab6f2d8a26d63bdd0d17c29eee3f4f3e7e454d9634bf73$/mu,
  );
  assert.doesNotMatch(dockerfile, /FROM .*:(?:latest|current|main)(?:@|\s|$)/mu);
});

test("conformance image remains dependency-light and non-root", () => {
  assert.match(dockerfile, /^WORKDIR \/app$/mu);
  assert.match(dockerfile, /^COPY --chown=node:node package\.json \.\/$/mu);
  for (const directory of ["src", "tests", "scripts"]) {
    assert.match(
      dockerfile,
      new RegExp(`^COPY --chown=node:node ${directory} \\.\\/${directory}$`, "mu"),
    );
  }
  assert.match(dockerfile, /^USER node$/mu);
  assert.match(dockerfile, /^CMD \["npm", "test"\]$/mu);
  assert.doesNotMatch(dockerfile, /\b(?:apt-get|apk|curl|wget|npm ci|npm install)\b/u);
  assert.doesNotMatch(dockerfile, /^USER root$/mu);
  assert.doesNotMatch(dockerfile, /(?:TOKEN|PASSWORD|SECRET|PRIVATE_KEY)=/u);
});

test("CI builds and executes the image under a read-only, network-disabled runtime", () => {
  assert.match(workflow, /docker build[\s\S]*--pull[\s\S]*Dockerfile/u);
  assert.match(workflow, /--read-only/u);
  assert.match(workflow, /--network none/u);
  assert.match(workflow, /--tmpfs \/tmp:rw,noexec,nosuid,size=16m/u);
  assert.match(workflow, /--entrypoint node/u);
  assert.match(workflow, /--test tests\/smoke\.test\.mjs/u);
  assert.ok(
    workflow.includes(
      "docker image inspect --format '{{.Config.User}}' fiducia-e2e-conformance:contract",
    ),
  );
  assert.ok(
    workflow.includes(
      "docker image inspect --format '{{json .Config.Cmd}}' fiducia-e2e-conformance:contract",
    ),
  );
  assert.match(workflow, /test "\$version" = "v26\.5\.1"/u);
  assert.doesNotMatch(workflow, /docker push|packages: write/u);
});
