import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const e2eRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspace = path.resolve(process.env.FIDUCIA_UPSTREAM_ROOT ?? path.dirname(e2eRoot));
const lock = JSON.parse(
  await readFile(path.join(e2eRoot, "contracts/upstream-lock.json"), "utf8"),
);

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed in ${cwd}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout.trim();
}

assert.equal(lock.schema_version, 1, "unsupported upstream-lock schema version");
const checkouts = {};
for (const [name, pinned] of Object.entries(lock.repositories)) {
  assert.match(pinned.repository, /^fiducia-cloud\/[a-z0-9.-]+$/);
  assert.match(pinned.sha, /^[0-9a-f]{40}$/);
  const checkout = path.join(workspace, name);
  const actual = run("git", ["rev-parse", "HEAD"], checkout);
  assert.equal(actual, pinned.sha, `${name} checkout does not match upstream-lock.json`);
  checkouts[name] = checkout;
}

const interfacesRoot = checkouts["fiducia-interfaces"];
const clientsRoot = checkouts["fiducia-clients"];
const syncRoot = checkouts["fiducia-sync"];

const canonicalSyncSchema = await readFile(
  path.join(interfacesRoot, "schema/sync.schema.json"),
);
const vendoredSyncSchema = await readFile(path.join(syncRoot, "schema/sync.schema.json"));
assert.deepEqual(
  vendoredSyncSchema,
  canonicalSyncSchema,
  "fiducia-sync schema/sync.schema.json drifted from fiducia-interfaces",
);

run("node", ["sdk/scripts/embed-sync-schema.mjs", "--check"], syncRoot);
run("python3", ["generate.py", "--check"], clientsRoot);
run("npm", ["run", "typecheck"], path.join(clientsRoot, "clients/ts"));

const tsconfig = JSON.parse(
  await readFile(path.join(clientsRoot, "clients/ts/tsconfig.json"), "utf8"),
);
assert.deepEqual(
  tsconfig.compilerOptions?.paths?.["@fiducia/interfaces/typescript"],
  ["../../../fiducia-interfaces/generated/typescript/index.ts"],
  "TypeScript client no longer compiles against the pinned interfaces checkout",
);
assert.deepEqual(
  tsconfig.compilerOptions?.paths?.["@fiducia/sync"],
  ["../../../fiducia-sync/sdk/src/index.d.ts"],
  "TypeScript client no longer compiles against the pinned sync checkout",
);
assert.ok(
  tsconfig.files?.includes("sync-compatibility.ts"),
  "TypeScript client dropped its sync compatibility assignment",
);

const interfacePackage = JSON.parse(
  await readFile(path.join(interfacesRoot, "package.json"), "utf8"),
);
assert.equal(
  interfacePackage.exports?.["./schema/sync"],
  "./schema/sync.schema.json",
  "canonical sync schema package export changed",
);
const syncPackage = JSON.parse(await readFile(path.join(syncRoot, "sdk/package.json"), "utf8"));
assert.equal(
  syncPackage.exports?.["."].types,
  "./src/index.d.ts",
  "@fiducia/sync root type export changed",
);

const generatedClient = await readFile(
  path.join(clientsRoot, "clients/ts/fiducia.ts"),
  "utf8",
);
const e2eClient = await readFile(path.join(e2eRoot, "src/client.mjs"), "utf8");
for (const method of [
  "kvList",
  "kvWatch",
  "secretPut",
  "secretReveal",
  "secretDelete",
  "secretList",
]) {
  const methodPattern = new RegExp(`\\b${method}\\s*\\(`);
  assert.match(generatedClient, methodPattern, `fiducia-clients is missing ${method}`);
  assert.match(e2eClient, methodPattern, `fiducia-e2e mirror is missing ${method}`);
}
for (const source of [generatedClient, e2eClient]) {
  assert.match(source, /secret\//, "secrets client lost its reserved key prefix");
  assert.match(source, /plaintext\s*:\s*false/, "secret writes no longer force encrypted-at-rest KV");
}

console.log(
  "upstream contract chain verified: "
    + "interfaces schema -> sync embed -> client type compatibility -> e2e secrets mirror",
);
