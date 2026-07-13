// The acceptance test for "two completely separate web apps, both Supabase
// login through fiducia-auth":
//
//   - the ADMIN app (fiducia-admin) only ever admits operators whose Supabase
//     app_metadata carries an admin/operator role, via a server-side password
//     login that issues a host-only HttpOnly fiducia_admin_session cookie;
//   - the CUSTOMER plane (fiducia-backend BFF) admits any org-bearing Supabase
//     session presented as a Bearer token, and is org-scoped, not role-scoped;
//   - neither app's credential means anything to the other: a customer session
//     cannot enter the admin app, and the admin cookie carries no authority on
//     the customer API (which reads only Authorization: Bearer).
//
// Runs the REAL fiducia-auth + fiducia-admin + fiducia-backend against stub
// Supabase / stub KV / stub brain / scratch Postgres. Opt-in (heavy):
//   FIDUCIA_E2E_WEBAPPS=1 npm run test:webapps

import assert from "node:assert/strict";
import test from "node:test";

import {
  CUSTOMER,
  OPERATOR,
  ORGLESS,
  bootWebAppStack,
  parseSetCookies,
  webAppsSkipReason,
} from "../../src/webapps.mjs";

const skip = webAppsSkipReason();

function namedAttribute(html, name, attribute) {
  const tag = html.match(new RegExp(`<[^>]+name="${name}"[^>]*>`))?.[0];
  const value = tag?.match(new RegExp(`${attribute}="([^"]+)"`))?.[1];
  assert.ok(value, `${name} ${attribute} must be present in the rendered page`);
  return value;
}

test("web-app login and separation", { skip: skip ?? false, concurrency: false, timeout: 900000 }, async (t) => {
  const stack = await bootWebAppStack();
  t.after(() => stack.stop());
  const { admin, backend, grant } = stack;

  // Login CSRF is a double-submit flow: GET mints a short-lived HttpOnly nonce
  // cookie and renders its HMAC-bound token. Exercise that real browser contract
  // rather than posting credentials directly around the protection.
  const loginForm = async (user, password = user.password) => {
    const page = await fetch(`${admin.url}/login`);
    assert.equal(page.status, 200);
    const csrfToken = namedAttribute(await page.text(), "csrf_token", "value");
    const csrfCookie = parseSetCookies(page).fiducia_admin_login_csrf;
    assert.ok(csrfCookie?.value, "login page must mint its CSRF nonce cookie");

    return fetch(`${admin.url}/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `fiducia_admin_login_csrf=${csrfCookie.value}`,
        origin: admin.url,
      },
      body: new URLSearchParams({ csrf_token: csrfToken, email: user.email, password }),
    });
  };

  let operatorCookie;
  let operatorCsrf;

  await t.test("signed-out admin dashboard redirects to /login", async () => {
    const response = await fetch(admin.url, { redirect: "manual" });
    assert.equal(response.status, 303);
    assert.match(response.headers.get("location") ?? "", /\/login$/);
  });

  await t.test("operator password login issues a hardened admin session cookie", async () => {
    const response = await loginForm(OPERATOR);
    assert.equal(response.status, 303, await response.text());
    assert.equal(response.headers.get("location"), "/");
    const cookies = parseSetCookies(response);
    const session = cookies.fiducia_admin_session;
    assert.ok(session?.value, "fiducia_admin_session cookie must be set");
    assert.ok(session.attributes.has("httponly"), session.raw);
    assert.ok(session.attributes.has("samesite=strict"), session.raw);
    operatorCookie = `fiducia_admin_session=${session.value}`;

    const dashboard = await fetch(admin.url, { headers: { cookie: operatorCookie } });
    assert.equal(dashboard.status, 200);
    const dashboardHtml = await dashboard.text();
    assert.match(dashboardHtml, /operator|Dashboard/i);
    operatorCsrf = namedAttribute(dashboardHtml, "fiducia-admin-csrf", "content");
  });

  await t.test("customer credentials are valid Supabase logins but CANNOT enter the admin app", async () => {
    const response = await loginForm(CUSTOMER);
    assert.equal(response.status, 403, "role gate must reject non-operators at login");
    assert.equal(parseSetCookies(response).fiducia_admin_session, undefined, "no session cookie for non-operators");

    const bearer = await fetch(admin.url, {
      headers: { authorization: `Bearer ${await grant(CUSTOMER)}` },
    });
    assert.equal(bearer.status, 403, "a raw customer Supabase session must not open admin pages");
  });

  await t.test("wrong password never issues a cookie", async () => {
    const response = await loginForm(OPERATOR, "not-the-password");
    assert.notEqual(response.status, 303);
    assert.equal(parseSetCookies(response).fiducia_admin_session, undefined);
  });

  await t.test("admin sync API is role-gated with JSON errors", async () => {
    const write = (headers = {}) =>
      fetch(`${admin.url}/api/admin/sync/infra_operations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ id: "op-e2e", op: "upsert" }),
      });

    const anonymous = await write();
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error, "unauthenticated");

    const customer = await write({ authorization: `Bearer ${await grant(CUSTOMER)}` });
    assert.equal(customer.status, 403);
    assert.equal((await customer.json()).error, "forbidden");
  });

  await t.test("logout clears the admin session cookie", async () => {
    const response = await fetch(`${admin.url}/logout`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: operatorCookie,
        origin: admin.url,
      },
      body: new URLSearchParams({ csrf_token: operatorCsrf }),
    });
    assert.equal(response.status, 303);
    const cleared = parseSetCookies(response).fiducia_admin_session;
    assert.equal(cleared?.value ?? "", "");
    assert.ok(cleared.attributes.has("max-age=0"), cleared.raw);
  });

  await t.test("customer API accepts an org-bearing Supabase session via Bearer", async () => {
    const response = await fetch(`${backend.url}/api/customer/api-keys`, {
      headers: { authorization: `Bearer ${await grant(CUSTOMER)}` },
    });
    assert.equal(response.status, 200, await response.text());
  });

  await t.test("customer API fails closed: no bearer, admin cookie, org-less signup, garbage", async () => {
    const bare = await fetch(`${backend.url}/api/customer/api-keys`);
    assert.equal(bare.status, 401);

    // The admin app's cookie is meaningless on the customer plane — the BFF
    // reads only Authorization: Bearer.
    const withAdminCookie = await fetch(`${backend.url}/api/customer/api-keys`, {
      headers: { cookie: operatorCookie ?? "fiducia_admin_session=whatever" },
    });
    assert.equal(withAdminCookie.status, 401);

    const orgless = await fetch(`${backend.url}/api/customer/api-keys`, {
      headers: { authorization: `Bearer ${await grant(ORGLESS)}` },
    });
    assert.equal(orgless.status, 403, "a Supabase user with no app_metadata orgs has no customer-plane access");

    const garbage = await fetch(`${backend.url}/api/customer/api-keys`, {
      headers: { authorization: "Bearer not-a-jwt" },
    });
    assert.equal(garbage.status, 401);
  });

  await t.test("one identity plane, two authorization models (org-scoped data vs role-scoped admin)", async () => {
    // The operator is a normal Supabase user with orgs, so the customer plane
    // serves them for THEIR org — separation is authorization, not identity.
    const response = await fetch(`${backend.url}/api/customer/api-keys`, {
      headers: { authorization: `Bearer ${await grant(OPERATOR)}` },
    });
    assert.equal(response.status, 200);
  });
});
