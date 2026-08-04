#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_SCANNED_BYTES = 1024 * 1024;
const APPROVED_SOPS_SUFFIX = /\.sops\.env$/u;
const SECRET_DOCUMENT = /^secrets\/(?:README\.md|\.gitkeep)$/u;

const secretPatterns = [
  {
    rule: "age-private-key",
    pattern: new RegExp(["AGE", "SECRET", "KEY"].join("-") + "-"),
  },
  {
    rule: "pem-private-key",
    pattern: new RegExp("-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
  },
  {
    rule: "github-classic-token",
    pattern: new RegExp("gh" + "p_[A-Za-z0-9]{30,}"),
  },
  {
    rule: "github-fine-grained-token",
    pattern: new RegExp("github_" + "pat_[A-Za-z0-9_]{40,}"),
  },
  {
    rule: "linear-api-token",
    pattern: new RegExp("lin_" + "api_[A-Za-z0-9]{20,}"),
  },
  {
    rule: "aws-access-key",
    pattern: new RegExp("AK" + "IA[0-9A-Z]{16}"),
  },
];

function normalizePath(path) {
  return path.split(sep).join("/").replace(/^\.\//u, "");
}

function finding(path, rule, detail) {
  return { path, rule, detail };
}

function isPlaintextEnv(path) {
  const name = basename(path);
  if (name === ".env.example" || name === ".env.sample") return false;
  if (APPROVED_SOPS_SUFFIX.test(name)) return false;
  return name === ".env" || name.startsWith(".env.");
}

function hasSopsDotenvMetadata(content) {
  return [
    "sops_age__list_0__map_enc=",
    "sops_age__list_0__map_recipient=",
    "sops_mac=ENC[",
    "sops_version=",
  ].every((marker) => content.includes(marker));
}

function trackedFiles(root) {
  const output = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.split("\0").filter(Boolean).map(normalizePath).sort();
}

export async function checkRepositorySecretPolicy(rootInput) {
  const root = resolve(rootInput);
  const findings = [];

  for (const trackedPath of trackedFiles(root)) {
    if (isPlaintextEnv(trackedPath)) {
      findings.push(
        finding(
          trackedPath,
          "tracked-plaintext-env",
          "plaintext dotenv files must not be tracked",
        ),
      );
    }

    if (
      trackedPath.startsWith("secrets/") &&
      !SECRET_DOCUMENT.test(trackedPath) &&
      !APPROVED_SOPS_SUFFIX.test(trackedPath)
    ) {
      findings.push(
        finding(
          trackedPath,
          "unencrypted-secret-path",
          "the pilot permits only validated .sops.env files under secrets/",
        ),
      );
    }

    const absolutePath = resolve(root, trackedPath);
    const rel = relative(root, absolutePath);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      findings.push(
        finding(
          trackedPath,
          "path-escape",
          "tracked path resolves outside the repository",
        ),
      );
      continue;
    }

    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      findings.push(
        finding(
          trackedPath,
          "tracked-symlink",
          "secret scanning refuses tracked symlinks",
        ),
      );
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_SCANNED_BYTES) {
      findings.push(
        finding(
          trackedPath,
          "oversized-tracked-file",
          `tracked files larger than ${MAX_SCANNED_BYTES} bytes require explicit review or removal`,
        ),
      );
      continue;
    }

    const bytes = await readFile(absolutePath);
    if (bytes.includes(0)) continue;
    const content = bytes.toString("utf8");

    if (
      APPROVED_SOPS_SUFFIX.test(trackedPath) &&
      !hasSopsDotenvMetadata(content)
    ) {
      findings.push(
        finding(
          trackedPath,
          "invalid-sops-dotenv",
          "encrypted dotenv file is missing required SOPS metadata",
        ),
      );
    }

    for (const { rule, pattern } of secretPatterns) {
      if (pattern.test(content)) {
        findings.push(
          finding(
            trackedPath,
            rule,
            "sensitive material must not be tracked",
          ),
        );
      }
    }
  }

  return findings;
}

function parseRoot(argv) {
  const index = argv.indexOf("--root");
  if (index === -1) return dirname(dirname(fileURLToPath(import.meta.url)));
  if (!argv[index + 1]) throw new Error("--root requires a path");
  return resolve(argv[index + 1]);
}

async function main() {
  const root = parseRoot(process.argv.slice(2));
  const findings = await checkRepositorySecretPolicy(root);
  if (findings.length === 0) {
    process.stdout.write(
      "secret policy OK: tracked files contain no prohibited plaintext material\n",
    );
    return;
  }

  for (const item of findings) {
    process.stderr.write(`${item.path}: ${item.rule}: ${item.detail}\n`);
  }
  process.stderr.write(
    `secret policy FAIL: ${findings.length} finding(s); values were not printed\n`,
  );
  process.exitCode = 1;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  await main();
}
