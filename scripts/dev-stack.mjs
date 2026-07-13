#!/usr/bin/env node
// Run the whole web/auth tier locally with ZERO cloud dependencies:
// stub Supabase + stub Fiducia-KV + stub brain + scratch Postgres, and the
// real fiducia-auth / fiducia-admin / fiducia-backend from sibling checkouts.
//
//   node scripts/dev-stack.mjs
//
// Prints service URLs and seeded credentials, then runs until Ctrl-C.
// FIDUCIA_REPOS_ROOT overrides where sibling repos are found.

import {
  CUSTOMER,
  OPERATOR,
  ORGLESS,
  bootWebAppStack,
  webAppsSkipReason,
} from "../src/webapps.mjs";

process.env.FIDUCIA_E2E_WEBAPPS = "1";
const reason = webAppsSkipReason();
if (reason) {
  console.error(`cannot start: ${reason}`);
  process.exit(1);
}

console.log("booting stub Supabase/KV/brain + scratch Postgres + real auth/admin/backend …");
const stack = await bootWebAppStack();

console.log(`
fiducia dev stack is up:

  customer portal (fiducia-backend BFF)  ${stack.backend.url}/app
  admin dashboard  (fiducia-admin)       ${stack.admin.url}/login
  auth server      (fiducia-auth)        ${stack.auth.url}/healthz
  stub Supabase                          ${stack.supabase.url}
  stub Fiducia KV                        ${stack.kv.url}
  scratch Postgres                       127.0.0.1:${stack.postgres.port} (dbs: fiducia_admin, fiducia_customer)

seeded Supabase accounts (password grant):

  operator  ${OPERATOR.email} / ${OPERATOR.password}   roles=[admin] orgs=[org_infra]  (also enabled in the admin operators registry)
  customer  ${CUSTOMER.email} / ${CUSTOMER.password}   orgs=[${CUSTOMER.app_metadata.orgs[0]}]
  org-less  ${ORGLESS.email} / ${ORGLESS.password}   (valid login, no customer-plane access)

Ctrl-C to stop everything.`);

const shutdown = async () => {
  console.log("\nstopping …");
  await stack.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
