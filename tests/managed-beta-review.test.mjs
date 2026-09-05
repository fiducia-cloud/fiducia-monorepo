import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  REQUIRED_ARTIFACT_PATHS,
  REQUIRED_GATE_IDS,
  REQUIRED_INVARIANTS,
  REQUIRED_ROUTE_CLASSES,
  REQUIRED_SLO_IDS,
  gitBlobSha1,
  reviewDigest,
  validateReviewBundle,
} from "../tools/validate-managed-beta-review.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(
  HERE,
  "../docs/reviews/managed-beta-framework-review-candidate-v0.1.json",
);
const MANIFEST = "docs/reviews/managed-beta-framework-review-candidate-v0.1.json";

function staticSlo(id) {
  return {
    id,
    objective: `${id} has a bounded objective`,
    source_series: [{ name: `${id.toLowerCase()}_total` }],
    objective_queries: [{ name: `${id.toLowerCase()}_objective` }],
    alert_queries: [{ name: `${id.toLowerCase()}_alert` }],
    owner: "owner",
    review_cadence: "daily",
    source_status: "specified",
    evidence: [],
  };
}

function staticGate(id, index) {
  return {
    id,
    threat: `${id} threat`,
    invariant: REQUIRED_INVARIANTS[index % REQUIRED_INVARIANTS.length],
    test: `${id} test procedure`,
    automation_target: `tests/${id.toLowerCase()}`,
    evidence_required: `${id} exact-candidate evidence`,
    owner: "owner",
    route_class: REQUIRED_ROUTE_CLASSES[index % REQUIRED_ROUTE_CLASSES.length],
    status: "not_started",
    evidence: [],
  };
}

function resign(manifest) {
  const unsigned = structuredClone(manifest);
  delete unsigned.integrity;
  manifest.integrity = {
    algorithm: "sha256",
    canonical_json_sha256: reviewDigest(unsigned),
  };
  return manifest;
}

async function writeFixture(mutator = null) {
  const root = await mkdtemp(join(tmpdir(), "fiducia-review-"));
  const fileContent = new Map([
    [
      "docs/operations/managed-beta-communication-templates.md",
      "Customer communication excludes credential material and always states the next update.\n",
    ],
    [
      "docs/operations/managed-beta-incident-runbook.md",
      "Provisional runbook: must be exercised before launch. Automatic stop and tabletop are mandatory.\n",
    ],
    [
      "docs/production/external-probe-location-contract.md",
      "Two failure-independent probe_location values are necessary but not sufficient.\n",
    ],
    [
      "docs/production/managed-public-beta-service-contract-v0.1.md",
      "Provisional service contract. This is not a contractual SLA. Independent go/no-go is required.\n",
    ],
    [
      "docs/production/managed-public-beta-slo-derived-series.json",
      `${JSON.stringify({
        contract_issue: "DEN-1390",
        allowed_source_statuses: ["specified", "instrumented", "queryable", "measured"],
        series: [{ source_status: "specified", evidence: [] }],
      })}\n`,
    ],
    [
      "docs/production/managed-public-beta-slos.json",
      `${JSON.stringify({
        schema_version: 1,
        contract_issue: "DEN-1390",
        slos: REQUIRED_SLO_IDS.map(staticSlo),
      })}\n`,
    ],
    [
      "docs/security/production-safety-release-gate.json",
      `${JSON.stringify({
        schema_version: 1,
        gate_issue: "DEN-1391",
        service_contract_issue: "DEN-1390",
        automatic_no_go_invariants: REQUIRED_INVARIANTS,
        required_route_classes: REQUIRED_ROUTE_CLASSES,
        tests: REQUIRED_GATE_IDS.map(staticGate),
      })}\n`,
    ],
  ]);

  for (const [path, content] of fileContent) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  const manifest = JSON.parse(await readFile(TEMPLATE, "utf8"));
  manifest.review_scope.artifacts = REQUIRED_ARTIFACT_PATHS.map((path) => ({
    id: path,
    git_blob_sha1: gitBlobSha1(Buffer.from(fileContent.get(path), "utf8")),
  }));
  if (mutator) await mutator({ root, manifest, fileContent });
  resign(manifest);
  const manifestPath = join(root, MANIFEST);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

async function withFixture(mutator, fn) {
  const root = await writeFixture(mutator);
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("validates a complete pending review candidate without approving release", async () => {
  await withFixture(null, async (root) => {
    const result = await validateReviewBundle({ root, manifestPath: MANIFEST });
    assert.equal(result.reviewed_slos, 10);
    assert.equal(result.reviewed_invariants, 8);
    assert.equal(result.reviewed_route_classes, 12);
    assert.equal(result.reviewed_gate_rows, 26);
    assert.equal(result.blocking_slos, 10);
    assert.equal(result.blocking_gate_rows, 26);
    assert.equal(result.release_decision, "no_go");
    assert.equal(result.release_approved, false);
  });
});

test("the approval mode fails closed while human sign-off is absent", async () => {
  await withFixture(null, async (root) => {
    await assert.rejects(
      validateReviewBundle({
        root,
        manifestPath: MANIFEST,
        requireApproved: true,
      }),
      /independent human framework approval is not present/u,
    );
  });
});

test("rejects missing SLO coverage even when manifest integrity is recomputed", async () => {
  await withFixture(
    async ({ manifest }) => {
      manifest.slo_review.static_structure_reviewed_ids.pop();
    },
    async (root) => {
      await assert.rejects(
        validateReviewBundle({ root, manifestPath: MANIFEST }),
        /slo_review\.static_structure_reviewed_ids does not exactly cover/u,
      );
    },
  );
});

test("rejects reviewed artifact drift", async () => {
  await withFixture(null, async (root) => {
    await writeFile(
      join(root, "docs/production/managed-public-beta-service-contract-v0.1.md"),
      "changed after review\n",
    );
    await assert.rejects(
      validateReviewBundle({ root, manifestPath: MANIFEST }),
      /no longer matches the reviewed Git blob/u,
    );
  });
});

test("rejects a false demonstrated SLO claim", async () => {
  await withFixture(
    async ({ manifest }) => {
      manifest.slo_review.expected_source_status = "measured";
    },
    async (root) => {
      await assert.rejects(
        validateReviewBundle({ root, manifestPath: MANIFEST }),
        /no longer matches the reviewed SLO maturity/u,
      );
    },
  );
});

test("rejects fabricated human identity while status remains pending", async () => {
  await withFixture(
    async ({ manifest }) => {
      manifest.independence.human_reviewer = "claimed-reviewer";
      manifest.independence.human_independence_attested = true;
      manifest.independence.human_signed_at = "2026-09-03T00:00:00Z";
    },
    async (root) => {
      await assert.rejects(
        validateReviewBundle({ root, manifestPath: MANIFEST }),
        /must not manufacture a human signature/u,
      );
    },
  );
});
