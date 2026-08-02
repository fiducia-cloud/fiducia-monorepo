import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

export const contractEnabled = process.env.E2E_BROWSER_CONTRACT === '1';

const html = `<!doctype html>
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

export async function startHarnessServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');

    if (url.pathname === '/') {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      );
      response.setHeader('Set-Cookie', 'e2e_session=contract; HttpOnly; SameSite=Strict; Path=/');
      response.end(html);
      return;
    }

    if (url.pathname === '/app.js') {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(script);
      return;
    }

    if (url.pathname === '/api/session') {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({
        cookieSeen: String(request.headers.cookie ?? '').includes('e2e_session=contract'),
        requestId: 'browser-harness-contract',
      }));
      return;
    }

    if (url.pathname === '/healthz') {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end('ok');
      return;
    }

    response.statusCode = 404;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end('not found');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object', 'harness server did not expose a TCP address');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export async function screenshotPath(framework) {
  const directory = path.join(process.cwd(), 'artifacts', framework);
  await mkdir(directory, { recursive: true });
  return path.join(directory, 'harness-contract.png');
}

export function assertNoBrowserErrors(errors) {
  assert.deepEqual(errors, [], `browser emitted errors:\n${errors.join('\n')}`);
}
