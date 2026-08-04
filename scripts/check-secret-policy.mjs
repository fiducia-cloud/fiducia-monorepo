#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_SCANNED_BYTES = 1024 * 1024;
const SOPS_SUFFIX = /\.sops\.env$/u;
const APPROVED_SOPS_PATH = /^secrets\/.+\.sops\.env$/u;
const SECRET_DOCUMENT = /^secrets\/(?:README\.md|\.gitkeep)$/u;
const DOTENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SOPS_ENCRYPTED_VALUE = /^ENC\[[^\r\n]+\]$/u;
const SOPS_AGE_FIELD = /^sops_age__list_(\d+)__map_(enc|recipient)$/u;
const SOPS_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

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
    rule: "github-token",
    pattern: new RegExp("gh" + "[pousr]_[A-Za-z0-9]{30,}"),
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
    rule: "google-chat-bridge-token",
    pattern: new RegExp(
      ["CHAT", "BRIDGE", "TOKEN"].join("_") +
        String.raw`[ \t]*=[ \t]*["']?[A-Za-z0-9_-]{30,}`,
    ),
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
  if (SOPS_SUFFIX.test(name)) return false;
  return name === ".env" || name.startsWith(".env.");
}

function validAgeEnvelope(value) {
  return (
    value.startsWith("-----BEGIN AGE ENCRYPTED FILE-----\\n") &&
    value.includes("\\n-----END AGE ENCRYPTED FILE-----")
  );
}

export function validateSopsDotenv(content) {
  if (typeof content !== "string" || content.includes("\0")) return false;

  const entries = new Map();
  for (const line of content.split(/\r?\n/u)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) return false;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!DOTENV_KEY.test(key) || entries.has(key)) return false;
    entries.set(key, value);
  }

  let encryptedValues = 0;
  const age = new Map();
  for (const [key, value] of entries) {
    const ageField = key.match(SOPS_AGE_FIELD);
    if (ageField) {
      const [, index, field] = ageField;
      const pair = age.get(index) ?? {};
      pair[field] = value;
      age.set(index, pair);
      continue;
    }

    if (!key.startsWith("sops_")) {
      encryptedValues += 1;
      if (!SOPS_ENCRYPTED_VALUE.test(value)) return false;
      continue;
    }

    switch (key) {
      case "sops_mac":
        if (!SOPS_ENCRYPTED_VALUE.test(value)) return false;
        break;
      case "sops_version":
        if (!SOPS_VERSION.test(value)) return false;
        break;
      case "sops_lastmodified":
        if (!Number.isFinite(Date.parse(value)) || !value.endsWith("Z")) {
          return false;
        }
        break;
      case "sops_unencrypted_suffix":
        if (value !== "_unencrypted") return false;
        break;
      case "sops_encrypted_suffix":
        if (value !== "_encrypted") return false;
        break;
      case "sops_mac_only_encrypted":
        if (value !== "true" && value !== "false") return false;
        break;
      default:
        return false;
    }
  }

  if (
    encryptedValues === 0 ||
    !entries.has("sops_mac") ||
    !entries.has("sops_version") ||
    age.size === 0
  ) {
    return false;
  }

  for (const pair of age.values()) {
    if (
      !/^age1[0-9a-z]{20,}$/u.test(pair.recipient ?? "") ||
      !validAgeEnvelope(pair.enc ?? "")
    ) {
      return false;
    }
  }
  return true;
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
    if (CONTROL_CHARACTER.test(trackedPath) || trackedPath.includes("\ufffd")) {
      findings.push(
        finding(
          trackedPath,
          "unsafe-tracked-path",
          "tracked paths must not contain control or undecodable characters",
        ),
      );
      continue;
    }

    if (isPlaintextEnv(trackedPath)) {
      findings.push(
        finding(
          trackedPath,
          "tracked-plaintext-env",
          "plaintext dotenv files must not be tracked",
        ),
      );
    }

    if (SOPS_SUFFIX.test(trackedPath) && !APPROVED_SOPS_PATH.test(trackedPath)) {
      findings.push(
        finding(
          trackedPath,
          "sops-outside-secrets",
          "encrypted dotenv files are allowed only below secrets/",
        ),
      );
    }

    if (
      trackedPath.startsWith("secrets/") &&
      !SECRET_DOCUMENT.test(trackedPath) &&
      !APPROVED_SOPS_PATH.test(trackedPath)
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
    const content = bytes.toString("utf8");

    if (SOPS_SUFFIX.test(trackedPath) && !validateSopsDotenv(content)) {
      findings.push(
        finding(
          trackedPath,
          "invalid-sops-dotenv",
          "encrypted dotenv file must contain only encrypted data and valid age/SOPS metadata",
        ),
      );
    }

    const searchable = bytes.toString("latin1");
    for (const { rule, pattern } of secretPatterns) {
      if (pattern.test(searchable)) {
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

function displayPath(path) {
  return path.replace(
    /[\u0000-\u001f\u007f]/gu,
    (character) =>
      `\\x${character.codePointAt(0).toString(16).padStart(2, "0")}`,
  );
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
    process.stderr.write(
      `${displayPath(item.path)}: ${item.rule}: ${item.detail}\n`,
    );
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
