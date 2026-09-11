#!/usr/bin/env node

// DEN-1654: validate a machine-assisted review candidate against the exact
// checked-in managed-beta contract and safety-gate sources. This proves static
// coverage and honest maturity; it cannot create independent human approval.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(THIS_FILE);
const REPO_ROOT = resolve(dirname(THIS_FILE), "..");
const DEFAULT_MANIFEST = "docs/reviews/managed-beta-framework-review-candidate-v0.1.json";
const COMMIT = /^[0-9a-f]{40}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export const REQUIRED_ARTIFACT_PATHS = Object.freeze([
  "docs/operations/managed-beta-communication-templates.md",
  "docs/operations/managed-beta-incident-runbook.md",
  "docs/production/external-probe-location-contract.md",
  "docs/production/managed-public-beta-service-contract-v0.1.md",
  "docs/production/managed-public-beta-slo-derived-series.json",
  "docs/production/managed-public-beta-slos.json",
  "docs/security/production-safety-release-gate.json",
]);

export const REQUIRED_SLO_IDS = Object.freeze([
  "SLO-AVAIL-01",
  "SLO-SUCCESS-01",
  "SLO-READ-01",
  "SLO-WRITE-01",
  "SLO-RENEW-01",
  "SLO-FAILOVER-01",
  "SLO-REVOKE-01",
  "SLO-SECRET-01",
  "SLO-WATCH-01",
  "SLO-SUPPORT-01",
]);

export const REQUIRED_INVARIANTS = Object.freeze([
  "cross_tenant_access",
  "credential_plane_bypass",
  "secret_disclosure",
  "stale_fencing_accepted",
  "committed_state_regression",
  "unrecoverable_authoritative_state",
  "mutable_or_unverified_production_artifact",
  "missing_accountable_operator",
]);

export const REQUIRED_ROUTE_CLASSES = Object.freeze([
  "dashboard_customer",
  "dashboard_admin",
  "public_data_plane",
  "trusted_edge_to_lb",
  "lb_to_node",
  "auth_internal",
  "raft_peer",
  "sidecar_brain",
  "secret_delivery",
  "observability",
  "backup_restore",
  "build_release",
]);

export const REQUIRED_GATE_IDS = Object.freeze([
  "AUTH-001",
  "AUTH-002",
  "AUTH-003",
  "AUTH-004",
  "AUTH-005",
  "AUTH-006",
  "AUTH-007",
  "AUTH-008",
  "KV-001",
  "KV-002",
  "KV-003",
  "KV-004",
  "KV-005",
  "RAFT-001",
  "RAFT-002",
  "RAFT-003",
  "RAFT-004",
  "RAFT-005",
  "RESTORE-001",
  "RESTORE-002",
  "OBS-001",
  "BUILD-001",
  "BUILD-002",
  "BUILD-003",
  "OPS-001",
  "OPS-002",
]);

const REQUIRED_FINDING_IDS = Object.freeze([
  "F-001",
  "F-002",
  "F-003",
  "F-004",
  "F-005",
  "F-006",
]);

function fail(message) {
  throw new Error(message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function boundedId(value, label) {
  if (typeof value !== "string" || !BOUNDED_ID.test(value) || /[\r\n\0]/u.test(value)) {
    fail(`${label} must be a bounded identifier`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be a boolean`);
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative integer`);
  }
  return value;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function reviewDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function gitBlobSha1(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return createHash("sha1")
    .update(Buffer.from(`blob ${buffer.byteLength}\0`, "utf8"))
    .update(buffer)
    .digest("hex");
}

async function json(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`${label} is not readable JSON: ${error.message}`);
  }
}

function exactSet(actual, expected, label) {
  if (!Array.isArray(actual)) fail(`${label} must be an array`);
  const normalized = actual.map((entry) => nonEmpty(entry, `${label} entry`));
  if (new Set(normalized).size !== normalized.length) {
    fail(`${label} contains duplicates`);
  }
  const left = [...normalized].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    fail(`${label} does not exactly cover the canonical set`);
  }
  return left;
}

function exactEntryMap(entries, ids, label) {
  if (!Array.isArray(entries)) fail(`${label} must be an array`);
  const map = new Map();
  for (const entry of entries) {
    object(entry, `${label} entry`);
    const id = boundedId(entry.id, `${label}.id`);
    if (map.has(id)) fail(`${label} repeats ${id}`);
    map.set(id, entry);
  }
  exactSet([...map.keys()], ids, label);
  return map;
}

