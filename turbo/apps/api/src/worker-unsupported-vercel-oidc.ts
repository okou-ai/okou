/**
 * Worker-build-only replacement for @vercel/oidc. Workers exchange the
 * GCP_MTLS client certificate instead; Vercel OIDC tokens exist only in a
 * Vercel request context, so the real SDK cannot return one here either.
 */
export function getVercelOidcTokenSync(): never {
  throw new Error(
    "Vercel OIDC tokens are unavailable on Cloudflare Workers. Authenticate to GCP through the GCP_MTLS binding, or route OIDC-dependent operations to the Node/Vercel API deployment.",
  );
}
