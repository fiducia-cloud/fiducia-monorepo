import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { checkRepositorySecretPolicy } from "../scripts/check-secret-policy.mjs";

async function repository(files) {
  const root = await mkdtemp(join(tmpdir(), "fiducia-secret-policy-test."));
  execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { mode: 0o600 });
  }
  execFileSync("git", ["-C", root, "add", "--", "."], { stdio: "ignore" });
  return root;
}

function rules(findings) {
  return findings.map(({ rule }) => rule);
}

test("accepts placeholders and structurally valid SOPS dotenv files", async () => {
  const root = await repository({
    ".env.example": "DATABASE_URL=\nTOKEN=replace-me\n",
    "secrets/README.md": "No plaintext values.\n",
    "secrets/customer/dev.sops.env": [
      "TOKEN=ENC[AES256_GCM,data:fixture,iv:fixture,tag:fixture,type:str]",
      "sops_age__list_0__map_enc=-----BEGIN AGE ENCRYPTED FILE-----\\nfixture\\n-----END AGE ENCRYPTED FILE-----\\n",
      "sops_age__list_0__map_recipient=age1fixturecustomerrecipient000000000000000000000000000000",
      "sops_mac=ENC[AES256_GCM,data:fixture,iv:fixture,tag:fixture,type:str]",
      "sops_version=3.13.3",
      "",
    ].join("\n"),
  });

  assert.deepEqual(await checkRepositorySecretPolicy(root), []);
});

test("rejects tracked plaintext dotenv files without printing values", async () => {
  const root = await repository({ "deploy/customer/.env.production": "TOKEN=do-not-print-this-value\n" });
  const findings = await checkRepositorySecretPolicy(root);

  assert.deepEqual(rules(findings), ["tracked-plaintext-env"]);
  assert.equal(JSON.stringify(findings).includes("do-not-print"), false);
});

test("the CLI fails without echoing a rejected credential value", async () => {
  const root = await repository({ ".env.local": "TOKEN=cli-do-not-print-this-value\n" });
  const script = join(import.meta.dirname, "..", "scripts", "check-secret-policy.mjs");
  const result = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.env\.local: tracked-plaintext-env/u);
  assert.equal(result.stderr.includes("cli-do-not-print-this-value"), false);
  assert.equal(result.stdout.includes("cli-do-not-print-this-value"), false);
});

test("requires approved encrypted suffixes and SOPS metadata under secrets", async () => {
  const root = await repository({
    "secrets/customer/dev.env": "TOKEN=fixture\n",
    "secrets/admin/dev.sops.env": "TOKEN=fixture\n",
  });
  const findings = await checkRepositorySecretPolicy(root);

  assert.deepEqual(new Set(rules(findings)), new Set(["unencrypted-secret-path", "invalid-sops-dotenv"]));
});

test("rejects private age, PEM, GitHub, Linear, and AWS credentials", async () => {
  const sensitive = [
    ["AGE", "SECRET", "KEY"].join("-") + "-1FIXTUREONLY",
    "-----BEGIN " + "PRIVATE KEY-----",
    "gh" + "p_" + "A".repeat(36),
    "github_" + "pat_" + "B".repeat(50),
    "lin_" + "api_" + "C".repeat(30),
    "AK" + "IA" + "D".repeat(16),
  ].join("\n");
  const root = await repository({ "fixture.txt": sensitive });
  const findings = await checkRepositorySecretPolicy(root);

  assert.deepEqual(
    new Set(rules(findings)),
    new Set([
      "age-private-key",
      "pem-private-key",
      "github-classic-token",
      "github-fine-grained-token",
      "linear-api-token",
      "aws-access-key",
    ]),
  );
  for (const secret of sensitive.split("\n")) assert.equal(JSON.stringify(findings).includes(secret), false);
});

test("refuses tracked symlinks instead of following their targets", async () => {
  const root = await repository({ "outside.txt": "safe fixture\n" });
  await symlink("outside.txt", join(root, "tracked-link.txt"));
  execFileSync("git", ["-C", root, "add", "--", "tracked-link.txt"], { stdio: "ignore" });

  const findings = await checkRepositorySecretPolicy(root);
  assert.deepEqual(rules(findings), ["tracked-symlink"]);
});

test("the repository currently satisfies its own tracked-file policy", async () => {
  const root = join(import.meta.dirname, "..");
  assert.deepEqual(await checkRepositorySecretPolicy(root), []);
});