function requireStaticSloShape(slo) {
  const checks = {
    objective: typeof slo.objective === "string" && slo.objective.length > 0,
    source_series: Array.isArray(slo.source_series) && slo.source_series.length > 0,
    objective_queries:
      Array.isArray(slo.objective_queries) && slo.objective_queries.length > 0,
    alert_queries: Array.isArray(slo.alert_queries) && slo.alert_queries.length > 0,
    owner: typeof slo.owner === "string" && slo.owner.length > 0,
    review_cadence:
      typeof slo.review_cadence === "string" && slo.review_cadence.length > 0,
  };
  for (const [field, present] of Object.entries(checks)) {
    if (!present) fail(`${slo.id} is missing reviewed static field ${field}`);
  }
}

function requireStaticGateShape(test) {
  const checks = {
    threat: typeof test.threat === "string" && test.threat.length > 0,
    invariant: typeof test.invariant === "string" && test.invariant.length > 0,
    test: typeof test.test === "string" && test.test.length > 0,
    automation_target:
      typeof test.automation_target === "string" && test.automation_target.length > 0,
    evidence_required:
      typeof test.evidence_required === "string" && test.evidence_required.length > 0,
    owner: typeof test.owner === "string" && test.owner.length > 0,
  };
  for (const [field, present] of Object.entries(checks)) {
    if (!present) fail(`${test.id} is missing reviewed static field ${field}`);
  }
}

function verifyManifestIntegrity(manifest) {
  const integrity = object(manifest.integrity, "integrity");
  if (integrity.algorithm !== "sha256" || !SHA256.test(integrity.canonical_json_sha256 ?? "")) {
    fail("review manifest integrity is malformed");
  }
  const unsigned = structuredClone(manifest);
  delete unsigned.integrity;
  if (reviewDigest(unsigned) !== integrity.canonical_json_sha256) {
    fail("review manifest integrity does not match its payload");
  }
}

function verifyPendingHumanReview(manifest) {
  const independence = object(manifest.independence, "independence");
  if (manifest.status !== "human_signoff_required") {
    fail("machine-assisted candidate must remain human_signoff_required");
  }
  if (independence.machine_assisted_candidate !== true) {
    fail("machine-assisted review identity must be explicit");
  }
  if (
    independence.human_reviewer !== null ||
    independence.human_independence_attested !== false ||
    independence.human_signed_at !== null
  ) {
    fail("pending candidate must not manufacture a human signature");
  }
  const conclusion = object(manifest.conclusion, "conclusion");
  if (
    conclusion.framework_disposition !== "revise_and_hold" ||
    conclusion.release_decision !== "no_go" ||
    conclusion.framework_approved !== false ||
    conclusion.release_approved !== false ||
    conclusion.human_signoff_required !== true
  ) {
    fail("pending review conclusion must remain revise-and-hold/no-go");
  }
}

