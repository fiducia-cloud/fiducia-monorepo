// Scratch: boot the coordination stack, do one write through the LB, dump logs.
import { bootCoordinationStack, INTERNAL_SECRET } from "../src/coordination.mjs";

const stack = await bootCoordinationStack({ shardCount: 4, compactThreshold: 16 });
try {
  const res = await fetch(`${stack.lbUrl}/v1/kv?key=debug/one`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-fiducia-edge-auth": INTERNAL_SECRET,
      "x-fiducia-org-id": "e2e-system",
      "x-fiducia-scopes": "*",
    },
    body: JSON.stringify({ value: "on" }),
  });
  console.log("HTTP", res.status);
  console.log(await res.text());
} finally {
  console.log("---- LB LOG ----");
  console.log(stack.logsOf?.("lb") ?? "(no lb logs handle)");
  await stack.stop();
}
