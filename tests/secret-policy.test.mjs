import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  checkRepositorySecretPolicy,
  validateSopsDotenv,
} from "../scripts/check-secret-policy.mjs";

async function repository(files) {
  const root = await mkdtemp(join(tmpdir(), "fiducia-secret-policy-test."));
  execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { mode: 0o600 });
  }
  execFileSync("git", ["-C", root, "add", "--", "."], {
    stdio: "ignore",
  });
  return root;
}

function sopsDotenv(
  value = "ENC[AES256_GCM,data:fixture,iv:fixture,tag:fixture,type:str]",
) {
  return [
    `TOKEN=${value}`,
    "sops_age__list_0__map_enc=-----BEGIN AGE ENCRYPTED FILE-----\\nfixture\\n-----END AGE ENCRYPTED FILE-----\\n",
    "sops_age__list_0__map_recipient=age1fixturecustomerrecipient000000000000000000000000000000",
    "sops_lastmodified=2026-08-04T00:00:00Z",
    "sops_mac=ENC[AES256_GCM,data:fixture,iv:fixture,tag:fixture,type:str]",
    "sops_unencrypted_suffix=_unencrypted",
    "sops_version=3.13.3",
    "",
  ].join("\n");
}

function rules(findings) {
  return findings.map(({ rule }) => rule);
}

test("accepts placeholders and structurally valid SOPS dotenv files", async () => {
  const root = await repository({
    ".env.example": "DATABASE_URL=\nTOKEN=replace-me\n",
    "secrets/README.md": "No plaintext values.\n",
    "secrets/customer/dev.sops.env": sopsDotenv(),
  });

  assert.deepEqual(await checkRepositorySecretPolicy(root), []);
});

test("rejects plaintext application values despite valid-looking SOPS metadata", async () => {
  assert.equal(validateSopsDotenv(sopsDotenv("plaintext-value")), false);
  const root = await repository({
    "secrets/customer/dev.sops.env": sopsDotenv("plaintext-value"),
  });

  assert.deepEqual(rules(await checkRepositorySecretPolicy(root)), [
    "invalid-sops-dotenv",
  ]);
});

test("rejects SOPS dotenv files outside the approved secrets tree", async () => {
  const root = await repository({
    "deploy/customer/dev.sops.env": sopsDotenv(),
  });

  assert.deepEqual(rules(await checkRepositorySecretPolicy(root)), [
    "sops-outside-secrets",
  ]);
});

test("scans ASCII credentials even when a tracked file contains NUL bytes", async () => {
  const token = "gh" + "p_" + "A".repeat(36);
  const root = await repository({
    "binary-fixture.bin": Buffer.concat([
      Buffer.from([0, 1, 2]),
      Buffer.from(token),
      Buffer.from([0, 3]),
    ]),
  });

  assert.deepEqual(rules(await checkRepositorySecretPolicy(root)), [
    "github-token",
  ]);
});

test("detects a named Google Chat bridge token assignment", async () => {
  const root = await repository({
    "fixture.txt":
      ["CHAT", "BRIDGE", "TOKEN"].join("_") +
      "=" +
      "A".repeat(40) +
      "\n",
  });

  assert.deepEqual(rules(await checkRepositorySecretPolicy(root)), [
    "google-chat-bridge-token",
  ]);
});

test("rejects tracked plaintext dotenv files without printing values", async () => {
  const root = await repository({
    "deploy/customer/.env.production": "TOKEN=do-not-print-this-value\n",
  });
  const findings = await checkRepositorySecretPolicy(root);

  assert.deepEqual(rules(findings), ["tracked-plaintext-env"]);
  assert.equal(JSON.stringify(findings).includes("do-not-print"), false);
});

test("the CLI fails without echoing a rejected credential value", async () => {
  const root = await repository({
    ".env.local": "TOKEN=cli-do-not-print-this-value\n",
  });
  const script = join(
    import.meta.dirname,
    "..",
    "scripts",
    "check-secret-policy.mjs",
  );
  const result = spawnSync(process.execPath, [script, "--root", root], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.env\.local: tracked-plaintext-env/u);
  assert.equal(result.stderr.includes("cli-do-not-print-this-value"), false);
  assert.equal(result.stdout.includes("cli-do-not-print-this-value"), false);
});

test("requires the pilot suffix and SOPS metadata under secrets", async () => {
  const root = await repository({
    "secrets/customer/dev.env": "TOKEN=fixture\n",
    "secrets/admin/dev.sops.env": "TOKEN=fixture\n",
    "secrets/customer/dev.sops.json": '{"token":"plaintext-fixture"}\n',
  });
  const findings = await checkRepositorySecretPolicy(root);

  assert.deepEqual(
    new Set(rules(findings)),
    new Set(["unencrypted-secret-path", "invalid-sops-dotenv"]),
  );
});

test("rejects private age, PEM, GitHub, Linear, chat bridge, and AWS credentials", async () => {
  const sensitive = [
    ["AGE", "SECRET", "KEY"].join("-") + "-1FIXTUREONLY",
    "-----BEGIN " + "PRIVATE KEY-----",
    "gh" + "p_" + "A".repeat(36),
    "gh" + "s_" + "B".repeat(36),
    "github_" + "pat_" + "C".repeat(50),
    "lin_" + "api_" + "D".repeat(30),
    ["CHAT", "BRIDGE", "TOKEN"].join("_") + "=" + "E".repeat(40),
    "AK" + "IA" + "F".repeat(16),
  ].join("\n");
  const root = await repository({ "fixture.txt": sensitive });
  const findings = await checkRepositorySecretPolicy(root);

  assert.deepEqual(
    new Set(rules(findings)),
    new Set([
      "age-private-key",
      "pem-private-key",
      "github-token",
      "github-fine-grained-token",
      "linear-api-token",
      "google-chat-bridge-token",
      "aws-access-key",
    ]),
  );
  for (const secret of sensitive.split("\n")) {
    assert.equal(JSON.stringify(findings).includes(secret), false);
  }
});

test("refuses tracked symlinks instead of following their targets", async () => {
  const root = await repository({ "outside.txt": "safe fixture\n" });
  await symlink("outside.txt", join(root, "tracked-link.txt"));
  execFileSync("git", ["-C", root, "add", "--", "tracked-link.txt"], {
    stdio: "ignore",
  });

  const findings = await checkRepositorySecretPolicy(root);
  assert.deepEqual(rules(findings), ["tracked-symlink"]);
});

test("fails closed instead of silently skipping oversized tracked files", async () => {
  const root = await repository({
    "large-fixture.txt": "x".repeat(1024 * 1024 + 1),
  });
  const findings = await checkRepositorySecretPolicy(root);

  assert.deepEqual(rules(findings), ["oversized-tracked-file"]);
  assert.equal(JSON.stringify(findings).includes("x".repeat(100)), false);
});

test("the repository currently satisfies its own tracked-file policy", async () => {
  const root = join(import.meta.dirname, "..");
  assert.deepEqual(await checkRepositorySecretPolicy(root), []);
});
