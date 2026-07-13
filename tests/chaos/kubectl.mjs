import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const disruptions = new Map();

function targetConfig(name) {
  let contexts;
  try {
    contexts = JSON.parse(process.env.FIDUCIA_E2E_CHAOS_CONTEXTS ?? "{}");
  } catch (error) {
    throw new Error(`FIDUCIA_E2E_CHAOS_CONTEXTS must be JSON: ${error.message}`);
  }
  const context = contexts[name];
  if (typeof context !== "string" || context.trim() === "") {
    throw new Error(`no kubectl context mapped for chaos target ${name}`);
  }
  return {
    context,
    namespace: process.env.FIDUCIA_E2E_CHAOS_NAMESPACE || "fiducia",
    selector:
      process.env.FIDUCIA_E2E_CHAOS_SELECTOR || "app.kubernetes.io/name=fiducia-node"
  };
}

async function kubectl(config, args) {
  const { stdout } = await execFileAsync(
    process.env.FIDUCIA_E2E_KUBECTL || "kubectl",
    ["--context", config.context, "--namespace", config.namespace, ...args],
    { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }
  );
  return stdout;
}

async function statefulSets(config) {
  const output = await kubectl(config, [
    "get",
    "statefulsets",
    "--selector",
    config.selector,
    "--output",
    "json"
  ]);
  const value = JSON.parse(output);
  if (!Array.isArray(value.items)) {
    throw new Error("kubectl response omitted StatefulSet items");
  }
  return value.items.map((item) => ({
    name: item?.metadata?.name,
    replicas: Number.isInteger(item?.spec?.replicas) ? item.spec.replicas : 1
  }));
}

async function waitForNoPods(config) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const output = await kubectl(config, [
      "get",
      "pods",
      "--selector",
      config.selector,
      "--output",
      "json"
    ]);
    const value = JSON.parse(output);
    if (Array.isArray(value.items) && value.items.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`timed out waiting for ${config.context} node pods to terminate`);
}

export async function disruptCluster(name) {
  if (process.env.FIDUCIA_E2E_ALLOW_DISRUPTIVE !== "1") {
    throw new Error("disruptive chaos requires FIDUCIA_E2E_ALLOW_DISRUPTIVE=1");
  }
  if (disruptions.has(name)) throw new Error(`chaos target ${name} is already disrupted`);

  const config = targetConfig(name);
  const targets = await statefulSets(config);
  if (targets.length === 0 || targets.some((target) => !target.name)) {
    throw new Error(`no valid fiducia-node StatefulSets matched ${config.selector}`);
  }

  const scaled = [];
  try {
    for (const target of targets) {
      await kubectl(config, ["scale", `statefulset/${target.name}`, "--replicas=0"]);
      scaled.push(target);
    }
    disruptions.set(name, { config, targets });
    await waitForNoPods(config);
    return { disrupted: true, provider: "kubectl", context: config.context, targets };
  } catch (error) {
    for (const target of scaled.reverse()) {
      await kubectl(config, [
        "scale",
        `statefulset/${target.name}`,
        `--replicas=${target.replicas}`
      ]).catch(() => {});
    }
    throw error;
  }
}

export async function healCluster(name) {
  const disruption = disruptions.get(name);
  if (!disruption) throw new Error(`chaos target ${name} is not currently disrupted`);

  for (const target of disruption.targets) {
    await kubectl(disruption.config, [
      "scale",
      `statefulset/${target.name}`,
      `--replicas=${target.replicas}`
    ]);
  }
  disruptions.delete(name);
  return {
    healed: true,
    provider: "kubectl",
    context: disruption.config.context,
    targets: disruption.targets
  };
}
