// Pure URL contract for remote-browser routing. Kept separate from browser.mjs
// so the rules can be unit-tested without installing browser drivers or booting
// the heavyweight composed Rust/Postgres stack.

function publicBaseUrl(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch (error) {
    throw new TypeError(`FIDUCIA_E2E_PUBLIC_BASE_URL must be an absolute HTTP(S) origin: ${error.message}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("FIDUCIA_E2E_PUBLIC_BASE_URL must use http: or https:");
  }
  if (url.username || url.password) {
    throw new TypeError("FIDUCIA_E2E_PUBLIC_BASE_URL must not contain credentials");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("FIDUCIA_E2E_PUBLIC_BASE_URL must be an origin only (no path, query, or fragment)");
  }
  return url;
}

/**
 * Rewrite a stack-local HTTP(S) URL for a remote browser. The override may
 * replace protocol and hostname while the stack's allocated port remains
 * authoritative unless the override explicitly pins one.
 */
export function publicUrlFor(
  stackUrl,
  override = process.env.FIDUCIA_E2E_PUBLIC_BASE_URL,
) {
  const target = new URL(stackUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new TypeError("stackUrl must use http: or https:");
  }
  const publicBase = publicBaseUrl(override);
  if (!publicBase) return stackUrl;
  target.protocol = publicBase.protocol;
  target.hostname = publicBase.hostname;
  if (publicBase.port) target.port = publicBase.port;
  return target.toString();
}
