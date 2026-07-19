// Credential-safe Fiducia endpoint normalization shared by the ordinary
// endpoint resolver and the strict three-cluster topology loader.

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/** Return a normalized origin after enforcing the deployment transport policy. */
export function validateEndpoint(
  value,
  allowInsecureLocalhost = process.env.FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST === "1",
) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid Fiducia E2E endpoint URL");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Fiducia E2E endpoints must not contain userinfo, path, query, or fragment data");
  }
  const local = isLoopbackHostname(url.hostname);
  const allowLocalHttp = local && allowInsecureLocalhost;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowLocalHttp)) {
    throw new Error(
      "Fiducia E2E endpoints require HTTPS; set FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST=1 only for a local harness",
    );
  }
  return url.origin;
}
