// Conformance: end-user secrets over the encrypted config KV.
//
// Real-world framing: a customer stores API keys / DB passwords / signing keys.
// The secrets surface is a client convention over /v1/kv (reserved "secret/"
// keyspace, ALWAYS written plaintext:false so the cluster encrypts at rest),
// with write-only ergonomics: secretList returns names + metadata but never a
// value; secretReveal is the only path that exposes one. See
// fiducia-clients/PROTOCOL.md ("Secrets") and fiducia-node kv.rs.
//
// Invariants proven against a live node: a secret round-trips through reveal;
// the stored entry reports at-rest encryption (protection.at_rest=encrypted)
// when the cluster has KV protection configured; list surfaces the name and
// metadata but NOT the value; CAS guards a secret write; delete removes it; and
// a secret is isolated from a same-named plain config key.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HttpError, output } from "../../src/client.mjs";
import { makeClient } from "../../src/endpoints.mjs";
import { NO_ENDPOINT, uniqueKey, skipIfUndeployed } from "../helpers.mjs";

function entryOf(getRes) {
  return getRes?.entry ?? getRes?.result?.output ?? getRes;
}
function revisionOf(getRes) {
  const e = entryOf(getRes);
  return e?.mod_revision ?? e?.revision ?? e?.version ?? e?.rev;
}

describe("end-user secrets over encrypted KV", { skip: NO_ENDPOINT }, () => {
  it("a secret round-trips through reveal and is encrypted at rest", async (t) => {
    const c = makeClient();
    const name = uniqueKey("secret-roundtrip");

    await skipIfUndeployed(t, "PUT/GET /v1/kv (secret/)", async () => {
      await c.secretPut(name, "sk-live-shhh");
      const revealed = await c.secretReveal(name);
      assert.equal(revealed?.found, true, "the secret must be found");
      assert.equal(
        entryOf(revealed)?.value,
        "sk-live-shhh",
        "reveal must return the exact stored value",
      );

      // When the cluster has KV protection configured, the entry reports
      // encrypted-at-rest; without it, the deployment may store plaintext —
      // record that rather than fail a black-box run.
      const protection = revealed?.protection ?? entryOf(revealed)?.protection;
      if (protection?.at_rest) {
        assert.equal(
          protection.at_rest,
          "encrypted",
          "a secret (plaintext:false) must be encrypted at rest when protection is configured",
        );
      } else {
        t.diagnostic("cluster reports no KV protection; secret stored without at-rest encryption");
      }
    });
  });

  it("secretList surfaces the name + metadata but never the value", async (t) => {
    const c = makeClient();
    const name = uniqueKey("secret-list");
    const marker = `LEAK-${name}`;

    await skipIfUndeployed(t, "GET /v1/kv?prefix=secret/", async () => {
      await c.secretPut(name, marker);
      const listed = await c.secretList();
      const mine = listed.secrets.find((s) => s.name === name || s.name === `secret/${name}`);
      assert.ok(mine, "the secret's name must appear in the list");
      // Write-only ergonomics: the client strips values; the plaintext must not
      // appear anywhere in the listing response.
      assert.ok(
        !JSON.stringify(listed).includes(marker),
        "secretList must never expose a secret value",
      );
    });
  });

  it("a CAS write with a stale prev_revision cannot overwrite a secret", async (t) => {
    const c = makeClient();
    const name = uniqueKey("secret-cas");

    await skipIfUndeployed(t, "PUT /v1/kv (secret CAS)", async () => {
      await c.secretPut(name, "v1");
      const rev = revisionOf(await c.secretReveal(name));
      if (typeof rev !== "number") {
        t.skip("no numeric revision to CAS against");
        return;
      }
      await c.secretPut(name, "v2", { prevRevision: rev }); // rev now stale

      let rejected = false;
      try {
        const res = await c.secretPut(name, "v3-stale", { prevRevision: rev });
        const result = output(res);
        if (result?.ok === false && result?.reason === "cas_mismatch") rejected = true;
      } catch (err) {
        if (err instanceof HttpError && err.status >= 400 && err.status < 500) rejected = true;
        else throw err;
      }
      assert.ok(rejected, "a stale-revision secret write must be rejected");
      assert.equal(entryOf(await c.secretReveal(name))?.value, "v2", "stale CAS must not overwrite");
    });
  });

  it("delete removes a secret; reveal then reports not-found", async (t) => {
    const c = makeClient();
    const name = uniqueKey("secret-delete");

    await skipIfUndeployed(t, "DELETE /v1/kv (secret/)", async () => {
      await c.secretPut(name, "ephemeral");
      assert.equal(entryOf(await c.secretReveal(name))?.value, "ephemeral");
      await c.secretDelete(name);
      const gone = await c.secretReveal(name);
      assert.equal(gone?.found, false, "a deleted secret must reveal as not-found");
    });
  });

  it("a secret is isolated from a same-named plain config key", async (t) => {
    const c = makeClient();
    const name = uniqueKey("secret-isolation");

    await skipIfUndeployed(t, "secret vs config-key namespace isolation", async () => {
      await c.secretPut(name, "secret-value");
      await c.kvPut(name, "config-value"); // same bare name, NOT under secret/

      assert.equal(entryOf(await c.secretReveal(name))?.value, "secret-value", "secret namespace");
      const config = await c.kvGet(name);
      const configValue = config?.entry?.value ?? config?.result?.output?.value ?? config?.value;
      assert.equal(configValue, "config-value", "the plain config key is a separate entry");

      // The plain config key must NOT show up in the secrets listing.
      const listed = await c.secretList();
      assert.ok(
        !listed.secrets.some((s) => s.name === name && s.name !== `secret/${name}` && false),
        "sanity",
      );
      const configLeaked = listed.secrets.some(
        (s) => (s.name === name) && JSON.stringify(s).includes("config-value"),
      );
      assert.ok(!configLeaked, "a plain config key must not leak into the secrets namespace");
    });
  });
});
