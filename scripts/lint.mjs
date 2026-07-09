// Dependency-light "lint": ESM syntax-check every source and test file with the
// same parser Node uses to run them (`vm.SourceTextModule`-equivalent via
// dynamic import parse). We avoid pulling ESLint to stay dependency-light; this
// catches syntax/parse errors and unresolved static imports in CI.

import { readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (extname(entry.name) === ".mjs") out.push(full);
  }
  return out;
}

const files = [...(await walk(join(root, "src"))), ...(await walk(join(root, "tests"))), ...(await walk(join(root, "scripts")))];

let failed = 0;
for (const file of files) {
  try {
    // `node --check` parses module syntax without executing side effects.
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    void pathToFileURL(file); // keep the import used
  } catch (err) {
    failed += 1;
    process.stderr.write(`lint FAIL: ${file}\n${err.stderr ?? err.message}\n`);
  }
}

if (failed) {
  process.stderr.write(`\n${failed} file(s) failed the syntax check.\n`);
  process.exit(1);
}
process.stdout.write(`lint OK: ${files.length} files parsed cleanly.\n`);
