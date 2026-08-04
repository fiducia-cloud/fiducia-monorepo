import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

export const contractEnabled = process.env.E2E_BROWSER_CONTRACT === "1";

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

export const harnessHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>E2E Harness Contract</title>
</head>
<body>
  <main>
    <h1>Browser harness contract</h1>
    <output id="state" aria-live="polite">booting</output>
    <button id="increment" type="button">Increment</button>
    <output id="count">0</output>
  </main>
  <script src="/app.js" defer></script>
</body>
</html>`;

const script = `
(async () => {
  const state = document.querySelector('#state');
  const count = document.querySelector('#count');
  const button = document.querySelector('#increment');
  const session = await fetch('/api/session', { cache: 'no-store' }).then((response) => {
    if (!response.ok) throw new Error('session request failed: ' + response.status);
    return response.json();
  });
  if (!session.cookieSeen) throw new Error('HttpOnly session cookie was not returned to the server');
  state.textContent = 'ready';
  button.addEventListener('click', () => {
    count.textContent = String(Number(count.textContent) + 1);
  });
})().catch((error) => {
  document.querySelector('#state').textContent = 'error';
  console.error(error);
});
`;

function writeResponse(request, response, statusCode, headers, body = "") {
  response.statusCode = statusCode;
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  if (request.method === "HEAD") response.end();
  else response.end(body);
}

export async function startHarnessServer() {
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");

    if (!["GET", "HEAD"].includes(request.method ?? "")) {
      writeResponse(
        request,
        response,
        405,
        {
          Allow: "GET, HEAD",
          "Content-Type": "text/plain; charset=utf-8",
        },
        "method not allowed",
      );
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      writeResponse(
        request,
        response,
        400,
        { "Content-Type": "text/plain; charset=utf-8" },
        "bad request",
      );
      return;
    }

    if (pathname === "/") {
      writeResponse(
        request,
        response,
        200,
        {
          "Content-Security-Policy": CSP,
          "Content-Type": "text/html; charset=utf-8",
          "Set-Cookie": "e2e_session=contract; HttpOnly; SameSite=Strict; Path=/",
        },
        harnessHtml,
      );
      return;
    }

    if (pathname === "/app.js") {
      writeResponse(
        request,
        response,
        200,
        { "Content-Type": "text/javascript; charset=utf-8" },
        script,
      );
      return;
    }

    if (pathname === "/api/session") {
      writeResponse(
        request,
        response,
        200,
        { "Content-Type": "application/json; charset=utf-8" },
        JSON.stringify({
          cookieSeen: String(request.headers.cookie ?? "").includes(
            "e2e_session=contract",
          ),
          requestId: "browser-harness-contract",
        }),
      );
      return;
    }

    if (pathname === "/favicon.ico") {
      writeResponse(request, response, 204, {});
      return;
    }

    if (pathname === "/healthz") {
      writeResponse(
        request,
        response,
        200,
        { "Content-Type": "text/plain; charset=utf-8" },
        "ok",
      );
      return;
    }

    writeResponse(
      request,
      response,
      404,
      { "Content-Type": "text/plain; charset=utf-8" },
      "not found",
    );
  });

  server.keepAliveTimeout = 1_000;
  server.headersTimeout = 2_000;
  server.requestTimeout = 5_000;

  await new Promise((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  assert(
    address && typeof address === "object",
    "harness server did not expose a TCP address",
  );

  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      if (!server.listening) return;
      const forceClose = setTimeout(
        () => server.closeAllConnections?.(),
        1_000,
      );
      forceClose.unref();
      server.closeIdleConnections?.();
      try {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      } finally {
        clearTimeout(forceClose);
      }
    },
  };
}

export async function artifactDirectory(framework) {
  const directory = path.join(process.cwd(), "artifacts", framework);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export async function artifactPath(framework, name) {
  return path.join(await artifactDirectory(framework), name);
}

export async function writeArtifact(
  framework,
  name,
  value,
  encoding = "utf8",
) {
  await writeFile(await artifactPath(framework, name), value, {
    encoding,
    mode: 0o600,
  });
}

export function assertNoBrowserErrors(errors) {
  assert.deepEqual(errors, [], `browser emitted errors:\n${errors.join("\n")}`);
}

export function assertMainResponse(status, headers) {
  assert.equal(status, 200);
  assert.match(headers["content-security-policy"] ?? "", /default-src 'none'/);
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(headers["cross-origin-resource-policy"], "same-origin");
  assert.match(headers["permissions-policy"] ?? "", /camera=\(\)/);
  assert.match(headers["set-cookie"] ?? "", /HttpOnly/i);
  assert.match(headers["set-cookie"] ?? "", /SameSite=Strict/i);
}

export async function assertInPageBoundaries(evaluate) {
  const result = await evaluate(async () => {
    const health = await fetch("/healthz", { cache: "no-store" });
    return {
      cookie: document.cookie,
      healthBody: await health.text(),
      healthStatus: health.status,
    };
  });
  if (result?.contractError) throw new Error(result.contractError);
  assert.deepEqual(result, {
    cookie: "",
    healthBody: "ok",
    healthStatus: 200,
  });
}