export async function validateReviewBundle({
  root = REPO_ROOT,
  manifestPath = DEFAULT_MANIFEST,
  requireApproved = false,
} = {}) {
  const repositoryRoot = resolve(root);
  const manifest = await json(resolve(repositoryRoot, manifestPath), "review manifest");
  object(manifest, "review manifest");
  verifyManifestIntegrity(manifest);

  if (manifest.schema_version !== 1) fail("review schema_version must be 1");
  if (manifest.review_issue !== "DEN-1654") fail("review_issue must be DEN-1654");
  if (manifest.service_contract_issue !== "DEN-1390") {
    fail("service_contract_issue must be DEN-1390");
  }
  if (manifest.safety_gate_issue !== "DEN-1391") {
    fail("safety_gate_issue must be DEN-1391");
  }
  if (manifest.review_kind !== "machine_assisted_independent_technical_review_candidate") {
    fail("review_kind is unsupported");
  }
  if (!COMMIT.test(manifest.baseline_commit ?? "")) {
    fail("baseline_commit must be a full lowercase commit");
  }
  verifyPendingHumanReview(manifest);

  const scope = object(manifest.review_scope, "review_scope");
  exactSet(scope.slo_ids, REQUIRED_SLO_IDS, "review_scope.slo_ids");
  exactSet(
    scope.automatic_no_go_invariants,
    REQUIRED_INVARIANTS,
    "review_scope.automatic_no_go_invariants",
  );
  exactSet(
    scope.required_route_classes,
    REQUIRED_ROUTE_CLASSES,
    "review_scope.required_route_classes",
  );
  exactSet(scope.safety_gate_ids, REQUIRED_GATE_IDS, "review_scope.safety_gate_ids");

  const artifacts = exactEntryMap(
    scope.artifacts,
    REQUIRED_ARTIFACT_PATHS,
    "review_scope.artifacts",
  );
  for (const path of REQUIRED_ARTIFACT_PATHS) {
    const artifact = artifacts.get(path);
    if (!SHA1.test(artifact.git_blob_sha1 ?? "")) {
      fail(`${path} has a malformed Git blob SHA-1`);
    }
    const bytes = await readFile(resolve(repositoryRoot, path));
    if (gitBlobSha1(bytes) !== artifact.git_blob_sha1) {
      fail(`${path} no longer matches the reviewed Git blob`);
    }
  }

  const slos = await json(
    resolve(repositoryRoot, "docs/production/managed-public-beta-slos.json"),
    "SLO catalog",
  );
  if (slos.contract_issue !== "DEN-1390" || slos.schema_version !== 1) {
    fail("SLO catalog identity is unexpected");
  }
  const canonicalSlos = exactEntryMap(slos.slos, REQUIRED_SLO_IDS, "canonical SLOs");
  const sloReview = object(manifest.slo_review, "slo_review");
  exactSet(
    sloReview.static_structure_reviewed_ids,
    REQUIRED_SLO_IDS,
    "slo_review.static_structure_reviewed_ids",
  );
  exactSet(
    sloReview.achievement_not_demonstrated_ids,
    REQUIRED_SLO_IDS,
    "slo_review.achievement_not_demonstrated_ids",
  );
  exactSet(
    sloReview.release_blocking_ids,
    REQUIRED_SLO_IDS,
    "slo_review.release_blocking_ids",
  );
  nonEmpty(sloReview.expected_source_status, "slo_review.expected_source_status");
  integer(sloReview.expected_evidence_count, "slo_review.expected_evidence_count");
  for (const slo of canonicalSlos.values()) {
    requireStaticSloShape(slo);
    const evidenceCount = Array.isArray(slo.evidence) ? slo.evidence.length : -1;
    if (
      slo.source_status !== sloReview.expected_source_status ||
      evidenceCount !== sloReview.expected_evidence_count
    ) {
      fail(`${slo.id} no longer matches the reviewed SLO maturity`);
    }
  }

  const derived = await json(
    resolve(
      repositoryRoot,
      "docs/production/managed-public-beta-slo-derived-series.json",
    ),
    "derived-series contract",
  );
  if (
    derived.contract_issue !== "DEN-1390" ||
    !Array.isArray(derived.series) ||
    derived.series.length === 0 ||
    derived.series.some(
      (series) =>
        !derived.allowed_source_statuses?.includes(series.source_status) ||
        !Array.isArray(series.evidence),
    )
  ) {
    fail("derived-series contract is incomplete or malformed");
  }

  const gate = await json(
    resolve(repositoryRoot, "docs/security/production-safety-release-gate.json"),
    "safety gate",
  );
  if (
    gate.gate_issue !== "DEN-1391" ||
    gate.service_contract_issue !== "DEN-1390" ||
    gate.schema_version !== 1
  ) {
    fail("safety-gate identity is unexpected");
  }
  exactSet(
    gate.automatic_no_go_invariants,
    REQUIRED_INVARIANTS,
    "canonical automatic no-go invariants",
  );
  exactSet(
    gate.required_route_classes,
    REQUIRED_ROUTE_CLASSES,
    "canonical required route classes",
  );
  const canonicalGate = exactEntryMap(gate.tests, REQUIRED_GATE_IDS, "canonical gate tests");
  const gateReview = object(manifest.gate_review, "gate_review");
  exactSet(
    gateReview.static_structure_reviewed_ids,
    REQUIRED_GATE_IDS,
    "gate_review.static_structure_reviewed_ids",
  );
  exactSet(
    gateReview.execution_not_demonstrated_ids,
    REQUIRED_GATE_IDS,
    "gate_review.execution_not_demonstrated_ids",
  );
  exactSet(
    gateReview.release_blocking_ids,
    REQUIRED_GATE_IDS,
    "gate_review.release_blocking_ids",
  );
  nonEmpty(gateReview.expected_status, "gate_review.expected_status");
  integer(gateReview.expected_evidence_count, "gate_review.expected_evidence_count");
  for (const test of canonicalGate.values()) {
    requireStaticGateShape(test);
    const evidenceCount = Array.isArray(test.evidence) ? test.evidence.length : -1;
    if (
      test.status !== gateReview.expected_status ||
      evidenceCount !== gateReview.expected_evidence_count
    ) {
      fail(`${test.id} no longer matches the reviewed gate maturity`);
    }
  }

  const invariantReview = object(manifest.invariant_review, "invariant_review");
  exactSet(invariantReview.declared_ids, REQUIRED_INVARIANTS, "invariant_review.declared_ids");
  exactSet(
    invariantReview.release_blocking_ids,
    REQUIRED_INVARIANTS,
    "invariant_review.release_blocking_ids",
  );
  exactSet(
    invariantReview.execution_demonstrated_ids,
    [],
    "invariant_review.execution_demonstrated_ids",
  );

  const routeReview = object(manifest.route_class_review, "route_class_review");
  exactSet(
    routeReview.declared_ids,
    REQUIRED_ROUTE_CLASSES,
    "route_class_review.declared_ids",
  );
  exactSet(
    routeReview.release_blocking_ids,
    REQUIRED_ROUTE_CLASSES,
    "route_class_review.release_blocking_ids",
  );
  exactSet(
    routeReview.live_evidence_demonstrated_ids,
    [],
    "route_class_review.live_evidence_demonstrated_ids",
  );

  const findings = exactEntryMap(manifest.findings, REQUIRED_FINDING_IDS, "findings");
  for (const finding of findings.values()) {
    nonEmpty(finding.title, `${finding.id}.title`);
    nonEmpty(finding.disposition, `${finding.id}.disposition`);
    boolean(finding.release_blocking, `${finding.id}.release_blocking`);
    if (!Array.isArray(finding.related_issues) || finding.related_issues.length === 0) {
      fail(`${finding.id}.related_issues must be non-empty`);
    }
  }

  const serviceContract = await readFile(
    resolve(
      repositoryRoot,
      "docs/production/managed-public-beta-service-contract-v0.1.md",
    ),
    "utf8",
  );
  const incidentRunbook = await readFile(
    resolve(repositoryRoot, "docs/operations/managed-beta-incident-runbook.md"),
    "utf8",
  );
  const probeContract = await readFile(
    resolve(repositoryRoot, "docs/production/external-probe-location-contract.md"),
    "utf8",
  );
  const communicationTemplates = await readFile(
    resolve(
      repositoryRoot,
      "docs/operations/managed-beta-communication-templates.md",
    ),
    "utf8",
  );
  for (const [label, content, patterns] of [
    [
      "service contract",
      serviceContract,
      [/provisional/iu, /not a contractual SLA/iu, /go\/no-go/iu],
    ],
    [
      "incident runbook",
      incidentRunbook,
      [/must be exercised before launch/iu, /automatic stop/iu, /tabletop/iu],
    ],
    [
      "probe contract",
      probeContract,
      [/failure-independent/iu, /probe_location/iu, /not sufficient/iu],
    ],
    [
      "communication templates",
      communicationTemplates,
      [/credential/iu, /customer/iu, /next update/iu],
    ],
  ]) {
    for (const pattern of patterns) {
      if (!pattern.test(content)) fail(`${label} is missing required review language`);
    }
  }

  const conclusion = object(manifest.conclusion, "conclusion");
  const blockingFindingCount = [...findings.values()].filter(
    (finding) => finding.release_blocking,
  ).length;
  if (
    integer(conclusion.blocking_slo_count, "conclusion.blocking_slo_count") !==
      sloReview.release_blocking_ids.length ||
    integer(conclusion.blocking_gate_count, "conclusion.blocking_gate_count") !==
      gateReview.release_blocking_ids.length ||
    integer(
      conclusion.blocking_finding_count,
      "conclusion.blocking_finding_count",
    ) !== blockingFindingCount
  ) {
    fail("conclusion blocker counts do not match the reviewed sets");
  }

  if (requireApproved) {
    const independence = manifest.independence;
    if (
      manifest.status !== "approved" ||
      independence.human_independence_attested !== true ||
      typeof independence.human_reviewer !== "string" ||
      independence.human_reviewer.trim() === "" ||
      typeof independence.human_signed_at !== "string" ||
      independence.human_signed_at.trim() === "" ||
      conclusion.framework_approved !== true
    ) {
      fail("independent human framework approval is not present");
    }
  }

  return {
    baseline_commit: manifest.baseline_commit,
    status: manifest.status,
    reviewed_artifacts: REQUIRED_ARTIFACT_PATHS.length,
    reviewed_slos: REQUIRED_SLO_IDS.length,
    reviewed_invariants: REQUIRED_INVARIANTS.length,
    reviewed_route_classes: REQUIRED_ROUTE_CLASSES.length,
    reviewed_gate_rows: REQUIRED_GATE_IDS.length,
    blocking_slos: sloReview.release_blocking_ids.length,
    blocking_gate_rows: gateReview.release_blocking_ids.length,
    blocking_findings: blockingFindingCount,
    release_decision: conclusion.release_decision,
    release_approved: conclusion.release_approved,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const requireApproved = args.includes("--require-approved");
  const positional = args.filter((arg) => arg !== "--require-approved");
  if (positional.length > 1) {
    process.stderr.write(
      "usage: node tools/validate-managed-beta-review.mjs [manifest.json] [--require-approved]\n",
    );
    process.exitCode = 2;
    return;
  }
  const result = await validateReviewBundle({
    manifestPath: positional[0] ?? DEFAULT_MANIFEST,
    requireApproved,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (IS_CLI) {
  main().catch((error) => {
    process.stderr.write(`managed-beta review validation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
