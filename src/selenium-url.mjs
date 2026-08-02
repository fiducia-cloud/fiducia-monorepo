// Pure Selenium endpoint contract. Kept separate from browser.mjs so invalid
// CI/tunnel configuration is testable without browser drivers or the composed
// Rust/Postgres stack.

/**
 * Normalize an HTTP(S) origin and reject URL features that make `/status` and
 * WebDriver routing ambiguous or could expose credentials.
 */
export function normalizeSeleniumOrigin(value, label = "Selenium Grid endpoint") {
  const raw = String(value ?? "").trim();
  if (!raw) throw new TypeError(`${label} is empty`);

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`${label} must be an absolute HTTP(S) origin`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`${label} must use http: or https:`);
  }
  if (url.username || url.password) {
    throw new TypeError(`${label} must not contain credentials`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError(`${label} must be an origin only (no path, query, or fragment)`);
  }
  return url.origin;
}

/** The validated Selenium Grid endpoint under test. */
export function seleniumRemoteUrl(
  value =
    process.env.FIDUCIA_E2E_SELENIUM_URL?.trim() ||
    process.env.SELENIUM_REMOTE_URL?.trim() ||
    "http://localhost:4444",
) {
  return normalizeSeleniumOrigin(value);
}
